<script>
// A workspace's conversations: a list down the left, the open one filling the rest.
//
// The harness gives a project many conversations rather than one terminal, with New
// conversation at the foot of the list, and this is that. A conversation is a shell in the
// workspace's pod, numbered by the same function the drawer's terminals are numbered with, so
// the two cannot come to disagree about what the numbers mean.
//
// Every conversation that has been opened stays mounted, hidden rather than destroyed, which
// is what makes switching between them keep both alive. That matters more here than in the
// drawer: the workspace images have no tmux in them, so a conversation exists only as long as
// its socket does. The panes say so rather than implying a persistence they do not have.
import { RcButton } from '@components/RcButton';
import { Banner } from '@components/Banner';
import DevTerminal from './DevTerminal.vue';
import { nextNumber } from '../terminals';
import { LABEL_WORKSPACE, WORKSPACE_CONTAINER, WORKSPACE_SHELL_COMMAND } from '../api';

export default {
  name: 'WorkspaceConversations',

  components: {
    RcButton, Banner, DevTerminal
  },

  emits: ['start'],

  props: {
    workspace: {
      type:     Object,
      required: true,
    },

    // What the pane lands in, from the template: 'claude' or 'shell'. Only the wording depends
    // on it, since nothing installs the claude CLI in a workspace yet.
    kind: {
      type:    String,
      default: 'shell',
    },

    // The last line the container printed, while it is still coming up. The page fetches it,
    // because it is the only honest answer to "what is it doing" during a five minute boot.
    logTail: {
      type:    String,
      default: '',
    },

    busy: {
      type:    Boolean,
      default: false,
    },
  },

  data() {
    return {
      // The numbers that have been opened, in order, and which one is showing.
      conversations: [1],
      current:       1,
      // number -> the pane's own connection state, for the dot on its row.
      states:        {},
    };
  },

  computed: {
    /**
     * Whether there is anything to talk to yet.
     *
     * Conversations is the first tab and the default, so it is the tab that has to explain a
     * workspace which is not ready: cloning, installing, compiling, crash-looping, or stopped.
     * Showing a terminal that will never connect would be the same page saying nothing.
     */
    ready() {
      return this.workspace.state === 'running' || this.workspace.state === 'starting';
    },

    stopped() {
      return this.workspace.state === 'stopped';
    },

    failing() {
      return this.workspace.state === 'error';
    },

    /** What the pod itself says it is doing, with the log line under it when there is one. */
    progress() {
      return this.workspace.detail || 'Starting';
    },

    podLabels() {
      return { [LABEL_WORKSPACE]: this.workspace.name };
    },

    container() {
      return WORKSPACE_CONTAINER;
    },

    command() {
      return WORKSPACE_SHELL_COMMAND;
    },

    rows() {
      return this.conversations.map((number) => ({
        number,
        label: `chat-${ number }`,
        // Only a pane with its socket open is live. Anything else (waiting for the pod,
        // connecting, closed) is not, and the dot says so rather than being decoration.
        live:  this.states[number] === 'open',
      }));
    },
  },

  methods: {
    /** The next number, from the same function the drawer's terminals are numbered with. */
    newConversation() {
      const number = nextNumber(this.conversations);

      this.conversations = [...this.conversations, number];
      this.current = number;
    },

    onState(number, state) {
      this.states = { ...this.states, [number]: state };
    },
  },
};
</script>

<template>
  <div class="workspace-conversations">
    <nav class="workspace-conversations__list">
      <ul>
        <li
          v-for="row in rows"
          :key="row.number"
        >
          <button
            type="button"
            :class="{ 'workspace-conversations__current': row.number === current }"
            @click="current = row.number"
          >
            <i
              class="icon icon-dot"
              :class="row.live ? 'text-success' : 'text-muted'"
            />
            {{ row.label }}
          </button>
        </li>
      </ul>
      <!--
        Pinned to the foot of the list, where the harness puts it, so it stays put as the list
        grows rather than walking down the column.
      -->
      <RcButton
        variant="secondary"
        left-icon="plus"
        @click="newConversation"
      >
        New conversation
      </RcButton>
    </nav>

    <div class="workspace-conversations__pane">
      <Banner
        v-if="stopped"
        color="info"
      >
        <div class="workspace-conversations__stopped">
          <span>This workspace is stopped, so there is nothing to talk to.</span>
          <RcButton
            variant="secondary"
            size="small"
            :disabled="busy"
            @click="$emit('start')"
          >
            Start it
          </RcButton>
        </div>
      </Banner>

      <Banner
        v-else-if="failing"
        color="error"
      >
        <p>This workspace is not staying up: {{ progress }}.</p>
        <p
          v-if="logTail"
          class="workspace-conversations__log"
        >
          {{ logTail }}
        </p>
      </Banner>

      <Banner
        v-else-if="!ready"
        color="info"
      >
        <p>{{ progress }}. A workspace that clones a repository and installs it takes a few minutes on its first start.</p>
        <p
          v-if="logTail"
          class="workspace-conversations__log"
        >
          {{ logTail }}
        </p>
      </Banner>

      <p
        v-if="ready"
        class="workspace-conversations__note"
      >
        <template v-if="kind === 'claude'">
          A claude session in the workspace's pod, over the Kubernetes exec subresource.
        </template>
        <template v-else>
          A shell, not claude: nothing installs the claude CLI into a workspace yet, so the tab
          says what it is rather than what it is meant to be. Each conversation is its own
          shell, and lasts as long as this page is open, since there is no tmux in the image to
          leave it running.
        </template>
      </p>
      <DevTerminal
        v-for="row in (ready ? rows : [])"
        v-show="row.number === current"
        :key="row.number"
        class="workspace-conversations__terminal"
        :namespace="workspace.namespace"
        :labels="podLabels"
        :container="container"
        :command="command"
        @state="onState(row.number, $event)"
      />
    </div>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-conversations {
    display:    flex;
    flex:       1 1 auto;
    gap:        20px;
    min-height: 0;

    &__list {
      display:        flex;
      flex-direction: column;
      flex:           0 0 180px;
      border-right:   1px solid var(--border);
      padding-right:  10px;

      ul {
        flex:       1 1 auto;
        margin:     0 0 10px 0;
        padding:    0;
        list-style: none;
      }

      button {
        display:       block;
        width:         100%;
        padding:       6px 10px;
        border:        none;
        border-radius: var(--border-radius);
        background:    transparent;
        color:         var(--body-text);
        text-align:    left;
        cursor:        pointer;

        &:hover {
          background: var(--nav-hover, var(--accent-btn));
        }
      }

      .icon-dot {
        margin-right: 6px;
        font-size:    10px;
      }
    }

    &__current {
      background: var(--nav-active, var(--accent-btn));
    }

    &__pane {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-width:      0;
    }

    &__note {
      max-width:     80ch;
      margin-bottom: 10px;
      color:         var(--muted);
    }

    &__stopped {
      display:     flex;
      align-items: center;
      gap:         10px;
    }

    // The container's own last line. Monospace because it is output, and truncated to one line
    // because this is a status, not a log viewer: the terminal is the log viewer.
    &__log {
      overflow:      hidden;
      margin:        6px 0 0 0;
      font-family:   monospace;
      font-size:     12px;
      white-space:   nowrap;
      text-overflow: ellipsis;
    }

    &__terminal {
      flex:       1 1 auto;
      min-height: 320px;
    }
  }
</style>
