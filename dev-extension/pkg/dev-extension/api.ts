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
import { templateById, DevTemplate } from './templates';

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

export type WorkspaceState = 'running' | 'stopped' | 'starting' | 'creating' | 'removing';

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

function stateOf(namespace: Json, deployment: Json | undefined): WorkspaceState {
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

  return (deployment.status?.readyReplicas ?? 0) > 0 ? 'running' : 'starting';
}

/**
 * A workspace, out of the namespace that records it and the Deployment that runs it.
 *
 * One function for both readers, so the list and the detail page cannot come to describe the
 * same workspace differently while fetching it two different ways.
 */
function workspaceFrom(namespace: Json, deployment: Json | undefined): DevWorkspace {
  const name = namespace.metadata.labels[LABEL_WORKSPACE];
  const template = namespace.metadata.labels[LABEL_TEMPLATE] || '';

  return {
    name,
    namespace:     namespace.metadata.name,
    template,
    templateLabel: templateById(template)?.label || template || 'Unknown',
    state:         stateOf(namespace, deployment),
    createdAt:     namespace.metadata.creationTimestamp,
    image:         deployment?.spec?.template?.spec?.containers?.[0]?.image || '',
    replicas:      deployment?.spec?.replicas ?? 0,
    ready:         deployment?.status?.readyReplicas ?? 0,
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
  const [namespaces, deployments] = await Promise.all([
    devFetch(`${ BASE }/v1/namespaces?${ WORKSPACE_FILTER }`),
    devFetch(`${ BASE }/v1/apps.deployments?${ WORKSPACE_FILTER }`),
  ]);

  const byWorkspace = new Map<string, Json>();

  for (const deployment of deployments.data || []) {
    const workspace = deployment.metadata?.labels?.[LABEL_WORKSPACE];

    if (workspace) {
      byWorkspace.set(workspace, deployment);
    }
  }

  return (namespaces.data || [])
    .filter((namespace: Json) => !!namespace.metadata?.labels?.[LABEL_WORKSPACE])
    .map((namespace: Json) => {
      const name = namespace.metadata.labels[LABEL_WORKSPACE];

      return workspaceFrom(namespace, byWorkspace.get(name));
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
  const [record, deployments] = await Promise.all([
    devFetch(`${ BASE }/v1/namespaces/${ namespace }`).catch(() => null),
    devFetch(`${ BASE }/v1/apps.deployments/${ namespace }`).catch(() => null),
  ]);

  // A namespace without the label is not a workspace, whatever it is called.
  if (record?.metadata?.labels?.[LABEL_WORKSPACE] !== name) {
    return null;
  }

  const deployment = (deployments?.data || [])
    .find((candidate: Json) => candidate.metadata?.labels?.[LABEL_WORKSPACE] === name);

  return workspaceFrom(record, deployment);
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
      template: {
        metadata: { labels },
        spec:     {
          containers: [{
            name:  WORKSPACE_CONTAINER,
            image: template.image,
            ...(template.command ? { command: template.command } : {}),
            ports: [{ name: 'http', containerPort: template.port }],
          }],
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

  deployment.spec.replicas = running ? 1 : 0;

  await devFetch(url, { method: 'PUT', body: JSON.stringify(deployment) });
}

/** Delete the namespace, which takes the Deployment, the Service and the pod with it. */
export async function deleteWorkspace(name: string): Promise<void> {
  await devFetch(`${ BASE }/v1/namespaces/${ workspaceNamespace(name) }`, { method: 'DELETE' });
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
export function workspaceProxyUrl(name: string, port: number): string {
  const namespace = workspaceNamespace(name);

  return `${ BASE }/api/v1/namespaces/${ namespace }/services/http:${ namespace }:${ port }/proxy/`;
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
export async function workspaceServing(name: string, port: number): Promise<boolean> {
  try {
    const resp = await fetch(workspaceProxyUrl(name, port), { cache: 'no-store' });

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
