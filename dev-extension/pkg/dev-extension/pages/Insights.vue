<script>
// Insights: what actually happened to the workspaces, out of the cluster's own record.
//
// The harness's Insights is a database its agents write into as they work, queried with SQL.
// There is no such API here, so the question was what plays that role in a cluster, and the
// answer is that Kubernetes already keeps the history this product needs: how long a workspace
// took to become ready, how many times its container has restarted, and what the cluster said
// while it was trying. That is recorded rather than live, it is the failure this product
// actually has (a workspace that took four minutes and nobody knew why), and it is read through
// the same API everything else here uses.
//
// Nothing on this page is invented. Where there is no history yet, it says so.
import SortableTable from '@shell/components/SortableTable';
import Loading from '@shell/components/Loading';
import { Banner } from '@components/Banner';
import { listWorkspaces, workspaceEvents, workspaceReadyTimes } from '../api';

const REFRESH_MS = 15000;

export default {
  name: 'DevInsights',

  components: { SortableTable, Loading, Banner },

  async fetch() {
    await this.refresh();
  },

  data() {
    return {
      workspaces:   [],
      readyTimes:   {},
      events:       [],
      refreshTimer: null,
      headers:      [
        {
          name: 'name', label: 'Workspace', value: 'name', sort: ['name']
        },
        {
          name: 'template', label: 'Template', value: 'templateLabel', sort: ['templateLabel']
        },
        {
          name:  'ready',
          label: 'Took to be ready',
          value: 'readySeconds',
          sort:  ['readySeconds'],
        },
        {
          name: 'restarts', label: 'Restarts', value: 'restarts', sort: ['restarts:desc'], width: 100
        },
        {
          name: 'age', label: 'Age', value: 'createdAt', sort: ['createdAt:desc'], formatter: 'LiveDate', width: 120
        },
      ],
      eventHeaders: [
        {
          name: 'workspace', label: 'Workspace', value: 'workspace', sort: ['workspace'], width: 180
        },
        {
          name: 'reason', label: 'Reason', value: 'reason', sort: ['reason'], width: 160
        },
        {
          name: 'message', label: 'What the cluster said', value: 'message'
        },
        {
          name: 'count', label: 'Times', value: 'count', sort: ['count:desc'], width: 80
        },
        {
          name: 'last', label: 'Last seen', value: 'last', sort: ['last:desc'], formatter: 'LiveDate', width: 130
        },
      ],
    };
  },

  computed: {
    rows() {
      return this.workspaces.map((workspace) => {
        const ready = this.readyTimes[workspace.name];

        return {
          ...workspace,
          readySeconds: ready?.seconds ?? null,
          restarts:     ready?.restarts ?? 0,
        };
      });
    },

    /** How long a boot takes for this cluster, over the workspaces that have finished one. */
    typical() {
      const times = this.rows.map((row) => row.readySeconds).filter((seconds) => seconds > 0);

      if (!times.length) {
        return null;
      }

      return {
        count:  times.length,
        median: times.slice().sort((a, b) => a - b)[Math.floor(times.length / 2)],
        worst:  Math.max(...times),
      };
    },
  },

  mounted() {
    this.refreshTimer = setInterval(() => this.refresh(), REFRESH_MS);
  },

  beforeUnmount() {
    clearInterval(this.refreshTimer);
  },

  methods: {
    async refresh() {
      this.workspaces = await listWorkspaces();
      const [readyTimes, events] = await Promise.all([
        workspaceReadyTimes(this.workspaces.map((workspace) => workspace.name)),
        workspaceEvents(this.workspaces.map((workspace) => workspace.name)),
      ]);

      this.readyTimes = readyTimes;
      this.events = events;
    },

    duration(seconds) {
      if (seconds === null || seconds === undefined) {
        return 'Not ready yet';
      }

      if (seconds < 90) {
        return `${ seconds }s`;
      }

      return `${ Math.floor(seconds / 60) }m ${ seconds % 60 }s`;
    },
  },
};
</script>

<template>
  <Loading v-if="$fetchState.pending" />
  <div
    v-else
    class="dev-insights"
  >
    <header>
      <h1>Insights</h1>
      <p class="subheader">
        What has happened to the workspaces in this cluster: how long they took to come up, how
        often they have restarted, and what the cluster said while they were trying. All of it
        is read out of Kubernetes' own record rather than kept here.
      </p>
    </header>

    <Banner
      v-if="typical"
      color="info"
    >
      Of the {{ typical.count }} workspaces that have finished starting, the middle one took
      {{ duration(typical.median) }} and the slowest took {{ duration(typical.worst) }}.
    </Banner>

    <h3>Workspaces</h3>
    <SortableTable
      :headers="headers"
      :rows="rows"
      key-field="name"
      default-sort-by="name"
      :table-actions="false"
      :row-actions="false"
      :search="false"
      :paging="false"
    >
      <template #cell:ready="{ row }">
        {{ duration(row.readySeconds) }}
      </template>

      <template #no-rows>
        <tr>
          <td :colspan="headers.length">
            <span class="text-muted">No workspaces yet, so there is nothing to say about them.</span>
          </td>
        </tr>
      </template>
    </SortableTable>

    <h3>What the cluster reported</h3>
    <p class="subheader">
      Warnings from the workspaces' namespaces. Kubernetes keeps these for about an hour, so an
      empty table means nothing has gone wrong recently rather than that nothing ever has.
    </p>
    <SortableTable
      :headers="eventHeaders"
      :rows="events"
      key-field="id"
      default-sort-by="last"
      :table-actions="false"
      :row-actions="false"
      :search="false"
      :paging="true"
      :rows-per-page="10"
    >
      <template #no-rows>
        <tr>
          <td :colspan="eventHeaders.length">
            <span class="text-muted">Nothing has been reported recently.</span>
          </td>
        </tr>
      </template>
    </SortableTable>
  </div>
</template>

<style lang="scss" scoped>
  .dev-insights {
    padding: 20px;

    header {
      margin-bottom: 20px;

      h1 {
        margin-bottom: 0;
      }
    }

    .subheader {
      max-width: 90ch;
      margin:    4px 0 10px 0;
      color:     var(--muted);
    }

    h3 {
      margin-top: 30px;
    }
  }
</style>
