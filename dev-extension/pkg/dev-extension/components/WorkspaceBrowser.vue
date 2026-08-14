<script>
// What the workspace serves, framed on Rancher's own origin.
//
// The harness gives every project a Browser tab onto the dev server it runs. There is no port
// to publish here and nothing to forward: the Kubernetes apiserver's service proxy already
// puts every Service port on Rancher's origin, behind the same session the page is using, and
// that is the URL this frames. The editor in the magic-closet extension frames its dev server
// the same way.
//
// The whole of the work here is the waiting. A workspace can be Running with nothing listening
// yet, and the proxy answers that with a 503 carrying a Kubernetes Status, so a component that
// framed the URL and hoped would be showing an apiserver error page where the person expects
// their app.
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { workspaceProxyUrl, workspaceServing, workspaceOriginUrl } from '../api';
import { templateById } from '../templates';

// How often to look again while nothing is answering. The same beat as the terminal's wait for
// a pod, for the same reason: a workspace that was just started is measured in seconds.
const POLL_MS = 3000;

export default {
  name: 'WorkspaceBrowser',

  components: { Banner, RcButton },

  props: {
    workspace: {
      type:     Object,
      required: true,
    },

    // The Service as it exists, not as the template described it. Null when the workspace has
    // none, which is a create that got part way and is worth saying out loud.
    service: {
      type:    Object,
      default: null,
    },
  },

  data() {
    return {
      // 'checking' | 'serving' | 'waiting'
      status:    'checking',
      pollTimer: null,
      unmounted: false,
      // Bumped to rebuild the iframe, which is how a reload is done from out here: an iframe
      // on another origin's path cannot be told to reload, and reassigning the same src does
      // nothing.
      reloads:   0,
    };
  },

  computed: {
    port() {
      return this.service?.port;
    },

    /** http or https, from the template: the proxy takes the scheme as part of its path. */
    scheme() {
      return templateById(this.workspace.template)?.scheme || 'http';
    },

    template() {
      return templateById(this.workspace.template);
    },

    /**
     * Whether this workspace is served at an origin of its own rather than through the proxy.
     *
     * When it is, there is nothing to frame: the page is on http at a node port, and an https
     * page cannot frame an http one. That is the same shape the harness has, where Browser
     * carries an external-link mark and opens elsewhere rather than rendering in place.
     */
    ownOrigin() {
      return !!this.template?.ownOrigin;
    },

    /** Where the proxy serves it. Still the address the serving check uses, in both modes. */
    proxyUrl() {
      return this.port ? workspaceProxyUrl(this.workspace.name, this.port, this.scheme) : '';
    },

    /** The address to open, which is the node port when the template asked for its own origin. */
    url() {
      return this.ownOrigin ? workspaceOriginUrl(this.service) : this.proxyUrl;
    },

    /** Why there is nothing to show, or '' when there is. */
    blocked() {
      if (!this.service) {
        return 'This workspace has no Service, so there is no port to reach it on.';
      }

      if (this.workspace.state === 'stopped') {
        return 'This workspace is stopped. Start it to see what it serves.';
      }

      if (this.ownOrigin && !this.service.nodePort) {
        return 'This workspace was made before its template asked for an origin of its own. Stop it and start it again to publish its port.';
      }

      return '';
    },
  },

  watch: {
    // Starting a stopped workspace, or a Service that appears late, both arrive here as a prop
    // change rather than as a mount.
    blocked() {
      this.check();
    },
  },

  mounted() {
    this.check();
  },

  beforeUnmount() {
    this.unmounted = true;
    clearTimeout(this.pollTimer);
  },

  methods: {
    async check() {
      clearTimeout(this.pollTimer);

      if (this.blocked) {
        this.status = 'checking';

        return;
      }

      // Always through the proxy, in both modes. A workspace on its own origin is on http, and
      // an https page cannot fetch it to ask whether it is up; the proxy answers the same
      // question about the same pod, and a 503 from it is the thing worth waiting through.
      const serving = await workspaceServing(this.workspace.name, this.port, this.scheme);

      if (this.unmounted) {
        return;
      }

      this.status = serving ? 'serving' : 'waiting';

      // Keep looking while it is not serving. Once it is, the iframe is the thing watching it,
      // and polling behind it would be a request every three seconds saying what the person
      // is already looking at.
      if (!serving) {
        this.pollTimer = setTimeout(() => this.check(), POLL_MS);
      }
    },

    reload() {
      this.reloads += 1;
    },
  },
};
</script>

<template>
  <div class="workspace-browser">
    <div class="workspace-browser__bar">
      <span class="workspace-browser__url">{{ url || 'No address' }}</span>
      <!-- Reload rebuilds the iframe, so it has nothing to do where there is no iframe. -->
      <RcButton
        v-if="!ownOrigin"
        variant="tertiary"
        size="small"
        left-icon="refresh"
        :disabled="status !== 'serving'"
        @click="reload"
      >
        Reload
      </RcButton>
      <!--
        A plain link rather than a router-link: this address is Rancher's, not this
        dashboard's, and the router would try to resolve it as a route of this app.
      -->
      <RcButton
        variant="tertiary"
        size="small"
        left-icon="external-link"
        :disabled="!url"
        :href="url"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open
      </RcButton>
    </div>

    <Banner
      v-if="blocked"
      color="info"
      :label="blocked"
    />
    <Banner
      v-else-if="status === 'waiting'"
      color="info"
    >
      Nothing is answering on port {{ port }} yet. A workspace that has just started is still
      pulling or booting, and this will frame it as soon as it responds.
    </Banner>
    <Banner
      v-else-if="status === 'checking'"
      color="info"
      label="Looking for the workspace's server."
    />
    <!--
      Served at an origin of its own: a link out, not a frame. An https page cannot frame an http
      one, and this is the mode where the workspace's dashboard really does drive the workspace's
      own Rancher, so it is worth the extra click and worth saying what the port costs.
    -->
    <div
      v-else-if="ownOrigin"
      class="workspace-browser__away"
    >
      <Banner color="info">
        <p>
          This workspace is served at an origin of its own, so Open takes you to it in a new tab
          rather than framing it here. That is what makes its dashboard talk to the workspace's
          own Rancher: behind Rancher's own origin its API calls would go to the Rancher you are
          logged in to instead, whatever the workspace is pointed at.
        </p>
        <p>
          The address is a node port, which means it is open to anyone who can reach this node and
          has no Rancher session in front of it. It is the workspace's dashboard, not this cluster.
        </p>
      </Banner>
      <RcButton
        variant="primary"
        left-icon="external-link"
        :href="url"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open the workspace's dashboard
      </RcButton>
    </div>
    <!--
      Behind the proxy: what is framed is served on this Rancher's origin, and a dashboard inside
      it sends its API calls to that origin rather than to the dev server it was loaded from.
      Counted rather than reasoned about: two of the framed dashboard's requests reach the
      workspace, and a hundred and thirty-six go to the Rancher this page belongs to. The frame
      looks logged in because it is using this page's session, so clicking about in it changes the
      real cluster. A template whose app does that should set ownOrigin; until it does, this says
      so where someone about to click can read it.
    -->
    <template v-else>
      <Banner color="warning">
        What is framed below is talking to the Rancher you are logged in to, not to the
        workspace's own. It is served on Rancher's origin, and a dashboard sends its API calls to
        the origin it was loaded from, so it is using your session on the real cluster and
        anything you change in it changes that cluster. Use this to look at the interface, not to
        drive a workspace's Rancher.
      </Banner>
      <iframe
        :key="reloads"
        class="workspace-browser__frame"
        :src="url"
        title="What this workspace serves"
      />
    </template>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-browser {
    display:        flex;
    flex-direction: column;
    flex:           1 1 auto;
    min-height:     0;

    &__bar {
      display:       flex;
      align-items:   center;
      gap:           8px;
      margin-bottom: 10px;
    }

    &__url {
      flex:          1 1 auto;
      overflow:      hidden;
      padding:       4px 8px;
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
      background:    var(--body-bg);
      color:         var(--muted);
      font-family:   monospace;
      font-size:     12px;
      white-space:   nowrap;
      text-overflow: ellipsis;
    }

    &__away {
      display:        flex;
      flex-direction: column;
      align-items:    flex-start;
      gap:            10px;
      max-width:      90ch;
    }

    &__frame {
      flex:          1 1 auto;
      min-height:    320px;
      border:        1px solid var(--border);
      border-radius: var(--border-radius);
    }
  }
</style>
