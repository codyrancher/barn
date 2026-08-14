<script>
// One terminal in Rancher's window manager drawer.
//
// The window manager owns the tab strip, the close buttons, the drag handle and keeping this
// alive across navigation. What is left for this component is the pane itself, which is the
// same DevTerminal the rest of the product uses, pointed at the dev server's pod with this
// tab's own tmux session.
//
// It is wrapped in the shell's own Window, which is what Rancher's container shell and logs
// use, so the strip along the bottom is in the place and the styling someone already expects
// per-tab controls to be in.
import Window from '@shell/components/Window/Window';
import { RcButton } from '@components/RcButton';
import DevTerminal from './DevTerminal.vue';
import { openTerminal } from '../terminals';

export default {
  name: 'DevTerminalTab',

  components: { Window, RcButton, DevTerminal },

  props: {
    // The window manager's own description of this tab.
    tab: {
      type:     Object,
      required: true,
    },

    // Whether the drawer is showing this tab rather than one of its siblings.
    active: {
      type:     Boolean,
      default:  false,
    },

    // Everything below arrives from the tab's attrs (see terminals.ts).
    session: {
      type:     String,
      required: true,
    },

    number: {
      type:     Number,
      required: true,
    },

    namespace: {
      type:     String,
      required: true,
    },

    labels: {
      type:     Object,
      required: true,
    },

    container: {
      type:     String,
      required: true,
    },
  },

  computed: {
    /**
     * What the exec runs: the pod's own tab entrypoint, with this terminal's session and a
     * directory of its own, which is what makes it a conversation of its own.
     */
    command() {
      return ['/bin/sh', '/seed/shell.sh', this.session, `/app/.sessions/${ this.session }`];
    },
  },

  methods: {
    /**
     * Add another terminal, from inside the drawer.
     *
     * The harness has a plus at the end of its tab strip. The window manager's strip is the
     * shell's and has no slot to put one in, so the nearest thing that is still one click from
     * the drawer is here, in the row Rancher already uses for a tab's own controls.
     */
    newTerminal() {
      openTerminal(this.$store);
    },
  },
};
</script>

<template>
  <Window :active="active">
    <template #title>
      <div class="dev-terminal-tab__bar">
        <span class="dev-terminal-tab__session">
          Terminal {{ number }}, session <code>{{ session }}</code> in the dev server's pod.
          Closing this tab leaves it running.
        </span>
        <RcButton
          variant="link"
          size="small"
          left-icon="plus"
          @click="newTerminal"
        >
          New terminal
        </RcButton>
      </div>
    </template>
    <template #body>
      <DevTerminal
        class="dev-terminal-tab__terminal"
        :namespace="namespace"
        :labels="labels"
        :container="container"
        :command="command"
      />
    </template>
  </Window>
</template>

<style lang="scss" scoped>
  .dev-terminal-tab {
    &__bar {
      display:     flex;
      align-items: center;
      gap:         10px;
      height:      100%;
    }

    &__session {
      color:     var(--muted);
      font-size: 12px;

      code {
        padding:     1px 4px;
        background:  transparent;
        font-family: monospace;
      }
    }

    &__terminal {
      height: 100%;
      // The drawer supplies the frame, so the pane inside it does not need a second one.
      border: none;
    }
  }
</style>
