<script>
// One workspace, opened: the same running thing seen three ways, and nothing above them.
//
// There is no masthead. The workspace's name and state are on the sidebar row you opened it
// from, which is on screen from every page rather than only this one, so repeating them here
// would cost the panes a strip of height to say something already said. What is left of the
// page's chrome is the tab strip, with Start and Stop at its right-hand end, because those are
// the two things worth doing from any tab. Delete is on the sidebar row and on the Workspaces
// list, both of which ask first, which is enough places for it.
//
// The tab is the hash, `#conversations`, and not a path segment the way the harness's
// `/:projectId/conversations` is. That is a deliberate divergence, and it is not a matter of
// taste:
//
//   - the shell renders its router-view with `:key="$route.path"` (components/templates/
//     blank.vue), so a tab in the path is a different component instance, and every tab click
//     destroys and rebuilds this page;
//   - the apiserver does not reap an exec'd process when its WebSocket closes, so each of those
//     rebuilds leaves the previous tab's shell running in the workspace's pod. A tab bar that
//     accumulates processes in the thing it is a view of is not a tab bar.
//
// The hash keeps the property the layout actually needs, which is that a tab is addressable and
// therefore shareable, and it is what Rancher's own detail pages use.
import Loading from '@shell/components/Loading';
import AsyncButton from '@shell/components/AsyncButton';
import Tabbed from '@shell/components/Tabbed';
import Tab from '@shell/components/Tabbed/Tab';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import WorkspaceConversations from '../components/WorkspaceConversations.vue';
import WorkspaceBrowser from '../components/WorkspaceBrowser.vue';
import WorkspacePorts from '../components/WorkspacePorts.vue';
import WorkspaceSidecars from '../components/WorkspaceSidecars.vue';
import {
  getWorkspace, listWorkspaces, setWorkspaceRunning, workspacePod, workspaceService,
  workspaceLogTail
} from '../api';
import { templateById } from '../templates';
import {
  DEV_PRODUCT, BLANK_CLUSTER, WORKSPACES_ROUTE, WORKSPACE_TABS, DEFAULT_WORKSPACE_TAB
} from '../config/constants';

const REFRESH_MS = 5000;

export default {
  name: 'DevWorkspaceDetail',

  components: {
    Loading, AsyncButton, Tabbed, Tab, Banner, RcButton,
    WorkspaceConversations, WorkspaceBrowser, WorkspacePorts, WorkspaceSidecars
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      workspace:    null,
      pod:          '',
      service:      null,
      // The last line the container printed, while it is still starting. See refresh.
      logTail:      '',
      error:        '',
      busy:         false,
      refreshTimer: null,
      // Which tabs have been opened. Tab content is mounted on first activation and left
      // mounted afterwards: Tabbed hides an inactive tab with v-show rather than unmounting it,
      // so a terminal survives a trip to another tab, but a tab nobody opened should not have
      // opened a shell in the pod or framed the workspace's server to begin with.
      seen:         {},
      /** The tab Tabbed is actually showing, which is what an unusable hash is corrected to. */
      active:       DEFAULT_WORKSPACE_TAB,
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

    /**
     * What the Conversations tab actually is, from the template.
     *
     * The harness's Conversations tab is claude. Here it is whatever the template's image can
     * host, and the tab says which rather than letting someone find out.
     */
    conversations() {
      return templateById(this.workspace?.template)?.conversations || 'shell';
    },

    /** True while there is no pod to frame or talk to, which is what the tabs have to say. */
    starting() {
      return !!this.workspace && this.workspace.state !== 'running' && this.workspace.state !== 'stopped';
    },

    stopped() {
      return this.workspace?.state === 'stopped';
    },

    /**
     * Tabs that cannot do anything yet, dimmed rather than hidden.
     *
     * A tab that disappears while a workspace boots is a layout that moves under the pointer;
     * a tab that is there and quiet says the same thing without it. Conversations is never in
     * here, because it is the tab that explains what the workspace is doing instead.
     */
    unavailable() {
      return (this.starting || this.stopped) ? ['browser', 'ports'] : [];
    },
  },

  watch: {
    /**
     * Keep the address describing the tab that is actually showing.
     *
     * Tabbed's `select()` returns without doing anything when the hash names a tab it does not
     * have, so editing `#sidecars` to `#overview` in the address bar leaves Sidecars on screen
     * with `#overview` in the URL, and copying that address shares the wrong tab. A cold load is
     * already right, because Tabbed replaces the hash itself when it falls back to the default;
     * this is the same correction for the case where the document does not reload.
     */
    '$route.hash'(hash) {
      const wanted = hash.replace('#', '');

      if (wanted && !WORKSPACE_TABS.includes(wanted)) {
        this.$router.replace({ ...this.$route, hash: `#${ this.active }` });
      }
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
    /** A tab became the active one. Recorded so its content is mounted from here on. */
    onTabChanged({ tab }) {
      this.seen[tab.name] = true;
      this.active = tab.name;
    },

    async refresh() {
      this.workspace = await getWorkspace(this.name);

      if (!this.workspace) {
        // Nothing left to poll for. The page is now a banner saying the workspace is gone, and
        // asking again every five seconds would only repeat the 404 that proved it.
        clearInterval(this.refreshTimer);

        return;
      }

      // The sidebar is the workspace list, and this page is where someone watching one would
      // notice a change, so its poll keeps that list fresh too.
      listWorkspaces().catch(() => {});

      // Only ask for the pod when there could be one: a stopped workspace has none.
      this.pod = this.workspace.replicas > 0 ? await workspacePod(this.name) || '' : '';
      this.service = await workspaceService(this.name);

      // The log's last line, only while the workspace is still coming up. It is the difference
      // between "Starting up" and knowing it is four minutes into an install, and once the
      // workspace is running it is the terminal's job rather than this page's.
      this.logTail = this.starting && this.pod ? await workspaceLogTail(this.name, this.pod) : '';
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

    /** From the Conversations tab, which offers to start a workspace that is stopped. */
    startFromTab() {
      return this.run(() => setWorkspaceRunning(this.name, true), () => {});
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else-if="!workspace"
    class="dev-workspace dev-workspace--message"
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
    :class="unavailable.map((tab) => `dev-workspace--no-${ tab }`)"
  >
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <Tabbed
      class="dev-workspace__tabs"
      :default-tab="tab"
      @changed="onTabChanged"
    >
      <!--
        The only chrome the page has left. Start and Stop are on the tab strip's own row, so
        they are reachable from every tab and cost no height.
      -->
      <template #tab-row-extras>
        <div class="dev-workspace__actions">
          <AsyncButton
            v-if="stopped"
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
        </div>
      </template>

      <Tab
        name="conversations"
        label="Conversations"
        :weight="3"
      >
        <WorkspaceConversations
          v-if="seen.conversations"
          :workspace="workspace"
          :kind="conversations"
          :log-tail="logTail"
          :busy="busy"
          @start="startFromTab"
        />
      </Tab>

      <!--
        The external-link mark, the way the harness marks the tabs that open elsewhere. What
        Browser frames is served on Rancher's origin rather than by this dashboard, and the
        tab's own Open takes you out to it.
      -->
      <Tab
        name="browser"
        label="Browser"
        label-icon="icon-external-link"
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

      <Tab
        name="sidecars"
        label="Sidecars"
        :weight="0"
      >
        <WorkspaceSidecars
          v-if="seen.sidecars"
          :workspace="workspace"
        />
      </Tab>
    </Tabbed>
  </div>
</template>

<style lang="scss" scoped>
  .dev-workspace {
    display:        flex;
    flex-direction: column;
    // The page is the whole area now that nothing sits above the tabs, and the panes inside it
    // are a terminal and an iframe, both of which size themselves from their container.
    height:         100%;
    min-height:     0;

    &--message {
      padding: 20px;
    }

    &__actions {
      display:     flex;
      align-items: center;
      gap:         10px;
      // Tabbed lays its strip out as a row, so this sits at the far end of it.
      margin-left: auto;
      padding:     0 10px;
    }

    &__tabs {
      display:        flex;
      flex-direction: column;
      flex:           1 1 auto;
      min-height:     0;
      // Tabbed's own class sets `min-width: fit-content`, so without the max the strip grows to
      // whatever the widest pane wants and takes the page with it.
      max-width:      100%;

      // The tab strip is the top edge of the page, so it keeps the shell's border between it
      // and the content but not the outer frame it would have inside a card.
      :deep(> .tabs) {
        border-top:  0;
        border-left: 0;
        border-right: 0;
      }

      // The content is everything below the strip. No padding of its own: a terminal and an
      // iframe are the two things on it, and both want the whole area.
      :deep(> .tab-container) {
        display:        flex;
        flex-direction: column;
        flex:           1 1 auto;
        min-height:     0;
        padding:        0;
        border:         0;

        > section {
          display:        flex;
          flex-direction: column;
          flex:           1 1 auto;
          min-height:     0;
        }
      }
    }

    // A tab that cannot do anything yet: quiet, still there, still clickable, because what it
    // shows when you click it is the explanation of why it is quiet.
    //
    // The id is where Tabbed puts the tab's name: the `li` carries `:id="tab.name"` and it is
    // the `a` inside it that carries `aria-controls`, so a selector written against the li's
    // aria-controls matches nothing and dims nothing.
    &--no-browser :deep(li.tab#browser),
    &--no-ports :deep(li.tab#ports) {
      opacity: 0.45;
    }
  }
</style>
