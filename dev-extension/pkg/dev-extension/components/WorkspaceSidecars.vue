<script>
// The optional containers a workspace can run beside itself.
//
// A sidecar is what a workspace already is, one level down: a Deployment in the workspace's own
// namespace, a Service when it serves something, started and stopped by scaling, and reached
// through the same service proxy. So nothing new is invented here. The card is Rancher's Card,
// the badge is the same state badge the tables use, and Launch and Share are the same two
// things the Ports tab does.
//
// They are declared by the template (see templates.ts) and default to stopped, because a
// workspace should be cheap to make: the Deployment is created the first time someone presses
// Start. Groups come from the declarations, so a template with one group renders one group.
import { Card } from '@components/Card';
import { Banner } from '@components/Banner';
import { BadgeState } from '@components/BadgeState';
import { RcButton } from '@components/RcButton';
import AsyncButton from '@shell/components/AsyncButton';
import { colorForState, stateDisplay } from '@shell/plugins/dashboard-store/resource-class';
import LabeledSelect from '@shell/components/form/LabeledSelect';
import {
  listSidecars, startSidecar, stopSidecar, restartSidecar, sidecarProxyUrl, sidecarServiceUrl,
  templateSecretKey, workspaceAuth, setWorkspaceAuth, sidecarNodePort
} from '../api';
import { templateById } from '../templates';

const REFRESH_MS = 5000;

export default {
  name: 'WorkspaceSidecars',

  components: {
    Card, Banner, BadgeState, RcButton, AsyncButton, LabeledSelect
  },

  props: {
    workspace: {
      type:     Object,
      required: true,
    },
  },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      states:       {},
      // What the workspace has asked its own Rancher to use, and what the manager made of it.
      auth:         {
        wanted: '', applied: '', message: '', at: ''
      },
      // The mode each auth card is offering, which is the applied one where there is one so that
      // the control opens on what is true rather than on the first entry in the list.
      chosen:       {},
      // The node port the cluster assigned a sidecar that asked for one, by id.
      nodePorts:    {},
      error:        '',
      copied:       '',
      copyTimer:    null,
      refreshTimer: null,
    };
  },

  computed: {
    template() {
      return templateById(this.workspace.template);
    },

    sidecars() {
      return this.template?.sidecars || [];
    },

    /** The declarations, grouped as they were declared. */
    groups() {
      const groups = new Map();

      for (const sidecar of this.sidecars) {
        groups.set(sidecar.group, [...(groups.get(sidecar.group) || []), sidecar]);
      }

      return [...groups.entries()].map(([name, items]) => ({ name, items }));
    },

    running() {
      return Object.values(this.states).filter((state) => state.state === 'running').length;
    },

    /** The sidecar that owns this workspace's Rancher, which is the one that applies an auth choice. */
    rancherSidecar() {
      return this.sidecars.find((sidecar) => sidecar.providesApi) || null;
    },
  },

  mounted() {
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
    clearTimeout(this.copyTimer);
  },

  methods: {
    async refresh() {
      try {
        const [states, auth] = await Promise.all([
          listSidecars(this.workspace.name, this.sidecars, this.template),
          workspaceAuth(this.workspace.name),
        ]);

        this.states = states;
        this.auth = auth;

        // Only for the sidecars that asked for one, and only while they are running: an assigned
        // node port is the cluster's answer rather than anything declared here.
        for (const sidecar of this.sidecars.filter((candidate) => candidate.nodePort)) {
          this.nodePorts = { ...this.nodePorts, [sidecar.id]: await sidecarNodePort(this.workspace.name, sidecar) };
        }

        for (const sidecar of this.sidecars.filter((candidate) => candidate.auth)) {
          if (!this.chosen[sidecar.id]) {
            const mine = sidecar.auth.find((mode) => mode.value === auth.wanted);

            this.chosen = { ...this.chosen, [sidecar.id]: (mine || sidecar.auth[0]).value };
          }
        }
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    /**
     * Whether this card can offer to point Rancher at itself.
     *
     * Both sides have to be up, and it is the manager that carries it out, so a request made while
     * either is down would sit unapplied with nothing to say why.
     */
    canApplyAuth(sidecar) {
      return this.stateOf(sidecar) === 'running' && !!this.rancherSidecar &&
        this.stateOf(this.rancherSidecar) === 'running';
    },

    /** The mode of this card's that Rancher is actually using, if any. */
    appliedMode(sidecar) {
      return (sidecar.auth || []).find((mode) => mode.value === this.auth.applied) || null;
    },

    /** Asked for, not yet reported back by the manager. */
    pendingAuth(sidecar) {
      return (sidecar.auth || []).some((mode) => mode.value === this.auth.wanted) &&
        this.auth.applied !== this.auth.wanted;
    },

    async applyAuth(sidecar, done) {
      this.error = '';

      try {
        await setWorkspaceAuth(this.workspace.name, this.chosen[sidecar.id]);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** Back to local users only, which is also how the other provider gets disabled. */
    async clearAuth(done) {
      this.error = '';

      try {
        await setWorkspaceAuth(this.workspace.name, '');
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    stateOf(sidecar) {
      return this.states[sidecar.id]?.state || 'stopped';
    },

    badgeColor(sidecar) {
      return colorForState(this.stateOf(sidecar)).replace('text-', 'bg-');
    },

    badgeLabel(sidecar) {
      return stateDisplay(this.stateOf(sidecar));
    },

    /** Keys this sidecar declared that are not in the secret store yet. */
    missing(sidecar) {
      return this.states[sidecar.id]?.missing || [];
    },

    /**
     * The declarations behind those keys, so the card can tell the two cases apart: a key the
     * sidecar cannot work without stops it being started, and one it merely prefers does not.
     */
    missingRequired(sidecar) {
      return this.missing(sidecar)
        .filter((key) => (this.template?.secrets || []).find((secret) => secret.key === key)?.required !== false);
    },

    missingLabel(sidecar) {
      const keys = this.missing(sidecar)
        .map((key) => templateSecretKey(this.workspace.template, key))
        .join(', ');

      if (this.missingRequired(sidecar).length) {
        return `Cannot start: ${ keys } is not set. Set it in Settings, then start this.`;
      }

      return `Not in use: ${ keys } is not set. Set it in Settings and start this again.`;
    },

    /** What the cluster says about a sidecar that is not running, when it says anything. */
    detail(sidecar) {
      return this.states[sidecar.id]?.detail || '';
    },

    /** The last line it printed, while it is still coming up. */
    log(sidecar) {
      return this.states[sidecar.id]?.log || '';
    },

    /** Where one pod reaches another, which is what a sidecar that serves no UI is for. */
    address(sidecar) {
      return sidecar.port ? sidecarServiceUrl(this.workspace.name, sidecar) : '';
    },

    /**
     * Where to send a browser for this sidecar.
     *
     * A node port when the declaration asks for one, and that is not a preference: Keycloak
     * rewrites itself out of a path prefix, so the service proxy can only ever serve it a 404,
     * which is why it has a node port in the first place. The hostname is this page's rather than
     * the node's InternalIP, for the reason workspaceOriginUrl gives: the browser reached Rancher
     * at it, so it can reach the node port at it.
     */
    url(sidecar) {
      if (!sidecar.port) {
        return '';
      }

      const published = this.nodePorts[sidecar.id];

      if (published) {
        return `${ sidecar.scheme || 'http' }://${ window.location.hostname }:${ published }/`;
      }

      return sidecarProxyUrl(this.workspace.name, sidecar);
    },

    /** How a conversation in this workspace adds an MCP sidecar, once it is running. */
    mcpCommand(sidecar) {
      if (!sidecar.mcpPath || this.stateOf(sidecar) !== 'running') {
        return '';
      }

      return `claude mcp add --transport http ${ sidecar.id } ${ this.address(sidecar) }:${ sidecar.port }${ sidecar.mcpPath }`;
    },

    async start(sidecar, done) {
      this.error = '';

      try {
        await startSidecar(this.workspace.name, sidecar, this.template);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async stop(sidecar, done) {
      this.error = '';

      try {
        await stopSidecar(this.workspace.name, sidecar.id, this.template);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** A rollout, not a stop and a start. See restartSidecar for why that distinction matters. */
    async restart(sidecar, done) {
      this.error = '';

      try {
        await restartSidecar(this.workspace.name, sidecar, this.template);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async share(sidecar) {
      try {
        await navigator.clipboard.writeText(`${ window.location.origin }${ this.url(sidecar) }`);
        this.copied = sidecar.id;
        clearTimeout(this.copyTimer);
        this.copyTimer = setTimeout(() => {
          this.copied = '';
        }, 4000);
      } catch {
        this.error = 'The browser would not let this page write to the clipboard.';
      }
    },
  },
};
</script>

<template>
  <div class="workspace-sidecars">
    <header>
      <h3>Sidecars</h3>
      <span class="workspace-sidecars__count">{{ running }} of {{ sidecars.length }} running</span>
      <RcButton
        variant="tertiary"
        size="small"
        left-icon="refresh"
        @click="refresh"
      >
        Refresh
      </RcButton>
    </header>

    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <Banner
      v-if="!sidecars.length"
      color="info"
      label="This workspace's template declares no sidecars."
    />

    <section
      v-for="group in groups"
      :key="group.name"
      class="workspace-sidecars__group"
    >
      <h4>{{ group.name }}</h4>
      <div class="workspace-sidecars__cards">
        <Card
          v-for="sidecar in group.items"
          :key="sidecar.id"
          class="workspace-sidecars__card"
          :show-highlight-border="false"
          :show-actions="false"
        >
          <template #title>
            <div class="workspace-sidecars__title">
              <h5>{{ sidecar.label }}</h5>
              <BadgeState
                :color="badgeColor(sidecar)"
                :label="badgeLabel(sidecar)"
              />
            </div>
          </template>

          <template #body>
            <p>{{ sidecar.description }}</p>
            <p class="workspace-sidecars__image">
              {{ sidecar.image }}
            </p>
            <p
              v-if="missing(sidecar).length"
              class="workspace-sidecars__missing"
            >
              {{ missingLabel(sidecar) }}
            </p>
            <!--
              The cluster's own sentence, which is the difference between a card that says
              Starting for four minutes and one that says the image cannot be pulled.
            -->
            <p
              v-if="detail(sidecar) && stateOf(sidecar) !== 'running'"
              class="workspace-sidecars__detail"
            >
              {{ detail(sidecar) }}
            </p>

            <!--
              While it is coming up, the last thing it said. A sidecar that installs two helm
              charts is Starting for about ten minutes, and this is the difference between that
              and something being wrong.
            -->
            <p
              v-if="log(sidecar)"
              class="workspace-sidecars__log"
            >
              {{ log(sidecar) }}
            </p>

            <!--
              What the workspace itself talks to, for a sidecar whose whole point is being reached
              from inside the cluster rather than opened in a tab.
            -->
            <p
              v-if="address(sidecar) && sidecar.providesApi"
              class="workspace-sidecars__image"
            >
              {{ address(sidecar) }}
              <span v-if="stateOf(sidecar) === 'running'">is what this workspace's dashboard is pointed at.</span>
              <span v-else>is what this workspace's dashboard will be pointed at while this runs.</span>
            </p>

            <!--
              An MCP server has nothing to open, so what its card offers is the line that adds it
              to a conversation in this workspace. In-cluster address, because the thing that will
              use it is the workspace's own container.
            -->
            <p
              v-if="mcpCommand(sidecar)"
              class="workspace-sidecars__image"
            >
              {{ mcpCommand(sidecar) }}
            </p>

            <!--
              The auth row, which is the closet's: one provider at a time, so applying this one is
              also turning the other off. The manager is what carries it out, so this writes the
              request and reads back what the manager said about it.
            -->
            <div
              v-if="sidecar.auth"
              class="workspace-sidecars__auth"
            >
              <div class="workspace-sidecars__auth-row">
                <span class="workspace-sidecars__auth-label">Rancher auth</span>
                <LabeledSelect
                  v-if="sidecar.auth.length > 1"
                  :value="chosen[sidecar.id]"
                  :options="sidecar.auth"
                  option-label="label"
                  option-key="value"
                  :reduce="(mode) => mode.value"
                  :clearable="false"
                  class="workspace-sidecars__auth-select"
                  @update:value="(value) => chosen = { ...chosen, [sidecar.id]: value }"
                />
                <span v-else>{{ sidecar.auth[0].label }}</span>
                <AsyncButton
                  mode="apply"
                  :action-label="appliedMode(sidecar) ? 'Re-apply' : 'Apply'"
                  waiting-label="Applying"
                  success-label="Asked"
                  :disabled="!canApplyAuth(sidecar)"
                  @click="(done) => applyAuth(sidecar, done)"
                />
                <AsyncButton
                  v-if="appliedMode(sidecar)"
                  mode="apply"
                  action-label="Disable"
                  waiting-label="Disabling"
                  success-label="Asked"
                  @click="(done) => clearAuth(done)"
                />
              </div>
              <!--
                Three different things, and saying which is which is the point of the row: what
                Rancher is using now, a request the manager has not got to yet, and why it cannot
                be asked at all.
              -->
              <p
                v-if="appliedMode(sidecar)"
                class="workspace-sidecars__auth-state"
              >
                Applied: {{ appliedMode(sidecar).label }}. {{ auth.message }}
              </p>
              <p
                v-else-if="pendingAuth(sidecar)"
                class="workspace-sidecars__auth-state"
              >
                Asked for, waiting for the Rancher sidecar to apply it. {{ auth.message }}
              </p>
              <p
                v-else-if="!canApplyAuth(sidecar)"
                class="workspace-sidecars__auth-state"
              >
                Start this and the Rancher sidecar, then Apply.
              </p>
            </div>

            <div class="workspace-sidecars__links">
              <!--
                Only where the service proxy can actually serve the thing. Rancher and Keycloak
                both rewrite themselves out of a path prefix, and a Launch that opens a page which
                redirects itself to a 404 is worse than no Launch.
              -->
              <RcButton
                v-if="sidecar.port && sidecar.launchable !== false && stateOf(sidecar) === 'running'"
                variant="link"
                size="small"
                left-icon="external-link"
                :href="url(sidecar)"
                target="_blank"
                rel="noopener noreferrer"
              >
                Launch
              </RcButton>
              <RcButton
                v-if="sidecar.port && sidecar.launchable !== false && stateOf(sidecar) === 'running'"
                variant="link"
                size="small"
                left-icon="copy"
                @click="share(sidecar)"
              >
                {{ copied === sidecar.id ? 'Copied' : 'Share' }}
              </RcButton>
            </div>

            <div class="workspace-sidecars__actions">
              <!--
                Disabled rather than allowed to fail. A sidecar started without a key it needs
                comes up, answers nothing and looks healthy, so the card says it cannot work and
                then does not let you do it anyway.
              -->
              <AsyncButton
                v-if="stateOf(sidecar) === 'stopped'"
                mode="apply"
                action-label="Start"
                waiting-label="Starting"
                success-label="Started"
                :disabled="missingRequired(sidecar).length > 0"
                @click="(done) => start(sidecar, done)"
              />
              <template v-else>
                <AsyncButton
                  mode="apply"
                  action-label="Stop"
                  waiting-label="Stopping"
                  success-label="Stopped"
                  @click="(done) => stop(sidecar, done)"
                />
                <AsyncButton
                  mode="apply"
                  action-label="Restart"
                  waiting-label="Restarting"
                  success-label="Restarted"
                  @click="(done) => restart(sidecar, done)"
                />
              </template>
            </div>
          </template>
        </Card>
      </div>
    </section>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-sidecars {
    overflow-y: auto;
    padding:    20px;

    header {
      display:       flex;
      align-items:   center;
      gap:           10px;
      margin-bottom: 10px;

      h3 {
        margin: 0;
      }
    }

    &__count {
      color:     var(--muted);
      font-size: 12px;
    }

    &__group {
      margin-top: 20px;

      h4 {
        margin:         0 0 8px 0;
        color:          var(--muted);
        font-size:      12px;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
    }

    // Two to a row, as the harness has them, and one on a narrow window.
    &__cards {
      display:               grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap:                   10px;
      max-width:             1000px;
    }

    &__title {
      display:     flex;
      align-items: center;
      gap:         10px;

      h5 {
        margin: 0;
      }
    }

    &__image {
      color:       var(--muted);
      font-family: monospace;
      font-size:   12px;
    }

    &__missing {
      color: var(--warning);
    }

    &__detail {
      color:     var(--muted);
      font-size: 12px;
    }

    // One line, whatever it says: a helm install prints lines of any length and the card is a
    // card. What matters is that it is moving and what it is doing, not the whole line.
    &__log {
      overflow:      hidden;
      color:         var(--muted);
      font-family:   monospace;
      font-size:     11px;
      text-overflow: ellipsis;
      white-space:   nowrap;
    }

    &__auth {
      margin-top:  10px;
      padding-top: 10px;
      border-top:  1px solid var(--border);
    }

    &__auth-row {
      display:     flex;
      align-items: center;
      gap:         10px;
    }

    &__auth-label {
      color:     var(--muted);
      font-size: 12px;
    }

    // Wide enough for the longest provider name and no wider: the row it sits in is a card's.
    &__auth-select {
      width: 140px;
    }

    &__auth-state {
      margin-top: 5px;
      color:      var(--muted);
      font-size:  12px;
    }

    &__links {
      display: flex;
      gap:     10px;
    }

    &__actions {
      display:   flex;
      gap:       10px;
      margin-top: 10px;
    }
  }
</style>
