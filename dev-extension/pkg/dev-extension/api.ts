/**
 * The Dev product's half of the Claude Harness, expressed in Kubernetes.
 *
 * A workspace is a namespace `dev-<name>` holding a Deployment and a Service, all three
 * labelled with the workspace's name so the list can find them again. Starting and stopping is
 * scaling the Deployment between one replica and none, which is the Kubernetes shape of the
 * harness's `docker start` / `docker stop`; deleting is deleting the namespace, so nothing can
 * be left behind by a resource this file forgot it created.
 *
 * The harness calls this a project. It is a workspace here because Rancher already has
 * projects, and they are a different thing living one nav entry away (see config/constants).
 * The `dev-` namespace prefix is unaffected: that names the product, not the concept.
 *
 * Everything goes through the browser's own Rancher session: same-origin `fetch` against
 * Steve on `/k8s/clusters/<cluster>/v1`, with the CSRF header the API wants on writes. There
 * is no controller and no credential anywhere in here.
 */
import {
  templateById, DevTemplate, DevSidecar, GLOBAL_SECRETS
} from './templates';
import { WORKSPACE_VUE_CONFIG, WORKSPACE_CONFIG_MOUNT } from './workspace-config';

// The `local` cluster, like the pod this dev server runs in. The product shows no cluster
// switcher, so there is nothing that could make this a choice.
const CLUSTER = 'local';
const BASE = `/k8s/clusters/${ CLUSTER }`;

/** Everything a workspace owns carries these, and the list is built by filtering on them. */
export const LABEL_WORKSPACE = 'dev.rancher.io/workspace';
export const LABEL_TEMPLATE = 'dev.rancher.io/template';

/**
 * Ask Steve for the labelled things only, rather than for everything.
 *
 * Two query parameters that look like the same feature, and only one of them is: Steve
 * ignores Kubernetes' `labelSelector` and answers with the whole collection anyway (asked for
 * this label, it hands back all two dozen namespaces of this cluster, workspace or not),
 * while its own `filter` does the work, and matches a value exactly rather than by substring.
 *
 * It is an optimisation and only that. Every caller of it filters what comes back as well,
 * because a Steve that ignored this parameter would answer with everything, and that
 * browser-side pass is what keeps such a Steve a slower list rather than a wrong one. Neither
 * half is redundant: this one is the saving, the one below it is the guarantee.
 */
const WORKSPACE_FILTER = `filter=metadata.labels[${ LABEL_WORKSPACE }]`;

/**
 * The one container in a workspace's pod. Named here rather than after the template because
 * the terminal has to address it, and a name that varies would make that a lookup.
 */
export const WORKSPACE_CONTAINER = 'workspace';

/** Kubernetes name rules, minus the parts a 63-character workspace name cannot reach. */
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_NAME_LENGTH = 40;

export type WorkspaceState = 'running' | 'stopped' | 'starting' | 'creating' | 'removing' | 'error';

export interface DevWorkspace {
  name: string;
  namespace: string;
  /** The template id. Kept even when it names a template that no longer exists. */
  template: string;
  templateLabel: string;
  state: WorkspaceState;
  createdAt: string;
  /**
   * The image the Deployment actually runs, which is not always the template's: anything can
   * edit a Deployment after this created it, and a page that reads the image back off the
   * template would go on describing a container that is no longer there.
   */
  image: string;
  /** What the Deployment is scaled to, and what it actually has. */
  replicas: number;
  ready: number;
  /**
   * Which minute of a long start this is in, in the pod's own words.
   *
   * A workspace that clones a repository, installs it and compiles it is Starting for several
   * minutes, and "Starting" for four minutes is indistinguishable from broken. The pod knows
   * the difference between pulling an image, waiting to be scheduled, crash-looping and simply
   * taking a while, so this carries whichever of those it is.
   */
  detail: string;
}

/** A workspace's Service, as it exists rather than as its template described it. */
export interface DevService {
  name: string;
  port: number;
}

// Steve hands back plain JSON with no types worth importing, and narrowing it here would only
// be a second description of the same shapes. The accessors below are the narrowing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function csrfHeader(): Record<string, string> {
  const match = document.cookie.match(/(?:^|;\s*)CSRF=([^;]*)/);

  return { 'X-Api-Csrf': match ? decodeURIComponent(match[1]) : 'CSRF' };
}

/**
 * Same-origin request to Rancher, with the CSRF header on anything that writes.
 *
 * Rancher rejects a write without it, and the value is the CSRF cookie the session already
 * set, so this needs nothing the page does not have.
 */
export async function devFetch(path: string, init?: RequestInit): Promise<Json> {
  const write = !!init?.method && init.method !== 'GET';
  const resp = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Accept:         'application/json',
      ...(write ? csrfHeader() : {}),
      ...(init?.headers || {}),
    },
  });
  const data = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    throw new Error(data.message || data.error || `HTTP ${ resp.status }`);
  }

  return data;
}

/**
 * The namespace a workspace lives in.
 *
 * Still `dev-`, deliberately, through the rename from project to workspace: the prefix says
 * which product owns the namespace, and that product is still Dev.
 */
export function workspaceNamespace(name: string): string {
  return `dev-${ name }`;
}

/**
 * Why a name is not usable, or '' when it is.
 *
 * Checked before the create rather than left to the apiserver: its own message names the
 * generated namespace and quotes the RFC, which tells someone who typed a capital letter very
 * little about what to type instead.
 */
export function workspaceNameError(name: string): string {
  if (!name) {
    return 'A name is required';
  }

  if (name.length > MAX_NAME_LENGTH) {
    return `A name can be at most ${ MAX_NAME_LENGTH } characters`;
  }

  if (!NAME_PATTERN.test(name)) {
    return 'A name can contain only lowercase letters, numbers and dashes, and must start and end with a letter or number';
  }

  return '';
}

/**
 * What a pod is doing, from its own status, or '' when there is nothing worth saying.
 *
 * Only the container's own reasons, not a guess: `waiting.reason` is the apiserver's word for
 * it (ImagePullBackOff, CrashLoopBackOff, ContainerCreating), and a container that is running
 * but not ready is one whose startup probe has not passed yet, which for a workspace that
 * installs on boot is the ordinary case rather than a fault.
 */
function podDetail(pod: Json | undefined): string {
  if (!pod) {
    return '';
  }

  if (pod.metadata?.deletionTimestamp) {
    return 'Terminating';
  }

  const status = pod.status?.containerStatuses?.[0];
  const waiting = status?.state?.waiting;

  if (waiting?.reason) {
    const restarts = status.restartCount ? `, restarted ${ status.restartCount } times` : '';

    return `${ waiting.reason }${ restarts }`;
  }

  if (pod.status?.phase === 'Pending') {
    return 'Waiting to be scheduled';
  }

  if (status?.state?.running && !status.ready) {
    return status.restartCount ? `Starting up, restarted ${ status.restartCount } times` : 'Starting up';
  }

  return '';
}

/**
 * Why a Deployment has no pod at all, in the cluster's own words, or '' when it has one.
 *
 * A pod that never gets created leaves nothing for podDetail to read, so without this the page
 * has only "Starting" to show and shows it forever. The controller records the reason on the
 * Deployment as a ReplicaFailure condition, which is where a missing ServiceAccount, a quota and
 * a rejected pod spec all end up, and its message is the apiserver's own sentence.
 */
function replicaFailure(deployment: Json | undefined): string {
  const condition = (deployment?.status?.conditions || [])
    .find((entry: Json) => entry.type === 'ReplicaFailure' && entry.status === 'True');

  return condition?.message || '';
}

/**
 * Container reasons that are a failure rather than a stage of starting.
 *
 * `ImagePullBackOff` has to be named: an image that cannot be pulled alternates between
 * `ErrImagePull` and `ImagePullBackOff`, so a rule that catches only the first leaves the state
 * oscillating between Error and Starting rather than settling on the truth.
 */
const FAILED_REASONS = [
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
];

function isFailedReason(reason: string): boolean {
  return FAILED_REASONS.some((failed) => reason.includes(failed));
}

function stateOf(namespace: Json, deployment: Json | undefined, pod?: Json): WorkspaceState {
  // A namespace being collected still lists, and its Deployment may outlive it by a moment, so
  // deletion is asked about first or a workspace would read as Running while it goes away.
  if (namespace.metadata?.deletionTimestamp) {
    return 'removing';
  }

  if (!deployment) {
    return 'creating';
  }

  if ((deployment.spec?.replicas ?? 0) === 0) {
    return 'stopped';
  }

  if ((deployment.status?.readyReplicas ?? 0) > 0) {
    return 'running';
  }

  // A Deployment the controller cannot make a pod for is not starting either, and it is the
  // case with nothing to look at: no pod, no logs, no events under a name anyone knows.
  if (!pod && replicaFailure(deployment)) {
    return 'error';
  }

  // A pod that keeps dying is not starting, however long you wait, and a workspace that says
  // Starting through fifty restarts is a workspace nobody looks at the logs of.
  const reason = pod?.status?.containerStatuses?.[0]?.state?.waiting?.reason || '';

  return isFailedReason(reason) ? 'error' : 'starting';
}

/**
 * A workspace, out of the namespace that records it and the Deployment that runs it.
 *
 * One function for both readers, so the list and the detail page cannot come to describe the
 * same workspace differently while fetching it two different ways.
 */
function workspaceFrom(namespace: Json, deployment: Json | undefined, pod?: Json): DevWorkspace {
  const name = namespace.metadata.labels[LABEL_WORKSPACE];
  const template = namespace.metadata.labels[LABEL_TEMPLATE] || '';

  return {
    name,
    namespace:     namespace.metadata.name,
    template,
    templateLabel: templateById(template)?.label || template || 'Unknown',
    state:         stateOf(namespace, deployment, pod),
    createdAt:     namespace.metadata.creationTimestamp,
    image:         deployment?.spec?.template?.spec?.containers?.[0]?.image || '',
    replicas:      deployment?.spec?.replicas ?? 0,
    ready:         deployment?.status?.readyReplicas ?? 0,
    // The pod's own words where there is a pod, and the controller's where there is not.
    detail:        podDetail(pod) || (pod ? '' : replicaFailure(deployment)),
  };
}

/**
 * Every workspace in the cluster.
 *
 * The namespace is the record of a workspace and the Deployment is its state, so both are
 * fetched and joined here: a workspace that is being created has no Deployment yet, and one
 * being deleted has a namespace that outlives it. Both collections are asked for by label
 * (see WORKSPACE_FILTER) and filtered again below, which is a saving on a cluster of any size
 * and no change to what this returns.
 */
export async function listWorkspaces(): Promise<DevWorkspace[]> {
  const [namespaces, deployments, pods] = await Promise.all([
    devFetch(`${ BASE }/v1/namespaces?${ WORKSPACE_FILTER }`),
    devFetch(`${ BASE }/v1/apps.deployments?${ WORKSPACE_FILTER }`),
    // The third collection is what turns "Starting" into which part of starting. One request
    // for every workspace's pod, not one per workspace, so the list costs the same as it did.
    devFetch(`${ BASE }/v1/pods?${ WORKSPACE_FILTER }`).catch(() => null),
  ]);

  const byWorkspace = new Map<string, Json>();
  const podByWorkspace = new Map<string, Json>();

  for (const deployment of deployments.data || []) {
    const workspace = deployment.metadata?.labels?.[LABEL_WORKSPACE];

    if (workspace) {
      byWorkspace.set(workspace, deployment);
    }
  }

  for (const pod of pods?.data || []) {
    const workspace = pod.metadata?.labels?.[LABEL_WORKSPACE];

    if (workspace) {
      podByWorkspace.set(workspace, pod);
    }
  }

  return (namespaces.data || [])
    .filter((namespace: Json) => !!namespace.metadata?.labels?.[LABEL_WORKSPACE])
    .map((namespace: Json) => {
      const name = namespace.metadata.labels[LABEL_WORKSPACE];

      return workspaceFrom(namespace, byWorkspace.get(name), podByWorkspace.get(name));
    })
    .sort((a: DevWorkspace, b: DevWorkspace) => a.name.localeCompare(b.name));
}

/**
 * One workspace, or null if it is not there.
 *
 * Its own namespace and that namespace's Deployment, not listWorkspaces filtered down: a
 * workspace already knows where it lives, and the detail page asks this every five seconds.
 * Through the list it would be every workspace in the cluster, twice, to read one back.
 *
 * The Deployment comes from the namespace's collection rather than by name for the reason
 * workspaceService does the same: a workspace in the moment between its namespace and its
 * Deployment answers 200 with nothing in it instead of a 404 the console keeps. The namespace
 * itself is asked for by name, where a 404 is the honest answer to a workspace that has been
 * deleted, and is what puts the page's "there is no workspace called ..." banner up.
 */
export async function getWorkspace(name: string): Promise<DevWorkspace | null> {
  const namespace = workspaceNamespace(name);
  const [record, deployments, pods] = await Promise.all([
    devFetch(`${ BASE }/v1/namespaces/${ namespace }`).catch(() => null),
    devFetch(`${ BASE }/v1/apps.deployments/${ namespace }`).catch(() => null),
    devFetch(`${ BASE }/v1/pods/${ namespace }`).catch(() => null),
  ]);

  // A namespace without the label is not a workspace, whatever it is called.
  if (record?.metadata?.labels?.[LABEL_WORKSPACE] !== name) {
    return null;
  }

  const deployment = (deployments?.data || [])
    .find((candidate: Json) => candidate.metadata?.labels?.[LABEL_WORKSPACE] === name);
  const pod = (pods?.data || [])
    .find((candidate: Json) => candidate.metadata?.labels?.[LABEL_WORKSPACE] === name);

  return workspaceFrom(record, deployment, pod);
}

function deploymentBody(name: string, template: DevTemplate): Json {
  const namespace = workspaceNamespace(name);
  const labels = { app: namespace, [LABEL_WORKSPACE]: name, [LABEL_TEMPLATE]: template.id };

  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace, name: namespace, labels },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: namespace } },
      // Recreate rather than RollingUpdate: the checkout is a hostPath, so two pods would be
      // installing into the same directory at the same time.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels },
        spec:     {
          // Not the namespace's default ServiceAccount: a workspace runs whatever a template
          // or a person put in it, and this is the identity that says what that is allowed to
          // reach (see ensureDevRbac).
          serviceAccountName: WORKSPACE_SERVICE_ACCOUNT,
          containers:         [{
            name:  WORKSPACE_CONTAINER,
            image: template.image,
            ...(template.command ? { command: template.command } : {}),
            ports: [{ name: 'http', containerPort: template.port }],
            // `{{proxyPath}}` is the one substitution a template gets: the path this workspace
            // is reached at, which contains its own name.
            env:   Object.entries(template.env || {}).map(([envName, value]) => ({
              name:  envName,
              value: value.replace('{{proxyPath}}', workspaceProxyUrl(name, template.port, template.scheme)),
            })),
            // The workspace's own secrets, by reference and as a whole Secret rather than key by
            // key. A named list would be fixed at create time, so a key added in Settings later
            // would need the Deployment rewritten; this way the mirror is the list, and it is
            // rewritten before every start. `optional` so a workspace with nothing set still runs.
            envFrom: [{ secretRef: { name: MIRROR_SECRET, optional: true } }],
            volumeMounts: [
              ...(template.hostPath ? [{ name: 'work', mountPath: '/workspace' }] : []),
              // Read-only, and copied rather than mounted over the checkout: a workspace is an
              // ordinary clone someone can edit, and a file mounted into it could not be.
              { name: 'dev-config', mountPath: WORKSPACE_CONFIG_MOUNT, readOnly: true },
            ],
            // A first boot is a clone, an install and a compile, which is minutes. A startup
            // probe with a long budget is what stops the kubelet killing a pod that is working,
            // and killing it is not harmless: it throws away a part-finished install.
            ...(template.hostPath ? {
              // A TCP probe rather than an HTTP one: what this is waiting for is the dev server
              // binding its port, and asking it for a page instead means knowing which paths it
              // serves and on which scheme, which is the template's business and not the
              // kubelet's.
              startupProbe: {
                tcpSocket:        { port: template.port },
                periodSeconds:    10,
                failureThreshold: 120,
              },
              readinessProbe: { tcpSocket: { port: template.port }, periodSeconds: 10 },
            } : {}),
          }],
          volumes: [
            ...(template.hostPath ? [{
              name:     'work',
              hostPath: { path: `${ template.hostPath }/${ name }`, type: 'DirectoryOrCreate' },
            }] : []),
            { name: 'dev-config', configMap: { name: WORKSPACE_CONFIG_MAP } },
          ],
        },
      },
    },
  };
}

/**
 * Why this name cannot be used right now, or '' when it can.
 *
 * The companion to workspaceNameError, which answers the same question about the shape of a
 * name without asking the cluster. Left to the apiserver, all three cases below come back as
 * one sentence about namespaces, and the most confusing of them (a workspace still being
 * collected, which will free the name shortly) is the one it explains least.
 */
async function workspaceNameConflict(name: string): Promise<string> {
  const namespace = workspaceNamespace(name);

  // The collection rather than a GET of the one namespace, which would be the obvious way to
  // ask. A namespace that is not there answers 404, and the browser prints every 404 to the
  // console whether or not the caller expected it, so the obvious way leaves an error in the
  // log of every successful create. Filtered to the one name, so keeping that quiet costs a
  // request of a couple of hundred bytes rather than a list of every namespace in the
  // cluster. As above the filter is the saving and the `find` is what decides.
  const url = `${ BASE }/v1/namespaces?filter=metadata.name=${ namespace }`;
  const namespaces = await devFetch(url);
  const existing = (namespaces.data || []).find((ns: Json) => ns.metadata?.name === namespace);

  if (!existing) {
    return '';
  }

  if (existing.metadata?.labels?.[LABEL_WORKSPACE] !== name) {
    return `The namespace ${ namespace } already exists and is not a workspace. Pick another name.`;
  }

  if (existing.metadata?.deletionTimestamp) {
    return `A workspace called "${ name }" is still being deleted. Wait for it to finish, or pick another name.`;
  }

  return `A workspace called "${ name }" already exists.`;
}

/**
 * Create a workspace: the namespace, then the Deployment and the Service in it.
 *
 * In that order and awaited, because the other two cannot be created before the namespace
 * exists. Nothing is rolled back if a later step fails: the namespace is left, the list shows
 * the workspace as Creating, and deleting it is one click. Tearing down half a workspace on
 * the user's behalf would be a guess about which half they wanted.
 */
export async function createWorkspace(name: string, templateId: string): Promise<void> {
  const template = templateById(templateId);

  if (!template) {
    throw new Error(`Unknown template "${ templateId }"`);
  }

  // A check, not a guarantee: two people creating the same name at once still race, and the
  // loser gets the apiserver's 409. This is here so the ordinary case, one person picking a
  // name that is taken, reads as a sentence about workspaces rather than one about namespaces.
  const conflict = await workspaceNameConflict(name);

  if (conflict) {
    throw new Error(conflict);
  }

  const namespace = workspaceNamespace(name);
  const labels = { [LABEL_WORKSPACE]: name, [LABEL_TEMPLATE]: template.id };

  await devFetch(`${ BASE }/v1/namespaces`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'Namespace',
      metadata:   { name: namespace, labels },
    }),
  });

  // Before the Deployment, because a pod cannot start with a ServiceAccount that is not there
  // yet, and after the namespace, because that is where most of it lives.
  await ensureWorkspaceRbac(name);

  // The dev server's config, which is the one file a workspace does not get from git. See
  // workspace-config.ts for what is in it and why a clone's own config will not do.
  await devFetch(`${ BASE }/v1/configmaps`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'ConfigMap',
      metadata:   { namespace, name: WORKSPACE_CONFIG_MAP, labels },
      data:       { 'vue.config.js': WORKSPACE_VUE_CONFIG },
    }),
  });

  // Before the Deployment, so the pod's first start already has whatever is in the store. It is
  // rewritten on every start as well, since the store can change after this.
  await ensureGeneratedSecrets(template);
  await mirrorSecrets(name, template);

  await devFetch(`${ BASE }/v1/apps.deployments`, {
    method: 'POST',
    body:   JSON.stringify(deploymentBody(name, template)),
  });

  await devFetch(`${ BASE }/v1/services`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'Service',
      metadata:   { namespace, name: namespace, labels },
      spec:       {
        selector: { app: namespace },
        ports:    [{ name: 'http', port: template.port, targetPort: 'http' }],
      },
    }),
  });
}

/**
 * Start or stop a workspace by scaling its Deployment.
 *
 * Read-modify-write rather than a patch: Steve wants the whole object back on a PUT, and
 * sending the one it just handed out is what keeps the resourceVersion check meaningful, so a
 * second tab scaling the same workspace loses the race instead of silently winning it.
 */
export async function setWorkspaceRunning(name: string, running: boolean): Promise<void> {
  const namespace = workspaceNamespace(name);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ namespace }`;
  const deployment = await devFetch(url);

  if (running) {
    // Every start, not only the first. The pod reads its environment once, when it starts, so
    // this is the only moment a key set since the last start can reach it.
    const template = templateById(deployment.metadata?.labels?.[LABEL_TEMPLATE] || '');

    await mirrorSecrets(name, template);
  }

  deployment.spec.replicas = running ? 1 : 0;

  await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });
}

/**
 * Delete the namespace, which takes the Deployment, the Service and the pod with it.
 *
 * The one thing the namespace does not take is the RoleBinding that let this workspace read the
 * shared credentials, since that lives in the product's own namespace. It is deleted here so a
 * deleted workspace leaves nothing behind that names it.
 */
export async function deleteWorkspace(name: string): Promise<void> {
  const namespace = workspaceNamespace(name);
  const binding = `creds-${ WORKSPACE_SERVICE_ACCOUNT }-${ namespace }`;

  await devFetch(`${ BASE }/v1/namespaces/${ namespace }`, { method: 'DELETE' });
  await devFetch(`${ BASE }/v1/rbac.authorization.k8s.io.rolebindings/${ DEV_SYSTEM_NAMESPACE }/${ binding }`, { method: 'DELETE' }).catch(() => null);
}

/**
 * A running pod in a namespace carrying all of the given labels, or null while there isn't
 * one.
 *
 * A terminal needs a pod by name because exec is a subresource of the pod, not of the
 * Deployment or the Service. `Running` is the bar rather than `Ready`: a pod that is up but
 * failing its probes is exactly the one someone wants a shell in, and the pod this dashboard
 * is served from is not Ready until it has finished compiling, which is minutes.
 *
 * Steve ignores labelSelector (see WORKSPACE_FILTER), so the matching is done here.
 */
export async function findPod(namespace: string, labels: Record<string, string>): Promise<string | null> {
  const pods = await devFetch(`${ BASE }/v1/pods/${ namespace }`).catch(() => null);

  const running = (pods?.data || []).find((pod: Json) => (
    Object.entries(labels).every(([key, value]) => pod.metadata?.labels?.[key] === value) &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

/** The pod running a workspace, or null while there isn't one. */
export function workspacePod(name: string): Promise<string | null> {
  return findPod(workspaceNamespace(name), { [LABEL_WORKSPACE]: name });
}

/**
 * How long each workspace took to become ready, and how often it has restarted.
 *
 * The Deployment records when it last became Available, and the namespace records when the
 * workspace was created, so the difference is the boot this cluster actually delivered. It is
 * the Deployment's own history rather than anything kept here, which is why it survives this
 * page never having been open before.
 */
export async function workspaceReadyTimes(names: string[]): Promise<Record<string, { seconds: number | null; restarts: number }>> {
  if (!names.length) {
    return {};
  }

  const [namespaces, deployments, pods] = await Promise.all([
    devFetch(`${ BASE }/v1/namespaces?${ WORKSPACE_FILTER }`).catch(() => null),
    devFetch(`${ BASE }/v1/apps.deployments?${ WORKSPACE_FILTER }`).catch(() => null),
    devFetch(`${ BASE }/v1/pods?${ WORKSPACE_FILTER }`).catch(() => null),
  ]);

  const createdAt: Record<string, number> = {};
  const out: Record<string, { seconds: number | null; restarts: number }> = {};

  for (const namespace of namespaces?.data || []) {
    const name = namespace.metadata?.labels?.[LABEL_WORKSPACE];

    if (name) {
      createdAt[name] = Date.parse(namespace.metadata.creationTimestamp);
    }
  }

  for (const name of names) {
    out[name] = { seconds: null, restarts: 0 };
  }

  for (const deployment of deployments?.data || []) {
    const name = deployment.metadata?.labels?.[LABEL_WORKSPACE];
    const available = (deployment.status?.conditions || [])
      .find((condition: Json) => condition.type === 'Available' && condition.status === 'True');

    if (name && available && createdAt[name]) {
      const seconds = Math.round((Date.parse(available.lastTransitionTime) - createdAt[name]) / 1000);

      // A workspace that was stopped and started again transitions to Available a second time,
      // which is not a boot from nothing. Only a positive, plausible first interval is kept.
      out[name] = { ...out[name], seconds: seconds > 0 ? seconds : null };
    }
  }

  for (const pod of pods?.data || []) {
    const name = pod.metadata?.labels?.[LABEL_WORKSPACE];
    const restarts = pod.status?.containerStatuses?.[0]?.restartCount || 0;

    if (name && out[name]) {
      out[name] = { ...out[name], restarts };
    }
  }

  return out;
}

/** Warnings from the workspaces' namespaces, newest first. */
export async function workspaceEvents(names: string[]): Promise<Json[]> {
  const results = await Promise.all(names.map((name) => (
    devFetch(`${ BASE }/v1/events/${ workspaceNamespace(name) }`)
      .then((events: Json) => ({ name, events }))
      .catch(() => ({ name, events: { data: [] } }))
  )));

  const out: Json[] = [];

  for (const { name, events } of results) {
    for (const event of events.data || []) {
      // `_type`, not `type`. Steve puts its own schema id in `type` on everything it returns
      // (here, the string "event") and moves the Kubernetes value out to `_type`, so a filter
      // written against `type` matches nothing and the page reports that nothing has gone wrong.
      if (event._type !== 'Warning') {
        continue;
      }

      out.push({
        id:        event.id || `${ name }-${ event.metadata?.name }`,
        workspace: name,
        reason:    event.reason,
        message:   event.message,
        count:     event.count || 1,
        last:      event.lastTimestamp || event.metadata?.creationTimestamp,
      });
    }
  }

  return out.sort((a, b) => Date.parse(b.last) - Date.parse(a.last));
}

/**
 * The last line the workspace's container printed, or '' if there is nothing to read.
 *
 * Asked for only while a workspace is starting, and only by the page that is showing one, since
 * this is the pod's log rather than a summary and a list of them would be a request per row. It
 * is the difference between "Starting up" and knowing it is four minutes into a yarn install.
 */
export async function workspaceLogTail(name: string, pod: string): Promise<string> {
  const namespace = workspaceNamespace(name);
  const url = `${ BASE }/api/v1/namespaces/${ namespace }/pods/${ pod }/log?container=${ WORKSPACE_CONTAINER }&tailLines=1&timestamps=false`;

  try {
    const resp = await fetch(url, { cache: 'no-store' });

    if (!resp.ok) {
      return '';
    }

    return (await resp.text()).trim().split('\n').pop() || '';
  } catch {
    return '';
  }
}

/**
 * A workspace's Service, or null if it has none.
 *
 * Fetched on its own rather than folded into listWorkspaces, because the list has no column
 * for it and the detail page is already fetching the pod. The alternative, describing the
 * Service from the template, is how the detail page came to report a port nothing was
 * listening on.
 */
export async function workspaceService(name: string): Promise<DevService | null> {
  const namespace = workspaceNamespace(name);
  // The namespace's collection rather than the one Service by name, so a workspace that has
  // none (a create that failed after the namespace) answers 200 with nothing in it. Asked
  // for by name it would answer 404, and the detail page asks every five seconds.
  const services = await devFetch(`${ BASE }/v1/services/${ namespace }`).catch(() => null);
  const service = (services?.data || []).find((svc: Json) => svc.metadata?.name === namespace);

  if (!service) {
    return null;
  }

  return {
    name: service.metadata?.name,
    port: service.spec?.ports?.[0]?.port,
  };
}

/**
 * The identities the terminals run as, and the one thing they share.
 *
 * Two ServiceAccounts, deliberately, rather than one that can do everything:
 *
 *   - the global terminal is the product's own tooling. It genuinely needs to see the cluster:
 *     list workspaces, read their pods and logs, and get a shell inside one. It is bound to a
 *     ClusterRole scoped to exactly that and no further, so it is refused secrets, nodes and
 *     RBAC itself.
 *   - a workspace pod runs whatever a template or a person put in it, which is not the product's
 *     code and should not carry the product's rights. It gets its own namespace and nothing
 *     else.
 *
 * The temptation is one cluster-admin token mounted everywhere, because it is one object and it
 * always works. It is also the kind of thing that is only ever noticed later, from the outside.
 *
 * What both sides do share is the claude login, as one Secret in a namespace of this product's
 * own. Each side reaches it through a RoleBinding naming that one Secret by name, rather than by
 * the extension copying the Secret into every workspace: a copy goes stale the moment the token
 * refreshes, and a stale copy of a credential is worse than no copy, because nothing looks
 * wrong until it stops working.
 */
export const DEV_SYSTEM_NAMESPACE = 'dev-system';
export const CREDENTIALS_SECRET = 'claude-credentials';
export const CREDENTIALS_KEY = 'credentials.json';
/** The hand-made Secret the store replaced. Only the migration that folds it in still names it. */
export const GITHUB_SECRET = 'github-token';

/**
 * How a template's own secrets are namespaced inside the one store.
 *
 * The key carries its scope, so one flat Secret holds both kinds without a nested format that
 * has to be parsed: `GH_TOKEN` is global, `rancher.FIGMA_API_KEY` belongs to the rancher
 * template. The prefix is the template's own id rather than a constant, or a second template's
 * key of the same name would be the first one's.
 */
export function templateSecretKey(templateId: string, key: string): string {
  return `${ templateId }.${ key }`;
}

/**
 * Where a workspace and its sidecars read the keys they were given, in their own namespace.
 *
 * Named for the workspace rather than for sidecars because both use it now: a secretKeyRef can
 * only name a Secret in the pod's own namespace, so one mirror per workspace serves everything
 * running in it.
 */
const MIRROR_SECRET = 'dev-secrets';

/** The dev server config a workspace boots with, in the workspace's own namespace. */
const WORKSPACE_CONFIG_MAP = 'dev-workspace-config';

/** Where the dev server's pod lives, which is the pod the global terminals attach to. */
const DEV_POD_NAMESPACE = 'magic-closet';
export const GLOBAL_SERVICE_ACCOUNT = 'dev-global-terminal';

/** The ServiceAccount every workspace pod runs as, one per workspace namespace. */
export const WORKSPACE_SERVICE_ACCOUNT = 'dev-workspace';

/** Create if it is not there; leave it alone if it is. */
async function ensure(type: string, namespace: string | null, name: string, body: Json): Promise<void> {
  const path = namespace ? `${ BASE }/v1/${ type }/${ namespace }/${ name }` : `${ BASE }/v1/${ type }/${ name }`;
  const existing = await devFetch(path).catch(() => null);

  if (existing) {
    return;
  }

  await devFetch(`${ BASE }/v1/${ type }`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
}

/**
 * Let one ServiceAccount read and write the shared credentials Secret, and nothing else in that
 * namespace.
 *
 * `resourceNames` is what keeps this to the one Secret: without it this would be read access to
 * every Secret in the namespace, which today is the same thing and tomorrow is not.
 */
function credentialsRoleBinding(name: string, namespace: string): Json {
  return {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'RoleBinding',
    metadata:   { namespace: DEV_SYSTEM_NAMESPACE, name: `creds-${ name }-${ namespace }` },
    roleRef:    {
      apiGroup: 'rbac.authorization.k8s.io', kind: 'Role', name: CREDENTIALS_SECRET
    },
    subjects: [{ kind: 'ServiceAccount', name, namespace }],
  };
}

/**
 * The ServiceAccounts, roles and bindings the terminals need.
 *
 * Idempotent and create-if-missing, the way everything else this extension puts in the cluster
 * is, and it swallows its own failures: it runs for every user on every load, including ones
 * with no rights to create RBAC, and an extension that throws here would take the product down
 * for them.
 */
export async function ensureDevRbac(): Promise<void> {
  await ensure('namespaces', null, DEV_SYSTEM_NAMESPACE, {
    apiVersion: 'v1',
    kind:       'Namespace',
    metadata:   { name: DEV_SYSTEM_NAMESPACE },
  });

  // Created empty, and only ever written by a pod pushing a token it already had. It exists up
  // front so that the Role below can name it, which is what lets the Role be about one Secret
  // rather than about all of them.
  await ensure('secrets', DEV_SYSTEM_NAMESPACE, CREDENTIALS_SECRET, {
    apiVersion: 'v1',
    kind:       'Secret',
    metadata:   { namespace: DEV_SYSTEM_NAMESPACE, name: CREDENTIALS_SECRET },
    type:       'Opaque',
  });

  // Nothing ensures the old `github-token` Secret any more. It is what the store replaced, and
  // an extension that recreated it on load would put an empty one back the moment the migration
  // deleted it, leaving two places a GitHub token could live for ever.

  await ensure('rbac.authorization.k8s.io.roles', DEV_SYSTEM_NAMESPACE, CREDENTIALS_SECRET, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'Role',
    metadata:   { namespace: DEV_SYSTEM_NAMESPACE, name: CREDENTIALS_SECRET },
    rules:      [{
      apiGroups:     [''],
      resources:     ['secrets'],
      resourceNames: [CREDENTIALS_SECRET],
      verbs:         ['get', 'update', 'patch'],
    }],
  });

  await ensure('serviceaccounts', DEV_POD_NAMESPACE, GLOBAL_SERVICE_ACCOUNT, {
    apiVersion: 'v1',
    kind:       'ServiceAccount',
    metadata:   { namespace: DEV_POD_NAMESPACE, name: GLOBAL_SERVICE_ACCOUNT },
  });

  await ensure('rbac.authorization.k8s.io.clusterroles', null, GLOBAL_SERVICE_ACCOUNT, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRole',
    metadata:   { name: GLOBAL_SERVICE_ACCOUNT },
    rules:      [
      // Workspaces are namespaces, so creating and deleting one is creating and deleting a
      // namespace. This is the widest rule here and it is the product's actual job.
      {
        apiGroups: [''], resources: ['namespaces'], verbs: ['get', 'list', 'watch', 'create', 'delete']
      },
      {
        apiGroups: ['apps'],
        resources: ['deployments', 'deployments/scale', 'replicasets'],
        verbs:     ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: [''],
        resources: ['services', 'configmaps', 'serviceaccounts'],
        verbs:     ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete'],
      },
      {
        apiGroups: [''], resources: ['pods', 'pods/log', 'events'], verbs: ['get', 'list', 'watch']
      },
      // A shell in a workspace, which is a create on the pod's exec subresource rather than
      // anything that reads like "exec".
      {
        apiGroups: [''], resources: ['pods/exec'], verbs: ['create', 'get']
      },
    ],
  });

  await ensure('rbac.authorization.k8s.io.clusterrolebindings', null, GLOBAL_SERVICE_ACCOUNT, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'ClusterRoleBinding',
    metadata:   { name: GLOBAL_SERVICE_ACCOUNT },
    roleRef:    {
      apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: GLOBAL_SERVICE_ACCOUNT
    },
    subjects: [{ kind: 'ServiceAccount', name: GLOBAL_SERVICE_ACCOUNT, namespace: DEV_POD_NAMESPACE }],
  });

  const binding = credentialsRoleBinding(GLOBAL_SERVICE_ACCOUNT, DEV_POD_NAMESPACE);

  await ensure('rbac.authorization.k8s.io.rolebindings', DEV_SYSTEM_NAMESPACE, binding.metadata.name, binding);
}

/**
 * The ServiceAccount a workspace's pod runs as: its own namespace, and the shared login.
 *
 * Created with the workspace rather than by ensureDevRbac, because it is per workspace and the
 * namespace it lives in does not exist until the workspace does.
 */
async function ensureWorkspaceRbac(name: string): Promise<void> {
  const namespace = workspaceNamespace(name);

  await ensure('serviceaccounts', namespace, WORKSPACE_SERVICE_ACCOUNT, {
    apiVersion: 'v1',
    kind:       'ServiceAccount',
    metadata:   { namespace, name: WORKSPACE_SERVICE_ACCOUNT },
  });

  // Whatever the workspace runs can manage the workspace's own namespace. It is a sandbox, and
  // this is the edge of it: `edit` is Kubernetes' own aggregated role for exactly this, so the
  // rules do not have to be maintained here as the API grows.
  await ensure('rbac.authorization.k8s.io.rolebindings', namespace, WORKSPACE_SERVICE_ACCOUNT, {
    apiVersion: 'rbac.authorization.k8s.io/v1',
    kind:       'RoleBinding',
    metadata:   { namespace, name: WORKSPACE_SERVICE_ACCOUNT },
    roleRef:    {
      apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'edit'
    },
    subjects: [{ kind: 'ServiceAccount', name: WORKSPACE_SERVICE_ACCOUNT, namespace }],
  });

  const binding = credentialsRoleBinding(WORKSPACE_SERVICE_ACCOUNT, namespace);

  await ensure('rbac.authorization.k8s.io.rolebindings', DEV_SYSTEM_NAMESPACE, binding.metadata.name, binding);
}

/**
 * base64 of the UTF-8 bytes, which is what a Kubernetes Secret holds.
 *
 * `btoa` is defined over Latin-1 and throws a DOMException on anything outside it, so a pasted
 * token or a password with one non-Latin1 character in it would take the whole Save with it, and
 * the error it throws says nothing about which field caused it.
 */
function encodeSecret(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function decodeSecret(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));

  return new TextDecoder().decode(bytes);
}

/**
 * A Secret's data, decoded, or null when it is not there or cannot be read.
 *
 * Through Steve on the browser's own session, so what comes back is what this user is allowed
 * to see. Nothing here returns a token to anywhere it could be displayed: the callers take the
 * one field they need and the pages show identities rather than credentials.
 */
async function readSecret(name: string): Promise<Record<string, string> | null> {
  const secret = await devFetch(`${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ name }`).catch(() => null);

  if (!secret) {
    return null;
  }

  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(secret.data || {})) {
    out[key] = value ? decodeSecret(value as string) : '';
  }

  return out;
}

/**
 * The GitHub token, for the caller to send. Never rendered and never logged.
 *
 * Out of the one store rather than the hand-made `github-token` Secret that used to hold it: the
 * migration folded that one in as `GH_TOKEN` and deleted it, so there is one place a secret
 * lives. See migrateGithubToken.
 */
export async function githubToken(): Promise<string> {
  return secretValue('GH_TOKEN');
}

/** What the shared claude login is, without the tokens: enough to say whose it is. */
export interface ClaudeIdentity {
  subscriptionType: string;
  expiresAt: number;
  scopes: string[];
}

export async function claudeIdentity(): Promise<ClaudeIdentity | null> {
  const data = await readSecret(CREDENTIALS_SECRET);

  if (!data?.[CREDENTIALS_KEY]) {
    return null;
  }

  try {
    const oauth = JSON.parse(data[CREDENTIALS_KEY])?.claudeAiOauth;

    if (!oauth?.accessToken) {
      return null;
    }

    return {
      subscriptionType: oauth.subscriptionType || 'unknown',
      expiresAt:        Number(oauth.expiresAt) || 0,
      scopes:           oauth.scopes || [],
    };
  } catch {
    return null;
  }
}

/**
 * Whether the dev server's pod is running as the ServiceAccount the global terminals need.
 *
 * A pod takes its ServiceAccount at start, so setting one on the Deployment restarts the pod,
 * and that pod is the one someone has a terminal in. So the extension does not do it: this
 * reports the state and Settings offers it as something to do deliberately.
 */
export async function devPodServiceAccount(): Promise<{ current: string; wanted: string }> {
  const deployment = await devFetch(`${ BASE }/v1/apps.deployments/${ DEV_POD_NAMESPACE }/magic-closet-dev-extension`).catch(() => null);

  return {
    current: deployment?.spec?.template?.spec?.serviceAccountName || 'default',
    wanted:  GLOBAL_SERVICE_ACCOUNT,
  };
}

/**
 * Put the global terminal's ServiceAccount on the dev server's Deployment.
 *
 * This restarts the pod, which is why nothing calls it on its own. Everything in the pod's
 * `/app` survives (it is a volume), but a tmux session does not, and neither does an install
 * that is part way through.
 */
export async function setDevPodServiceAccount(): Promise<void> {
  const url = `${ BASE }/v1/apps.deployments/${ DEV_POD_NAMESPACE }/magic-closet-dev-extension`;
  const deployment = await devFetch(url);

  deployment.spec.template.spec.serviceAccountName = GLOBAL_SERVICE_ACCOUNT;

  await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });
}

/**
 * The one Secret this extension keeps, per user.
 *
 * Named and labelled with the owning Rancher user, following the secret sets in the
 * magic-closet extension (listSecretSets and friends), which already solved this: the principal
 * comes from /v3/users?me=true, is sanitised to something a Kubernetes name accepts, and goes in
 * the name and in a label. Per-user costs the same to write as shared and cannot be retrofitted
 * without migrating whatever a shared one has accumulated, so it is per-user from the start,
 * with one user in this cluster today.
 *
 * Keys are flat and carry their own scope: `GH_TOKEN` is global, `rancher.FIGMA_API_KEY`
 * belongs to the rancher template. One Secret holds both without a nested format to parse.
 */
const SECRET_KIND_LABEL = 'dev.rancher.io/kind';
const SECRET_OWNER_LABEL = 'dev.rancher.io/owner';

let secretOwner = '';

/**
 * A principal id, as something a Secret name can end with.
 *
 * The trim is after the truncation as well as before it: a principal cut at forty characters can
 * land on a dash or a dot, and a name that ends in one is rejected by the apiserver with a
 * message about RFC 1123 that says nothing about which user it could not name.
 */
function sanitiseOwner(value: string): string {
  return (value || 'anonymous')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .slice(0, 40)
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '') || 'anonymous';
}

/** Who is asking, from Rancher's own answer, cached for the life of the page. */
export async function currentOwner(): Promise<string> {
  if (secretOwner) {
    return secretOwner;
  }

  const me = await devFetch('/v3/users?me=true').catch(() => null);
  const principal = me?.data?.[0]?.principalIds?.[0] || me?.data?.[0]?.id || '';

  secretOwner = sanitiseOwner(principal);

  return secretOwner;
}

async function secretStoreName(): Promise<string> {
  return `dev-secrets-${ await currentOwner() }`;
}

/** The store as it is, or an empty one. Values included, since the caller is the browser. */
async function readSecretStore(): Promise<Record<string, string>> {
  const name = await secretStoreName();
  const secret = await devFetch(`${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ name }`).catch(() => null);
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(secret?.data || {})) {
    out[key] = value ? decodeSecret(value as string) : '';
  }

  return out;
}

/**
 * Which keys are set, and nothing else.
 *
 * This is what Settings and the sidecar cards ask, because neither of them has any business
 * with the value: a stored secret is never rendered back, only replaced or cleared.
 */
export async function setSecretKeys(): Promise<string[]> {
  const store = await readSecretStore();

  return Object.entries(store).filter(([, value]) => !!value).map(([key]) => key);
}

/** One value, for the browser to use at the point of use. Never rendered, never logged. */
export async function secretValue(key: string): Promise<string> {
  return (await readSecretStore())[key] || '';
}

/**
 * Write only the keys that changed.
 *
 * A key whose field was left alone is not in `changes` and is not touched, which is what stops
 * opening Settings and saving from blanking a value nobody could see. A key set to '' is a
 * deliberate clear.
 */
export async function saveSecrets(changes: Record<string, string>): Promise<void> {
  if (!Object.keys(changes).length) {
    return;
  }

  const name = await secretStoreName();
  const url = `${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ name }`;
  const existing = await devFetch(url).catch(() => null);
  const data: Record<string, string> = { ...(existing?.data || {}) };

  for (const [key, value] of Object.entries(changes)) {
    if (value === '') {
      delete data[key];
    } else {
      data[key] = encodeSecret(value);
    }
  }

  const body = {
    apiVersion: 'v1',
    kind:       'Secret',
    type:       'Opaque',
    metadata:   {
      namespace: DEV_SYSTEM_NAMESPACE,
      name,
      labels:    { [SECRET_KIND_LABEL]: 'secrets', [SECRET_OWNER_LABEL]: await currentOwner() },
    },
    data,
  };

  if (existing) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data: body.data, metadata: { ...existing.metadata, labels: body.metadata.labels } }) });
  } else {
    await devFetch(`${ BASE }/v1/secrets`, { method: 'POST', body: JSON.stringify(body) });
  }
}

/**
 * A password nobody has to think of, made once and then kept.
 *
 * The chart does this with `randAlphaNum 15` and a `lookup` that reuses whatever the last install
 * generated, and the reason is the same here: an admin password written into the code as
 * `admin`/`admin` is a literal credential in the repo, and one regenerated on every start is one
 * nobody can write down. Alphanumeric only, because these end up typed into a login form.
 */
const GENERATED_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generatedValue(length = 15): string {
  const bytes = new Uint8Array(length);

  window.crypto.getRandomValues(bytes);

  return [...bytes].map((byte) => GENERATED_ALPHABET[byte % GENERATED_ALPHABET.length]).join('');
}

/**
 * Fill in any declared secret the product generates for itself, once.
 *
 * Only the ones that are missing, so a password that has already been generated is the password
 * it stays, which is the property `lookup` gives the chart: something that has been used to log
 * in once goes on working.
 */
export async function ensureGeneratedSecrets(template: DevTemplate | undefined): Promise<void> {
  const declared = [
    ...GLOBAL_SECRETS.map((secret) => ({ secret, key: secret.key })),
    ...(template?.secrets || []).map((secret) => ({ secret, key: templateSecretKey(template!.id, secret.key) })),
  ].filter(({ secret }) => secret.generated);

  if (!declared.length) {
    return;
  }

  const store = await readSecretStore();
  const changes: Record<string, string> = {};

  for (const { key } of declared) {
    if (!store[key]) {
      changes[key] = generatedValue();
    }
  }

  await saveSecrets(changes);
}

/**
 * Copy the keys this workspace is entitled to into the workspace's own namespace.
 *
 * A secretKeyRef can only name a Secret in the pod's own namespace, and the store is one Secret
 * per user in this product's namespace, so the values have to be mirrored. What a pod spec
 * carries either way is the reference, which is the property that matters: `kubectl get deploy
 * -o yaml` shows a name and a key rather than a token.
 *
 * Rewritten every time anything here is started, not only when the workspace is created. A key
 * set in Settings after the workspace was made would otherwise never reach it, and because the
 * references are `optional` the pod would come up without it and say nothing.
 *
 * The mirror lands in a namespace where the workspace's own ServiceAccount holds `edit`, so
 * anyone with a shell in the workspace can read these values. That is deliberate rather than
 * overlooked: they are that workspace's credentials, and the code they are for is what runs
 * there. A secret that must not be readable by the workspace does not belong in its template.
 */
async function mirrorSecrets(workspace: string, template: DevTemplate | undefined): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const store = await readSecretStore();
  const mirrored: Record<string, string> = {};

  // Global keys keep their name. A template's keys lose the template prefix on the way in, since
  // inside the workspace there is only one template and `rancher.FIGMA_API_KEY` is not a name an
  // environment variable can have.
  for (const secret of GLOBAL_SECRETS) {
    if (store[secret.key]) {
      mirrored[secret.key] = encodeSecret(store[secret.key]);
    }
  }

  for (const secret of template?.secrets || []) {
    const value = store[templateSecretKey(template!.id, secret.key)];

    if (value) {
      mirrored[secret.key] = encodeSecret(value);
    }
  }

  const url = `${ BASE }/v1/secrets/${ namespace }/${ MIRROR_SECRET }`;
  const existing = await devFetch(url).catch(() => null);

  if (existing) {
    await devFetch(url, { method: 'PUT', body: JSON.stringify({ ...existing, data: mirrored }) });

    return;
  }

  await devFetch(`${ BASE }/v1/secrets`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'v1',
      kind:       'Secret',
      type:       'Opaque',
      metadata:   { namespace, name: MIRROR_SECRET, labels: { [LABEL_WORKSPACE]: workspace } },
      data:       mirrored,
    }),
  });
}

/**
 * Fold the hand-made github-token Secret into the store, once.
 *
 * It was injected by hand before there was a store. Moving it means there is one place a secret
 * lives rather than two, and the one-off is deleted so nothing reads the stale copy later.
 */
export async function migrateGithubToken(): Promise<void> {
  const legacy = await devFetch(`${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ GITHUB_SECRET }`).catch(() => null);
  const token = legacy?.data?.token ? decodeSecret(legacy.data.token) : '';

  if (!token) {
    return;
  }

  const already = await secretValue('GH_TOKEN');

  if (!already) {
    await saveSecrets({ GH_TOKEN: token });
  }

  await devFetch(`${ BASE }/v1/secrets/${ DEV_SYSTEM_NAMESPACE }/${ GITHUB_SECRET }`, { method: 'DELETE' }).catch(() => null);
}

/** A sidecar as it exists in the cluster, joined to what the template declared. */
export interface DevSidecarState {
  id: string;
  state: WorkspaceState;
  /** Keys the sidecar declared that are not in the secret store. */
  missing: string[];
  /**
   * What the cluster says about it, when there is something to say.
   *
   * The card showed Starting for every kind of failure before this existed, including the ones
   * where no pod is ever created and so nothing has a log to read. This is the pod's own reason
   * or the controller's, whichever there is.
   */
  detail: string;
}

const LABEL_SIDECAR = 'dev.rancher.io/sidecar';

function sidecarName(workspace: string, id: string): string {
  return `${ workspaceNamespace(workspace) }-${ id }`;
}

/** Every declared sidecar's state in one workspace, whether or not it has ever been started. */
export async function listSidecars(workspace: string, sidecars: DevSidecar[], template?: DevTemplate): Promise<Record<string, DevSidecarState>> {
  const namespace = workspaceNamespace(workspace);
  const [deployments, pods, keys] = await Promise.all([
    devFetch(`${ BASE }/v1/apps.deployments/${ namespace }`).catch(() => null),
    devFetch(`${ BASE }/v1/pods/${ namespace }`).catch(() => null),
    setSecretKeys().catch(() => [] as string[]),
  ]);

  const out: Record<string, DevSidecarState> = {};

  for (const sidecar of sidecars) {
    const name = sidecarName(workspace, sidecar.id);
    const deployment = (deployments?.data || []).find((candidate: Json) => candidate.metadata?.name === name);
    const pod = (pods?.data || []).find((candidate: Json) => candidate.metadata?.labels?.[LABEL_SIDECAR] === sidecar.id);

    out[sidecar.id] = {
      id:    sidecar.id,
      // A sidecar that has never been started has no Deployment, which is 'stopped' rather than
      // anything more dramatic: it is declared, and starting it is what creates it.
      state:   deployment ? stateOf({ metadata: {} }, deployment, pod) : 'stopped',
      missing: missingSecrets(sidecar, template, keys),
      detail:  podDetail(pod) || (pod ? '' : replicaFailure(deployment)),
    };
  }

  return out;
}

/**
 * The keys this sidecar needs that the store does not have.
 *
 * The template is what says how a key is named in the store, so a sidecar declaring
 * `FIGMA_API_KEY` on the rancher template is asking about `rancher.FIGMA_API_KEY`. Without the
 * template there is no way to name the key, and answering "nothing is missing" would be a
 * guess, so the declaration is reported as missing instead.
 */
function missingSecrets(sidecar: DevSidecar, template: DevTemplate | undefined, keys: string[]): string[] {
  return (sidecar.secrets || []).filter((key) => {
    // A generated secret is never missing, whatever the store holds: starting the sidecar is what
    // creates it. Counting it as missing would disable the only control that could fill it in.
    if ((template?.secrets || []).find((secret) => secret.key === key)?.generated) {
      return false;
    }

    return !template || !keys.includes(templateSecretKey(template.id, key));
  });
}

/**
 * Start a sidecar, creating it the first time.
 *
 * Three things happen before either path, and all three have to happen on both, which is what
 * the version that only did them on create got wrong:
 *
 *   - the ServiceAccount. A workspace created before this product had one has no `dev-workspace`
 *     in its namespace, and a Deployment naming one that does not exist never produces a pod at
 *     all: the ReplicaSet is refused, and the card reads Starting for ever with nothing to read.
 *   - the generated secrets, so an admin password exists before something asks for it.
 *   - the mirror, because the pod reads its environment when it starts, and a key set in Settings
 *     since the last start reaches it at this moment or not at all.
 *
 * The values arrive by reference either way, so `kubectl get deploy -o yaml` shows a Secret name
 * and a key rather than a token.
 */
export async function startSidecar(workspace: string, sidecar: DevSidecar, template: DevTemplate): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const name = sidecarName(workspace, sidecar.id);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ name }`;

  await ensureWorkspaceRbac(workspace);
  await ensureGeneratedSecrets(template);

  // Refused rather than started without it. The reference is `optional`, so a sidecar started
  // without a key it declared comes up, answers nothing and looks healthy, which is the failure
  // this is here to make impossible. The card disables Start for the same reason; this is the
  // half that a second tab or a stale page cannot get around.
  const keys = await setSecretKeys();
  const missing = missingSecrets(sidecar, template, keys)
    .filter((key) => (template.secrets || []).find((secret) => secret.key === key)?.required !== false);

  if (missing.length) {
    throw new Error(`${ sidecar.label } needs ${ missing.join(', ') }, which is not set. Set it in Settings first.`);
  }

  await mirrorSecrets(workspace, template);

  const existing = await devFetch(url).catch(() => null);

  if (existing) {
    existing.spec.replicas = 1;
    await devFetch(url, { method: 'PUT', body: JSON.stringify(existing) });

    return;
  }

  const wanted = sidecar.secrets || [];
  const labels = { app: name, [LABEL_WORKSPACE]: workspace, [LABEL_SIDECAR]: sidecar.id };

  await devFetch(`${ BASE }/v1/apps.deployments`, {
    method: 'POST',
    body:   JSON.stringify({
      apiVersion: 'apps/v1',
      kind:       'Deployment',
      metadata:   { namespace, name, labels },
      spec:       {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        // Recreate rather than RollingUpdate, as the chart has it for the same containers. A
        // sidecar is one instance of one thing, often holding a port or a directory, and during a
        // rolling update there are two of them: the card would read the older pod's state and
        // report Running while the new one cannot start at all.
        strategy: { type: 'Recreate' },
        template: {
          metadata: { labels },
          spec:     {
            serviceAccountName: WORKSPACE_SERVICE_ACCOUNT,
            containers:         [{
              name:  'sidecar',
              image: sidecar.image,
              ...(sidecar.command ? { command: sidecar.command } : {}),
              ...(sidecar.args ? { args: sidecar.args } : {}),
              ...(sidecar.port ? { ports: [{ name: 'http', containerPort: sidecar.port }] } : {}),
              env: [
                ...Object.entries(sidecar.env || {}).map(([envName, value]) => ({ name: envName, value })),
                // By reference, never by value: the token is not in the pod spec, so it is not
                // in `kubectl get deploy -o yaml` either.
                ...wanted.map((key) => ({
                  name:      key,
                  valueFrom: { secretKeyRef: { name: MIRROR_SECRET, key, optional: true } },
                })),
                // The same values under whatever name the image actually reads. See secretEnv.
                ...Object.entries(sidecar.secretEnv || {}).map(([envName, key]) => ({
                  name:      envName,
                  valueFrom: { secretKeyRef: { name: MIRROR_SECRET, key, optional: true } },
                })),
              ],
            }],
          },
        },
      },
    }),
  });

  if (sidecar.port) {
    const serviceUrl = `${ BASE }/v1/services/${ namespace }/${ name }`;
    const service = await devFetch(serviceUrl).catch(() => null);

    if (!service) {
      await devFetch(`${ BASE }/v1/services`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'Service',
          metadata:   { namespace, name, labels },
          spec:       { selector: { app: name }, ports: [{ name: 'http', port: sidecar.port, targetPort: 'http' }] },
        }),
      });
    }
  }
}

/**
 * Stop a sidecar by scaling it to nothing, leaving it declared and restartable.
 *
 * Its Service is left behind on purpose: a stopped sidecar keeps the address it will answer on
 * again, so a link to it is still the right link, and a Service with nothing behind it routes
 * nowhere rather than somewhere wrong. The mirrored Secret is left for a different reason, which
 * is that it is the workspace's rather than this sidecar's; both go when the namespace does.
 */
export async function stopSidecar(workspace: string, id: string): Promise<void> {
  const namespace = workspaceNamespace(workspace);
  const url = `${ BASE }/v1/apps.deployments/${ namespace }/${ sidecarName(workspace, id) }`;
  const deployment = await devFetch(url).catch(() => null);

  if (!deployment) {
    return;
  }

  deployment.spec.replicas = 0;
  await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });
}

/** Where a sidecar's own UI is served, on Rancher's origin, the same door a workspace uses. */
export function sidecarProxyUrl(workspace: string, sidecar: DevSidecar): string {
  const namespace = workspaceNamespace(workspace);

  return `${ BASE }/api/v1/namespaces/${ namespace }/services/http:${ sidecarName(workspace, sidecar.id) }:${ sidecar.port }/proxy/`;
}

/** One entry in a workspace's Service. */
export interface DevPort {
  name: string;
  port: number;
}

/** Kubernetes' own limit on a Service port name, which is a DNS label of at most 15 characters. */
const PORT_NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const MAX_PORT_NAME_LENGTH = 15;

/**
 * Every port a workspace's Service carries.
 *
 * The template's port is the first of these rather than a special case, which is what makes
 * "the port a workspace serves on" a list rather than a fact: a workspace can be running a dev
 * server, an app and a debugger, and the harness's answer to that is a route per port.
 */
export async function listWorkspacePorts(name: string): Promise<DevPort[]> {
  const namespace = workspaceNamespace(name);
  const services = await devFetch(`${ BASE }/v1/services/${ namespace }`).catch(() => null);
  const service = (services?.data || []).find((svc: Json) => svc.metadata?.name === namespace);

  return (service?.spec?.ports || []).map((port: Json) => ({
    name: port.name || '',
    port: port.port,
  }));
}

/** Why a port cannot be added, or '' when it can. */
export function portError(port: number, existing: DevPort[]): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return 'A port is a number between 1 and 65535';
  }

  if (existing.some((entry) => entry.port === port)) {
    return `This workspace already serves port ${ port }`;
  }

  return '';
}

/**
 * A name for a port that Kubernetes will accept.
 *
 * Every port in a Service with more than one has to be named, and the name is a DNS label, so
 * `8080` on its own is not one. `p8080` is, and it is derived rather than asked for: a name is
 * something Kubernetes needs and nobody using this has an opinion about.
 */
function portName(port: number): string {
  const name = `p${ port }`;

  return PORT_NAME_PATTERN.test(name) && name.length <= MAX_PORT_NAME_LENGTH ? name : `p${ port }`.slice(0, MAX_PORT_NAME_LENGTH);
}

/**
 * Add or remove a port on a workspace's Service.
 *
 * Read-modify-write through Steve, the same shape as scaling a Deployment, so a second tab
 * editing the same Service loses the resourceVersion check rather than silently winning it.
 *
 * This does not touch the pod. A Service is a set of routing rules in front of whatever the
 * pod already listens on, so adding a port here publishes something that is already there and
 * removing one takes the route away rather than the server. Whether anything answers on it is
 * a separate question, which is why the ports list asks it separately.
 */
async function editWorkspacePorts(name: string, edit: (ports: Json[]) => Json[]): Promise<void> {
  const namespace = workspaceNamespace(name);
  const url = `${ BASE }/v1/services/${ namespace }/${ namespace }`;
  const service = await devFetch(url);

  service.spec.ports = edit(service.spec.ports || []);

  await devFetch(url, { method: 'PUT', body: JSON.stringify(service) });
}

export function addWorkspacePort(name: string, port: number): Promise<void> {
  return editWorkspacePorts(name, (ports) => [
    ...ports,
    // targetPort is the number rather than a named port: a name only exists if the
    // Deployment's container declared it, and a port added after the fact has not been.
    {
      name: portName(port), port, targetPort: port, protocol: 'TCP'
    },
  ]);
}

export function removeWorkspacePort(name: string, port: number): Promise<void> {
  return editWorkspacePorts(name, (ports) => ports.filter((entry) => entry.port !== port));
}

/**
 * Where a workspace's own server is served, on Rancher's origin.
 *
 * The Kubernetes apiserver's service proxy, which is the same door the dev server this
 * dashboard is served through comes out of. Root-relative on purpose: the browser resolves it
 * against whatever host Rancher is on, so nothing here ever learns or hardcodes a hostname,
 * and the URL works for anyone whose Rancher session can reach the namespace.
 *
 * `http:` is the scheme the proxy should speak to the Service in, not part of its name.
 */
export function workspaceProxyUrl(name: string, port: number, scheme = 'http'): string {
  const namespace = workspaceNamespace(name);

  return `${ BASE }/api/v1/namespaces/${ namespace }/services/${ scheme }:${ namespace }:${ port }/proxy/`;
}

/**
 * Whether anything is answering on that port yet.
 *
 * A workspace can be Running with nothing listening: the image is still starting, the server
 * inside it is still compiling, or the template's command is wrong. The proxy's own answer to
 * that is a 503 with a Kubernetes Status in it, and framing that is how a page ends up
 * showing someone an apiserver error page and calling it their app.
 *
 * Only the proxy's own failures count as not serving. A 404 or a 500 from the workspace is the
 * workspace answering, which is something to show rather than something to wait through.
 */
export async function workspaceServing(name: string, port: number, scheme = 'http'): Promise<boolean> {
  try {
    const resp = await fetch(workspaceProxyUrl(name, port, scheme), { cache: 'no-store' });

    return ![502, 503, 504].includes(resp.status);
  } catch {
    // A network-level failure, which here means the request never reached Rancher.
    return false;
  }
}

/**
 * WebSocket URL for running a command in a pod, on a TTY.
 *
 * This is the Kubernetes exec subresource, the same one the dashboard's own container shell
 * uses, so it carries the browser's Rancher session and needs nothing else to authenticate.
 * The protocol is `base64.channel.k8s.io`: every frame is a channel digit (0 stdin, 1 stdout,
 * 2 stderr, 3 error, 4 resize) followed by base64.
 */
export function podExecUrl(namespace: string, pod: string, container: string, command: string[]): string {
  const origin = window.location.origin.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    container,
    stdin:  '1',
    stdout: '1',
    stderr: '1',
    tty:    '1',
  });

  // Repeated, not comma-joined: this is argv.
  for (const arg of command) {
    params.append('command', arg);
  }

  return `${ origin }${ BASE }/api/v1/namespaces/${ namespace }/pods/${ pod }/exec?${ params }`;
}

/**
 * What a workspace's terminal runs.
 *
 * It asks for bash and settles for sh, because the templates are not all the same
 * distribution and a hardcoded /bin/bash would fail on busybox with an error the terminal can
 * only show as a closed connection. There is no tmux in here, which is why a workspace's shell
 * does not survive being closed: that is a property of the image, and it is what the workspace
 * templates will fix.
 */
export const WORKSPACE_SHELL_COMMAND = [
  '/bin/sh',
  '-c',
  'TERM=xterm-256color; export TERM; [ -x /bin/bash ] && exec /bin/bash || exec /bin/sh',
];

/** WebSocket URL for a shell in a workspace's pod. */
export function workspaceShellUrl(name: string, pod: string): string {
  return podExecUrl(workspaceNamespace(name), pod, WORKSPACE_CONTAINER, WORKSPACE_SHELL_COMMAND);
}
