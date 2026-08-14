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
import {
  listSidecars, startSidecar, stopSidecar, sidecarProxyUrl, templateSecretKey
} from '../api';
import { templateById } from '../templates';

const REFRESH_MS = 5000;

export default {
  name: 'WorkspaceSidecars',

  components: {
    Card, Banner, BadgeState, RcButton, AsyncButton
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
        this.states = await listSidecars(this.workspace.name, this.sidecars, this.template);
      } catch (e) {
        this.error = e.message || String(e);
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

    url(sidecar) {
      return sidecar.port ? sidecarProxyUrl(this.workspace.name, sidecar) : '';
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
        await stopSidecar(this.workspace.name, sidecar.id);
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    /** Stop then start, which for a sidecar is what restart means. */
    async restart(sidecar, done) {
      this.error = '';

      try {
        await stopSidecar(this.workspace.name, sidecar.id);
        await startSidecar(this.workspace.name, sidecar, this.template);
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

            <div class="workspace-sidecars__links">
              <RcButton
                v-if="sidecar.port && stateOf(sidecar) === 'running'"
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
                v-if="sidecar.port && stateOf(sidecar) === 'running'"
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
