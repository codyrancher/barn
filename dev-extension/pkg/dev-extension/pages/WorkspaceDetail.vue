<script>
// One workspace, opened: the same running thing seen four ways.
//
// The harness's shape, which is what this is a port of: a list of projects you switch between
// without leaving the one you have open, and a project that opens as a set of tabs with the
// URL naming both. Hence the rail down the left, and the tab in the address rather than in
// this component's state, since a tab that is not in the address cannot be linked to or
// shared.
//
// The tab is the hash, `#conversations`, and not a path segment the way the harness's
// `/:projectId/conversations` is. That is a deliberate divergence, and it is not a matter of
// taste:
//
//   - the shell renders its router-view with `:key="$route.path"` (components/templates/
//     default.vue), so a tab in the path is a different component instance, and every tab
//     click destroys and rebuilds this page;
//   - the apiserver does not reap an exec'd process when its WebSocket closes, so each of
//     those rebuilds leaves the previous tab's shell running in the workspace's pod. A tab bar
//     that accumulates processes in the thing it is a view of is not a tab bar.
//
// The hash keeps the property the layout actually needs, which is that a tab is addressable
// and therefore shareable, and it is what Rancher's own detail pages use. If someone later
// moves this to a path segment to match the harness exactly, both of the above come back.
//
// The page polls rather than waits for a websocket, for the same reason the list does: these
// are not resources in the Steve store, so nothing pushes a change here. The terminal does its
// own waiting for the pod (see components/DevTerminal.vue), so this page never has to hold
// anything back from it.
import Loading from '@shell/components/Loading';
import AsyncButton from '@shell/components/AsyncButton';
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import { Banner } from '@components/Banner';
import { BadgeState } from '@components/BadgeState';
import { RcButton } from '@components/RcButton';
import { colorForState, stateDisplay } from '@shell/plugins/dashboard-store/resource-class';
import DevTerminal from '../components/DevTerminal.vue';
import WorkspaceBrowser from '../components/WorkspaceBrowser.vue';
import WorkspacePorts from '../components/WorkspacePorts.vue';
import ConfirmDeleteWorkspace from '../components/ConfirmDeleteWorkspace.vue';
import {
  getWorkspace, listWorkspaces, setWorkspaceRunning, workspacePod, workspaceService,
  LABEL_WORKSPACE, WORKSPACE_CONTAINER, WORKSPACE_SHELL_COMMAND
} from '../api';
import { templateById } from '../templates';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE, WORKSPACE_ROUTE,
  WORKSPACE_TABS, DEFAULT_WORKSPACE_TAB
} from '../config/constants';

const REFRESH_MS = 5000;

export default {
  name: 'DevWorkspaceDetail',

  components: {
    Loading, AsyncButton, Tabbed, Tab, Banner, BadgeState, RcButton, DevTerminal, WorkspaceBrowser,
    WorkspacePorts, ConfirmDeleteWorkspace
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      workspace:    null,
      // Every workspace, for the rail. The same call the list page makes, so the rail cannot
      // come to disagree with the page it was reached from.
      workspaces:   [],
      pod:          '',
      service:      null,
      error:        '',
      busy:         false,
      // True once Delete has been pressed and the confirmation is up.
      confirming:   false,
      refreshTimer: null,
      // Which tabs have been opened. Tab content is mounted on first activation and left
      // mounted afterwards: Tabbed hides an inactive tab with v-show rather than unmounting
      // it, so a terminal survives a trip to another tab, but a tab nobody opened should not
      // have opened a shell in the pod or framed the workspace's server to begin with.
      seen:         {},
      listTo:       { name: WORKSPACES_ROUTE, params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER } },
    };
  },

  computed: {
    name() {
      return this.$route.params.workspace;
    },

    /**
     * The tab the address names, or the default when it names none or names one that is not
     * there. Read here as well as by Tabbed, because it decides which tab's content is mounted
     * on the way up, before Tabbed has said anything.
     */
    tab() {
      const tab = this.$route.hash.replace('#', '');

      return WORKSPACE_TABS.includes(tab) ? tab : DEFAULT_WORKSPACE_TAB;
    },

    // colorForState hands back a text- class and BadgeState wants a bg- one, which is the
    // same swap BadgeStateFormatter makes for the table.
    stateBackground() {
      return colorForState(this.workspace?.state).replace('text-', 'bg-');
    },

    stateLabel() {
      return stateDisplay(this.workspace?.state);
    },

    /**
     * What the Conversations tab actually is, from the template.
     *
     * The harness's Conversations tab is claude. Here it is whatever the template's image can
     * host, which today is a plain shell everywhere (see templates.ts), and the tab says which
     * rather than letting someone find out.
     */
    conversations() {
      return templateById(this.workspace?.template)?.conversations || 'shell';
    },

    // What the terminal is pointed at. The pod is found by the workspace's own label rather
    // than by name, since a stop and start replaces it.
    podLabels() {
      return { [LABEL_WORKSPACE]: this.name };
    },

    container() {
      return WORKSPACE_CONTAINER;
    },

    shellCommand() {
      return WORKSPACE_SHELL_COMMAND;
    },

    // The rows of the summary block. A list rather than markup so the template stays one
    // loop, and so adding a fact is adding a fact.
    //
    // Every value here is read back off the cluster rather than off the template the
    // workspace was made from. The template is what it was asked for; anything can edit the
    // Deployment afterwards, and a page that reports the request instead of the result is a
    // page that agrees with itself while the pod crash-loops on an image it never mentions.
    details() {
      if (!this.workspace) {
        return [];
      }

      return [
        { label: 'Template', value: this.workspace.templateLabel },
        { label: 'Image', value: this.workspace.image || 'Unknown' },
        { label: 'Namespace', value: this.workspace.namespace },
        { label: 'Deployment', value: this.workspace.namespace },
        { label: 'Service', value: this.service ? `${ this.service.name }:${ this.service.port }` : 'None' },
        { label: 'Pod', value: this.pod || 'None running' },
        { label: 'Replicas', value: `${ this.workspace.ready } / ${ this.workspace.replicas }` },
      ];
    },

    /**
     * The rail: every workspace, linked to the tab this one is open at.
     *
     * Carrying the tab across is what makes the rail a way of comparing two workspaces rather
     * than a way of starting again in another one.
     *
     * These are plain router-links rather than the shell's own nav entry component
     * (components/nav/Type), which was the obvious thing to reuse and cannot do this: its
     * active check compares the resolved link against the current address after stripping the
     * hash from one side only, so a link carrying `#conversations` never matches and no entry
     * ever highlights. Highlighting on the workspace name is both simpler and more correct
     * here, since a workspace is the current one whichever of its tabs is open.
     */
    railLinks() {
      return this.workspaces.map((workspace) => ({
        name:  workspace.name,
        color: colorForState(workspace.state),
        to:    {
          name:   WORKSPACE_ROUTE,
          params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER, workspace: workspace.name },
          hash:   `#${ this.tab }`,
        },
      }));
    },
  },

  mounted() {
    this.seen[this.tab] = true;
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
  },

  methods: {
    /**
     * A tab became the active one, whether by a click, by the address, or by Tabbed choosing
     * the default. Recorded so the tab's content is mounted from here on (see `seen`).
     *
     * The address is Tabbed's to keep, not this page's: with `use-hash` on it writes the hash
     * when a tab is selected and re-selects when the hash changes, which is the whole of the
     * addressability this page needs.
     */
    onTabChanged({ tab }) {
      this.seen[tab.name] = true;
    },

    async refresh() {
      this.workspace = await getWorkspace(this.name);

      // The rail is every workspace, including ones created since this page opened. Quietly,
      // because a rail that empties itself over one failed poll is worse than a stale rail.
      listWorkspaces().then((workspaces) => {
        this.workspaces = workspaces;
      }).catch(() => {});

      if (!this.workspace) {
        // Nothing left to poll for. The page is now a banner saying the workspace is gone,
        // and asking the cluster again every five seconds would only repeat the 404 that
        // proved it, in the console as well as on the wire.
        clearInterval(this.refreshTimer);

        return;
      }

      // Only ask for the pod when there could be one: a stopped workspace has none, and asking
      // anyway would put a request every five seconds behind a known answer.
      this.pod = this.workspace.replicas > 0 ? await workspacePod(this.name) || '' : '';
      this.service = await workspaceService(this.name);
    },

    async run(action, done) {
      this.error = '';
      this.busy = true;

      try {
        await action();
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      } finally {
        this.busy = false;
      }
    },

    start(done) {
      return this.run(() => setWorkspaceRunning(this.name, true), done);
    },

    stop(done) {
      return this.run(() => setWorkspaceRunning(this.name, false), done);
    },

    // Deleting from here leaves nothing to show, so the page goes back to the list rather
    // than refreshing into a "there is no workspace called ..." banner.
    onDeleted() {
      this.confirming = false;
      this.$router.push(this.listTo);
    },

    onDeleteError(message) {
      this.confirming = false;
      this.error = message;
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else-if="!workspace"
    class="dev-workspace"
  >
    <Banner
      color="warning"
      :label="`There is no workspace called ${ name }. It may have been deleted.`"
    />
    <RcButton
      variant="secondary"
      :to="listTo"
    >
      Back to workspaces
    </RcButton>
  </div>
  <div
    v-else
    class="dev-workspace"
  >
    <header>
      <div class="dev-workspace__title">
        <router-link :to="listTo">
          Workspaces
        </router-link>
        <span class="dev-workspace__separator">/</span>
        <h1>{{ workspace.name }}</h1>
        <BadgeState
          :color="stateBackground"
          :label="stateLabel"
        />
      </div>
      <div class="dev-workspace__actions">
        <AsyncButton
          v-if="workspace.state === 'stopped'"
          mode="apply"
          action-label="Start"
          waiting-label="Starting"
          success-label="Started"
          :disabled="busy"
          @click="start"
        />
        <AsyncButton
          v-else
          mode="apply"
          action-label="Stop"
          waiting-label="Stopping"
          success-label="Stopped"
          :disabled="busy || workspace.state === 'removing'"
          @click="stop"
        />
        <!--
          Secondary rather than a red primary: RcButton always applies its own variant class,
          so Rancher's `bg-error` utility cannot win against it, and fighting that with a
          hand-rolled button would trade one shell component for none. The red belongs on the
          confirmation's button anyway, which is where PromptRemove puts it.
        -->
        <RcButton
          variant="secondary"
          left-icon="trash"
          :disabled="busy || workspace.state === 'removing'"
          @click="confirming = true"
        >
          Delete
        </RcButton>
      </div>
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <div class="dev-workspace__body">
      <nav class="dev-workspace__rail">
        <h4>Workspaces</h4>
        <ul>
          <li
            v-for="link in railLinks"
            :key="link.name"
          >
            <router-link
              :to="link.to"
              :class="{ 'dev-workspace__rail-current': link.name === name }"
            >
              <i
                class="icon icon-dot"
                :class="link.color"
              />
              {{ link.name }}
            </router-link>
          </li>
        </ul>
      </nav>

      <Tabbed
        class="dev-workspace__tabs"
        :default-tab="tab"
        @changed="onTabChanged"
      >
        <Tab
          name="overview"
          label="Overview"
          :weight="4"
        >
          <dl class="dev-workspace__details">
            <template
              v-for="detail in details"
              :key="detail.label"
            >
              <dt>{{ detail.label }}</dt>
              <dd>{{ detail.value }}</dd>
            </template>
          </dl>
        </Tab>

        <Tab
          name="conversations"
          label="Conversations"
          :weight="3"
        >
          <div class="dev-workspace__pane">
            <p class="dev-workspace__note">
              <template v-if="conversations === 'claude'">
                A claude session in the workspace's pod, over the Kubernetes exec subresource.
              </template>
              <template v-else>
                A shell, not claude: this workspace's image cannot host the claude CLI, so the
                tab is honest about being a terminal. It reattaches on its own after a stop and
                start, since that replaces the pod.
              </template>
            </p>
            <DevTerminal
              v-if="seen.conversations"
              class="dev-workspace__terminal"
              :namespace="workspace.namespace"
              :labels="podLabels"
              :container="container"
              :command="shellCommand"
            />
          </div>
        </Tab>

        <Tab
          name="browser"
          label="Browser"
          :weight="2"
        >
          <WorkspaceBrowser
            v-if="seen.browser"
            :workspace="workspace"
            :service="service"
          />
        </Tab>

        <Tab
          name="ports"
          label="Ports"
          :weight="1"
        >
          <WorkspacePorts
            v-if="seen.ports"
            :workspace="workspace"
          />
        </Tab>
      </Tabbed>
    </div>

    <ConfirmDeleteWorkspace
      v-if="confirming"
      :workspace="workspace"
      @close="confirming = false"
      @deleted="onDeleted"
      @error="onDeleteError"
    />
  </div>
</template>

<style lang="scss" scoped>
  .dev-workspace {
    display:        flex;
    flex-direction: column;
    // Fill the page so the terminal has a height to grow into; without it the terminal
    // collapses to nothing and xterm renders a single row.
    min-height:     calc(100vh - 150px);

    header {
      display:       flex;
      align-items:   center;
      gap:           20px;
      margin-bottom: 20px;
    }

    &__title {
      display:     flex;
      align-items: center;
      gap:         10px;

      h1 {
        margin-bottom: 0;
      }
    }

    &__separator {
      color: var(--muted);
    }

    &__actions {
      display:     flex;
      gap:         10px;
      margin-left: auto;
    }

    &__body {
      display:  flex;
      flex:     1 1 auto;
      gap:      20px;
      // Without this the tabs cannot be narrower than their content, and a wide terminal
      // pushes the rail off the page instead of scrolling inside its own pane.
      min-width: 0;
    }

    &__rail {
      flex:         0 0 200px;
      padding-top:  4px;
      border-right: 1px solid var(--border);

      h4 {
        margin-bottom: 8px;
        color:         var(--muted);
      }

      ul {
        margin:     0;
        padding:    0;
        list-style: none;
      }

      // The side nav's own hover and active colours, since this is the same idea one level in.
      a {
        display:       block;
        padding:       6px 10px;
        border-radius: var(--border-radius);
        color:         var(--body-text);

        &:hover {
          background:      var(--nav-hover, var(--accent-btn));
          text-decoration: none;
        }
      }

      .icon-dot {
        margin-right: 6px;
        font-size:    10px;
      }

      &-current {
        background: var(--nav-active, var(--accent-btn));
      }
    }

    &__tabs {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      // Both, and neither is redundant: Tabbed's own class sets `min-width: fit-content`, so
      // without the max the tab bar grows to whatever the widest pane wants and takes the page
      // with it.
      min-width:      0;
      max-width:      100%;

      // The tab content is what has to grow, since the terminal inside it is sized from its
      // container rather than from a row count.
      :deep(.tab-container) {
        display:        flex;
        flex-direction: column;
        flex:           1 1 auto;
        min-height:     420px;

        > section {
          display:        flex;
          flex-direction: column;
          flex:           1 1 auto;
          min-height:     0;
        }
      }
    }

    &__pane {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-height:     0;
    }

    &__note {
      max-width:     80ch;
      margin-bottom: 10px;
      color:         var(--muted);
    }

    &__details {
      display:               grid;
      grid-template-columns: max-content 1fr;
      gap:                   6px 20px;
      align-content:         start;

      dt {
        color: var(--muted);
      }

      dd {
        margin:      0;
        font-family: monospace;
      }
    }

    &__terminal {
      flex:       1 1 auto;
      min-height: 320px;
    }
  }
</style>
