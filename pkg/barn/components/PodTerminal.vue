<script>
// A terminal onto the DevExtension pod, modelled on the Claude Harness's.
//
// The harness runs a node-pty per browser socket, and that pty's command is
// `tmux new-session -A` running claude in a loop. There is no server to run one
// here, so the pty comes from Kubernetes instead: the exec subresource gives a
// real TTY in the pod, through Rancher's cluster proxy, authenticated by the
// session cookie the page already has. Everything on the far side of it is the
// same idea, and lives in seed/pod/: tmux for a session that outlives
// the browser tab, and claude looping inside it.
//
// The protocol is `base64.channel.k8s.io`, which is what the dashboard's own
// container shell speaks: each frame is a channel digit followed by base64.
// Channel 0 is stdin, 1 stdout, 2 stderr, 3 error, and 4 carries a JSON
// {Width, Height} on resize.
import { allHash } from '@shell/utils/promise';
import { base64Decode, base64Encode } from '@shell/utils/crypto';
import Socket, {
  EVENT_CONNECTED,
  EVENT_CONNECTING,
  EVENT_DISCONNECTED,
  EVENT_MESSAGE,
  EVENT_CONNECT_ERROR,
} from '@shell/utils/socket';
import {
  ensureExtension, extensionPod, extensionShellUrl, DEFAULT_EXTENSION
} from '../extensions';

// The dashboard's own build pulls this in globally; an extension's does not, so
// without it a built extension renders the terminal unstyled.
import 'xterm/css/xterm.css';

// Channel prefixes, as above.
const STDIN = '0';
const STDOUT = '1';
const STDERR = '2';
const ERROR = '3';
const RESIZE = '4';

// How often to look for a running pod while there isn't one. A cold pod is
// pulling an image and installing, so this is a wait of a minute or two.
const POD_POLL_MS = 3000;

export default {
  name: 'PodTerminal',

  props: {
    // Which tmux session to attach to. One pane, one session; it is a prop so a
    // second pane would be a second conversation rather than a fight over one.
    session: {
      type:    String,
      default: 'editor',
    },

    // Which extension's pod to open the session in. There can be several, and a
    // terminal that always went to the same one would be a terminal in the wrong
    // pod as soon as you were editing anything else.
    extension: {
      type:    String,
      default: DEFAULT_EXTENSION,
    },
  },

  data() {
    return {
      // 'waiting' (no pod yet) | 'connecting' | 'open' | 'closed'
      state:        'waiting',
      error:        '',
      terminal:     null,
      fitAddon:     null,
      socket:       null,
      // Input typed before the socket opened, replayed on connect.
      backlog:      [],
      resizeObserver: null,
      podPollTimer: null,
      unmounted:    false,
    };
  },

  computed: {
    statusText() {
      return {
        waiting:    'Waiting for the dev server pod',
        connecting: 'Connecting',
        closed:     'Disconnected',
      }[this.state] || '';
    },
  },

  async mounted() {
    await this.setupTerminal();
    this.connectWhenPodIsUp();
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.podPollTimer);
    this.resizeObserver?.disconnect();
    // Only this end goes away. The tmux session in the pod keeps running, which
    // is the whole point of it: reopening the editor reattaches to it.
    this.socket?.disconnect();
    this.terminal?.dispose();
  },

  methods: {
    async setupTerminal() {
      const style = getComputedStyle(document.body);
      const color = (name) => style.getPropertyValue(name).trim() || undefined;

      const xterm = await import(/* webpackChunkName: "xterm" */ 'xterm');
      const addons = await allHash({
        fit:    import(/* webpackChunkName: "xterm" */ 'xterm-addon-fit'),
        canvas: import(/* webpackChunkName: "xterm" */ 'xterm-addon-canvas'),
      });

      const terminal = new xterm.Terminal({
        allowProposedApi: true,
        cursorBlink:      true,
        fontSize:         13,
        // Harness Terminal is bundled with the extension (assets/fonts). The
        // rest of the list is what a browser has anyway, for the moment before
        // the webfont loads and for the case where it failed to.
        fontFamily:       '"Harness Terminal", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        // Rancher's own terminal colours, so this matches the dashboard's theme
        // and follows it between light and dark.
        theme:            {
          background:          color('--terminal-bg'),
          foreground:          color('--terminal-text'),
          cursor:              color('--terminal-cursor'),
          selectionBackground: color('--terminal-selection'),
        },
      });

      this.fitAddon = new addons.fit.FitAddon();
      terminal.loadAddon(this.fitAddon);
      // Canvas rather than webgl: this pane sits next to an iframe running a
      // whole second dashboard, and webgl contexts are a limited resource.
      terminal.loadAddon(new addons.canvas.CanvasAddon());

      // tmux emits the selection as OSC 52 when a drag ends (see pod/tmux.conf),
      // which is what makes drag-select copy to the browser clipboard. Without
      // a handler the sequence is silently dropped.
      terminal.parser.registerOscHandler(52, (payload) => {
        const encoded = payload.split(';')[1];

        try {
          navigator.clipboard?.writeText(base64Decode(encoded));
        } catch { /* clipboard permission, or a payload that isn't base64 */ }

        return true;
      });

      terminal.open(this.$refs.xterm);
      terminal.onData((input) => this.send(STDIN + base64Encode(input)));

      this.terminal = terminal;

      // The pane is resizable (the editor's divider) and the window is too, so
      // the size is watched rather than taken once.
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.$refs.xterm);
      this.fit();
    },

    // Wait for a pod, then connect. A cold pod is created by the extension
    // itself when it loads, so this is a wait rather than an error.
    async connectWhenPodIsUp() {
      ensureExtension(this.extension);

      // Whatever went wrong last time is over: this is a fresh wait, and the
      // error belongs to the connection that ended. Left in place, the exec
      // subresource's parting shot when a pod is killed ("exit code 137") would
      // sit there as the status forever, because the overlay shows the error in
      // preference to the state and nothing else clears it until a socket
      // opens, which cannot happen while there is no pod.
      this.error = '';

      while (!this.unmounted) {
        const pod = await extensionPod(this.extension);

        if (pod) {
          this.connect(pod);

          return;
        }

        this.state = 'waiting';
        await new Promise((resolve) => {
          this.podPollTimer = setTimeout(resolve, POD_POLL_MS);
        });
      }
    },

    connect(pod) {
      const socket = new Socket(extensionShellUrl(pod, this.session), false, 0, 'base64.channel.k8s.io');

      socket.addEventListener(EVENT_CONNECTING, () => {
        this.state = 'connecting';
        this.error = '';
      });

      socket.addEventListener(EVENT_CONNECTED, () => {
        this.state = 'open';
        this.fit();
        this.flush();
        this.terminal?.focus();
      });

      socket.addEventListener(EVENT_CONNECT_ERROR, () => {
        this.state = 'closed';
        this.error = 'Could not open a shell in the pod';
      });

      socket.addEventListener(EVENT_DISCONNECTED, () => {
        this.state = 'closed';
      });

      socket.addEventListener(EVENT_MESSAGE, (event) => {
        const data = event.detail.data;
        const channel = data.substr(0, 1);
        const message = base64Decode(data.substr(1));

        // stdout and stderr are both the pane; there is one TTY behind them.
        if (channel === STDOUT || channel === STDERR) {
          this.terminal?.write(message);

          return;
        }

        if (channel === ERROR && message) {
          // Not output: a Status object saying how the exec ended. Printing it
          // would put `{"status":"Success"}` on screen every time a shell exits
          // normally, so only a failure is worth surfacing, and as a status
          // rather than as terminal output.
          try {
            const status = JSON.parse(message);

            if (status.status !== 'Success') {
              this.error = status.message || 'The shell exited with an error';
            }
          } catch {
            this.error = message;
          }
        }
      });

      this.socket = socket;
      socket.connect();
    },

    // Reconnecting is reattaching: tmux still has the session, so this picks up
    // where it left off rather than starting anything.
    async reconnect() {
      await this.socket?.disconnect();
      this.socket = null;
      this.terminal?.reset();
      this.connectWhenPodIsUp();
    },

    send(frame) {
      if (this.state === 'open') {
        this.socket.send(frame);
      } else {
        this.backlog.push(frame);
      }
    },

    flush() {
      const backlog = this.backlog;

      this.backlog = [];
      backlog.forEach((frame) => this.socket.send(frame));
    },

    fit() {
      if (!this.fitAddon || !this.$refs.xterm?.clientWidth) {
        return;
      }

      this.fitAddon.fit();

      if (this.state !== 'open') {
        return;
      }

      const { cols, rows } = this.fitAddon.proposeDimensions() || {};

      if (cols && rows) {
        this.send(RESIZE + base64Encode(JSON.stringify({ Width: Math.floor(cols), Height: Math.floor(rows) })));
      }
    },
  },
};
</script>

<template>
  <div class="mc-terminal">
    <div
      ref="xterm"
      class="mc-terminal__xterm"
    />
    <div
      v-if="state !== 'open'"
      class="mc-terminal__status"
    >
      <span>{{ error || statusText }}</span>
      <button
        v-if="state === 'closed'"
        type="button"
        class="mc-terminal__retry"
        @click="reconnect"
      >
        Reconnect
      </button>
    </div>
  </div>
</template>

<style lang="scss">
// Not scoped: @font-face is document-level, and the font has to be declared
// before xterm measures a character or it measures the fallback.
//
// Inlined into the bundle rather than emitted as a file - see the fonts rule in
// pkg/barn/vue.config.js for why that matters for an extension.
@font-face {
  font-family: "Harness Terminal";
  font-style: normal;
  font-weight: 400;
  font-display: block;
  src: url("../assets/fonts/harness-terminal-400.woff2") format("woff2");
}

@font-face {
  font-family: "Harness Terminal";
  font-style: normal;
  font-weight: 700;
  font-display: block;
  src: url("../assets/fonts/harness-terminal-700.woff2") format("woff2");
}
</style>

<style lang="scss" scoped>
.mc-terminal {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  padding: 4px 0 0 6px;
  background: var(--terminal-bg, var(--body-bg));

  &__xterm {
    flex: 1 1 auto;
    min-height: 0;
    // A stacking context of its own, so xterm's canvas layers are ordered
    // inside it rather than against their neighbours. They carry z-index up to
    // 3, and nothing between them and this pane used to establish a context, so
    // they beat the status overlay below on the only comparison that decides a
    // click. Containing them here means the two siblings are ordered by their
    // own z-index and xterm's internal count stops being this component's
    // business.
    position: relative;
    z-index: 0;
  }

  &__status {
    position: absolute;
    // Above xterm's canvas layers, which are positioned too. Without this the
    // overlay draws on top but the canvas still wins the hit test, so the
    // Reconnect button below cannot be clicked and a disconnected pane is dead
    // until the page is reloaded.
    z-index: 1;
    right: 10px;
    bottom: 8px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--body-bg);
    color: var(--muted);
    font-size: 12px;
  }

  &__retry {
    padding: 0;
    border: none;
    background: none;
    color: var(--link);
    cursor: pointer;
  }
}
</style>
