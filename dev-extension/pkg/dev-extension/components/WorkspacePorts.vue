<script>
// The ports a workspace serves on, and the two things you do with one: open it, or send it to
// someone.
//
// The harness publishes a project's ports two ways, an nginx route per port and a host port
// when something has to be reachable from outside. The first of those is free here: the
// Kubernetes service proxy already puts every Service port on Rancher's own origin. So this
// page is the Service's port list, made editable, plus the two buttons.
//
// Whether a port is published outside Rancher is the template's decision, not this page's. A
// template that has to be served at its own origin gets a NodePort (see DevTemplate.ownOrigin),
// and for those workspaces the port the template declares really is reachable without a Rancher
// session. This page says which of the two each row is rather than claiming the same thing about
// all of them, because it used to tell people a node port was not built while one was open on the
// very port in the row.
import SortableTable from '@shell/components/SortableTable';
import AsyncButton from '@shell/components/AsyncButton';
import { Banner } from '@components/Banner';
import { RcButton } from '@components/RcButton';
import { LabeledInput } from '@components/Form/LabeledInput';
import {
  listWorkspacePorts, addWorkspacePort, removeWorkspacePort, portError,
  workspaceProxyUrl, workspaceServing, workspaceService, workspaceOriginUrl
} from '../api';
import { templateById } from '../templates';

export default {
  name: 'WorkspacePorts',

  components: {
    SortableTable, AsyncButton, Banner, RcButton, LabeledInput
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
      ports:    [],
      // The workspace's Service as it is, which is where the node port comes from.
      service:  null,
      // port -> true once something answered on it. A Service can route to a port nothing is
      // listening on, and saying so is the difference between "you have not started it yet"
      // and "this is broken".
      serving:  {},
      newPort:  '',
      error:    '',
      // The port whose link was last copied, so the button can say it worked. There is no
      // other feedback for a clipboard write.
      copied:   0,
      copyTimer: null,
      headers:  [
        {
          name: 'port', label: 'Port', value: 'port', sort: ['port'], width: 100
        },
        // No column for the Service port's name. It is `p<port>` for everything added here
        // (see portName in api.ts), which is to say it is a Kubernetes requirement rather than
        // anything a person chose or needs back.
        {
          name: 'answering', label: 'Answering', value: 'port', width: 110
        },
        {
          name: 'url', label: 'Address', value: 'port'
        },
        {
          name: 'reach', label: 'Who can open it', value: 'port', width: 160
        },
        {
          name: 'actions', label: '', align: 'right', width: 210
        },
      ],
    };
  },

  computed: {
    /** Why the port in the box cannot be added, or '' when it can. Blank while it is empty. */
    newPortError() {
      return this.newPort === '' ? '' : portError(Number(this.newPort), this.ports);
    },

    canAdd() {
      return this.newPort !== '' && !this.newPortError;
    },
  },

  beforeUnmount() {
    clearTimeout(this.copyTimer);
  },

  methods: {
    async refresh() {
      this.ports = await listWorkspacePorts(this.workspace.name);
      this.service = await workspaceService(this.workspace.name).catch(() => null);
      await this.checkServing();
    },

    // Asked once per refresh rather than on a timer: this is a table, and a row that flickers
    // between answering and not every three seconds is harder to read than one that is right
    // when you look at it.
    async checkServing() {
      const template = templateById(this.workspace.template);
      const answers = await Promise.all(
        this.ports.map((entry) => workspaceServing(
          this.workspace.name,
          entry.port,
          entry.port === template?.port ? template?.scheme : 'http'
        ))
      );

      this.serving = Object.fromEntries(this.ports.map((entry, i) => [entry.port, answers[i]]));
    },

    /**
     * The address of one port, which is not the same kind of address for every row.
     *
     * The template's own port on an own-origin workspace is published on the node, and that is
     * where it has to be opened: through the service proxy the dashboard it serves loads at the
     * wrong base and navigates the tab out to this Rancher instead. Every other port is the
     * service proxy, on this origin, behind this session.
     */
    onNode(port) {
      const template = templateById(this.workspace.template);

      return !!template?.ownOrigin && port === template.port && !!this.service?.nodePort;
    },

    url(port) {
      // The template's port speaks the template's scheme; a port added by hand is http until
      // there is a reason to ask which.
      const template = templateById(this.workspace.template);
      const scheme = port === template?.port ? template?.scheme : 'http';

      return this.onNode(port)
        ? workspaceOriginUrl(this.service)
        : workspaceProxyUrl(this.workspace.name, port, scheme);
    },

    /** The address as somebody else would have to type it, which is what goes on the clipboard. */
    absoluteUrl(port) {
      const url = this.url(port);

      return url.startsWith('http') ? url : `${ window.location.origin }${ url }`;
    },

    /** Who can open this row's address, in one word for the table. */
    reach(port) {
      return this.onNode(port) ? 'Anyone on the node' : 'Rancher session';
    },

    async add(done) {
      this.error = '';

      try {
        await addWorkspacePort(this.workspace.name, Number(this.newPort));
        this.newPort = '';
        await this.refresh();
        done(true);
      } catch (e) {
        this.error = e.message || String(e);
        done(false);
      }
    },

    async remove(port) {
      this.error = '';

      try {
        await removeWorkspacePort(this.workspace.name, port);
        await this.refresh();
      } catch (e) {
        this.error = e.message || String(e);
      }
    },

    async share(port) {
      this.error = '';

      try {
        await navigator.clipboard.writeText(this.absoluteUrl(port));
        this.copied = port;
        clearTimeout(this.copyTimer);
        this.copyTimer = setTimeout(() => {
          this.copied = 0;
        }, 4000);
      } catch {
        // Writing to the clipboard needs a secure context and a user gesture, and this has
        // both, but a browser can still refuse. Saying so beats a button that did nothing.
        this.error = 'The browser would not let this page write to the clipboard. The address is in the table, and can be copied by hand.';
      }
    },
  },
};
</script>

<template>
  <div class="workspace-ports">
    <Banner
      v-if="error"
      color="error"
      :label="error"
    />

    <SortableTable
      :headers="headers"
      :rows="ports"
      key-field="port"
      default-sort-by="port"
      :table-actions="false"
      :row-actions="false"
      :search="false"
      :paging="false"
    >
      <template #cell:answering="{ row }">
        <span :class="serving[row.port] ? 'text-success' : 'text-muted'">
          {{ serving[row.port] ? 'Yes' : 'Nothing yet' }}
        </span>
      </template>

      <template #cell:url="{ row }">
        <span class="workspace-ports__url">{{ url(row.port) }}</span>
      </template>

      <template #cell:reach="{ row }">
        <span :class="onNode(row.port) ? 'text-warning' : 'text-muted'">{{ reach(row.port) }}</span>
      </template>

      <template #cell:actions="{ row }">
        <div class="workspace-ports__actions">
          <RcButton
            variant="tertiary"
            size="small"
            left-icon="external-link"
            :href="url(row.port)"
            target="_blank"
            rel="noopener noreferrer"
          >
            Open
          </RcButton>
          <RcButton
            variant="tertiary"
            size="small"
            left-icon="copy"
            @click="share(row.port)"
          >
            {{ copied === row.port ? 'Copied' : 'Share' }}
          </RcButton>
          <RcButton
            variant="tertiary"
            size="small"
            left-icon="minus"
            @click="remove(row.port)"
          >
            Remove
          </RcButton>
        </div>
      </template>

      <template #no-rows>
        <tr>
          <td :colspan="headers.length">
            <span class="text-muted">This workspace's Service has no ports.</span>
          </td>
        </tr>
      </template>
    </SortableTable>

    <div class="workspace-ports__add">
      <LabeledInput
        v-model:value="newPort"
        label="Add a port"
        type="number"
        placeholder="3000"
        :status="newPortError ? 'error' : null"
        :sub-label="newPortError"
      />
      <AsyncButton
        mode="apply"
        action-label="Add"
        waiting-label="Adding"
        success-label="Added"
        :disabled="!canAdd"
        @click="add"
      />
    </div>

    <p class="workspace-ports__note">
      Share puts the address on your clipboard, and the table says who can open what it copied.
      A <b>Rancher session</b> address goes through this Rancher: whoever you send it to can open
      it if they have a session here with access to the <b>{{ workspace.namespace }}</b> namespace,
      and cannot open it otherwise. An <b>Anyone on the node</b> address is a node port on the
      workspace's Service, with no session in front of it, which is what this workspace's template
      needs in order to serve a dashboard that talks to its own Rancher rather than to this one.
    </p>
  </div>
</template>

<style lang="scss" scoped>
  .workspace-ports {
    // The address is long and the table is inside a tab pane, so it is truncated rather than
    // allowed to push the page sideways. The whole of it is one click away on Share, and on
    // Open, which are the two things anyone wants it for.
    &__url {
      display:       block;
      max-width:     260px;
      overflow:      hidden;
      color:         var(--muted);
      font-family:   monospace;
      font-size:     12px;
      white-space:   nowrap;
      text-overflow: ellipsis;
    }

    &__actions {
      display:         flex;
      gap:             6px;
      justify-content: flex-end;
    }

    &__add {
      display:     flex;
      align-items: flex-start;
      gap:         10px;
      max-width:   420px;
      margin-top:  20px;
    }

    &__note {
      max-width:  80ch;
      margin-top: 20px;
      color:      var(--muted);
    }
  }
</style>
