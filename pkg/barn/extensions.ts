// ---------------------------------------------------------------------------
// Extensions: Rancher extensions whose dev servers run as pods in the cluster,
// and are edited inside those pods.
//
// A pod runs `vue-cli-service serve` over a whole dashboard with an extension
// package compiled into it. The browser reaches it through the Kubernetes
// apiserver's service proxy, on Rancher's own origin, so it is a second,
// live-reloading dashboard at a URL of its own, and Rancher's own UI and its
// `ui-dashboard-index` setting are left completely alone.
//
// There can be several. Each is a name, and that name is the whole of its
// identity: it decides the objects in the cluster, the directory on the node
// its tree lives in, and the URL it is served at. What they are all seeded from
// is one thing, the tree in pkg/barn/dev-extension/, baked into this bundle as
// SEED_FILES, so a new extension starts as a copy of the one we have rather
// than as a skeleton nobody maintains.
//
// Everything an extension needs travels with this bundle: the source is written
// into a ConfigMap, the pod installs from it on first boot, and creating one is
// four objects. There is no install step and nothing to run outside the cluster.
//
// Editing is done in the pod. That tree is the live source once it has booted:
//   kubectl -n barn exec -it deploy/barn-dev-extension \
//     -- bash -c 'cd /app/pkg/dev-extension && exec bash'
// ---------------------------------------------------------------------------
import { rancherFetch } from './api';
import { SEED_FILES } from './dev-extension-seed.generated';

// The `local` cluster, like the editor's content pod: the extension loads in
// contexts that have no cluster of their own, and a dev server should be at one
// URL regardless of where you were when you opened it.
const EXT_CLUSTER = 'local';
export const EXT_NS = 'barn';
const EXT_PORT = 8005;

// The one container in a pod. Named here because two things address it: the
// Deployment below creates it, and a terminal tab execs into it.
const EXT_CONTAINER = 'devserver';

// Plain node, not a built image: the pod installs from the seeded package.json,
// so there is nothing to publish and nothing that can be older than the source.
const EXT_IMAGE = 'node:24';

/**
 * The extension every Rancher gets, and the one the Editor opens.
 *
 * It is a name like any other. The only thing special about it is that it is
 * created without being asked for, so that a Rancher with this bundle loaded has
 * somewhere to edit before anybody has typed anything.
 */
export const DEFAULT_EXTENSION = 'dev';

const EXT_BASE = `/k8s/clusters/${ EXT_CLUSTER }`;

/**
 * The ServiceAccount every extension pod runs as, and what it can do.
 *
 * cluster-admin, deliberately. The point of a terminal in one of these pods is
 * that claude can build a Rancher extension in it, and a Rancher extension is
 * mostly a UI over Rancher's own resources: it cannot be written, and certainly
 * cannot be tried, by somebody who cannot create a Project, look at a Setting or
 * make a workspace to test against. The alternative we had was a token with no
 * rights at all, which made every question about the cluster unanswerable from
 * the pane that was supposed to be answering it.
 *
 * This is a real grant and worth saying plainly: anyone who can open a terminal
 * in one of these pods can do anything in this cluster. That is the same set of
 * people who can already developer-load an extension into Rancher, which runs
 * with the session of whoever is looking at it, so it widens what is reachable
 * without widening who can reach it.
 */
const EXT_ACCOUNT = 'barn-extension';
const EXT_ROLE_BINDING = 'barn-extension-cluster-admin';

/** ConfigMap keys cannot contain '/', so paths are flattened and boot.sh rebuilds them. */
export const PATH_SEPARATOR = '__';

function encodeSeedKey(filePath: string): string {
  return filePath.split('/').join(PATH_SEPARATOR);
}

/**
 * What an extension's objects are called.
 *
 * `barn-<name>-extension` rather than anything shorter, because the namespace
 * holds the editor's content pod too and a bare name would eventually collide
 * with it. It is also the label every one of its objects carries, so the
 * Deployment, the Service, the ConfigMap and the pod all answer to one string.
 */
export function extensionObject(name: string): string {
  return `barn-${ name }-extension`;
}

/** The reverse, for listing: null for anything in the namespace that is not an extension. */
function extensionName(object: string): string | null {
  const match = object.match(/^barn-(.+)-extension$/);

  return match ? match[1] : null;
}

/**
 * Where the node keeps an extension's working tree and node_modules between pod
 * restarts. The install is minutes and the tree is what you edit, so neither can
 * live in the pod's own filesystem.
 */
function hostCachePath(name: string): string {
  return `/var/lib/rancher/barn/${ name }-extension`;
}

/**
 * A name Kubernetes will accept, and that a person will recognise afterwards.
 *
 * Applied rather than rejected: this is fed by a free-text box in the header, and
 * somebody typing "My Thing" means a new extension, not a validation error.
 */
export function normalizeExtensionName(input: string): string {
  return (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

/**
 * The apiserver's service-proxy path in front of an extension's dev server.
 *
 * Root-relative on purpose: the browser resolves it against Rancher's own
 * origin, so neither this extension nor the pod ever learns what hostname
 * Rancher is served on. It is also the only thing the pod's vue.config.js is
 * given: asset URLs, the router base and the hot-reload socket are all derived
 * from it, out of the same constants that name the Service just below.
 */
export function extensionProxyPath(name: string): string {
  const object = extensionObject(name);

  return `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/services/http:${ object }:${ EXT_PORT }/proxy`;
}

/** Where to point a browser at one. */
export function extensionUrl(name: string): string {
  return `${ extensionProxyPath(name) }/`;
}

/**
 * Whether an extension's dev server is serving yet.
 *
 * First boot installs and compiles for a few minutes, and until it does the
 * service proxy answers with an error of its own ("no endpoints available")
 * rather than the dashboard. Anything that frames or redirects to one waits on
 * this, so what it shows in the meantime is its own, not the proxy's error page.
 */
export async function extensionReady(name: string): Promise<boolean> {
  try {
    // Not rancherFetch: that one expects JSON, and this is the dashboard's HTML.
    const resp = await fetch(`${ extensionProxyPath(name) }/index.html`, { cache: 'no-store' });

    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * The running pod for an extension, or null while there isn't one.
 *
 * A terminal tab needs the pod by name, because exec is a subresource of the pod
 * rather than of the Deployment or the Service. Steve ignores labelSelector, so
 * the filtering is done here.
 *
 * `Running` is the bar, not `Ready`: the pod is ready only once the dev server
 * serves, which is minutes on a first boot, and a shell is useful (arguably most
 * useful) before then.
 */
export async function extensionPod(name: string): Promise<string | null> {
  const object = extensionObject(name);
  const pods = await rancherFetch(`${ EXT_BASE }/v1/pods/${ EXT_NS }`).catch(() => null);

  const running = (pods?.data || []).find((pod: any) => (
    pod.metadata?.labels?.app === object &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

export interface ExtensionSummary {
  name: string;
  /** Ready replicas, so the caller can say "starting" without a second request. */
  ready: boolean;
  url: string;
}

/**
 * Every extension in the cluster.
 *
 * Read from the Deployments rather than from a list this extension keeps,
 * because the cluster is the list: one made in another browser, or by hand, is
 * one this should offer. The name is recovered from the object's own name for
 * the same reason a label would be worse - an object relabelled by hand would
 * vanish from the picker while continuing to serve.
 */
export async function listExtensions(): Promise<ExtensionSummary[]> {
  const deployments = await rancherFetch(`${ EXT_BASE }/v1/apps.deployments/${ EXT_NS }`).catch(() => null);

  return (deployments?.data || [])
    .map((deployment: any) => {
      const name = extensionName(deployment.metadata?.name || '');

      return name === null ? null : {
        name,
        ready: (deployment.status?.readyReplicas || 0) > 0,
        url:   extensionUrl(name),
      };
    })
    .filter(Boolean)
    .sort((a: ExtensionSummary, b: ExtensionSummary) => a.name.localeCompare(b.name));
}

// GET a Steve resource; resolve null if it isn't there yet.
function extGet(type: string, object: string): Promise<any> {
  return rancherFetch(`${ EXT_BASE }/v1/${ type }/${ EXT_NS }/${ object }`).catch(() => null);
}

function seedData(): Record<string, string> {
  // boot.sh is the container's command and is read straight out of /seed, so it
  // keeps its own name; everything else is a path in the tree.
  const data: Record<string, string> = {};

  for (const [filePath, contents] of Object.entries(SEED_FILES)) {
    data[encodeSeedKey(filePath)] = contents;
  }

  return data;
}

function deployment(name: string): Record<string, unknown> {
  const object = extensionObject(name);

  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace: EXT_NS, name: object, labels: { app: object } },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: object } },
      // Recreate, not RollingUpdate: /app is a hostPath, so two dev servers
      // would be watching and rebuilding the same tree at the same time.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { app: object } },
        spec:     {
          serviceAccountName: EXT_ACCOUNT,
          containers:         [{
            name:    EXT_CONTAINER,
            image:   EXT_IMAGE,
            command: ['/bin/sh', '/seed/boot.sh'],
            ports:   [{ name: 'http', containerPort: EXT_PORT }],
            env:     [
              { name: 'DEV_PROXY_PATH', value: extensionProxyPath(name) },
              // The pod's own name for itself. Its terminal prompt, its CLAUDE.md and the
              // sync script all want it, and working it out from the proxy path in three
              // places is three chances to work it out differently.
              { name: 'EXTENSION_NAME', value: name },
              { name: 'NODE_ENV', value: 'dev' },
              // A dashboard build is big enough to OOM node's default heap.
              { name: 'NODE_OPTIONS', value: '--max_old_space_size=4096' },
            ],
            volumeMounts: [
              { name: 'seed', mountPath: '/seed' },
              { name: 'app', mountPath: '/app' },
            ],
            // Installing and the first compile take minutes. A startup probe
            // with a long budget is what keeps the kubelet from restarting a
            // pod that is working fine, and restarting it is not harmless,
            // since it would throw away a part-finished install.
            startupProbe: {
              httpGet:          { path: '/index.html', port: EXT_PORT },
              periodSeconds:    10,
              failureThreshold: 90,
            },
            readinessProbe: {
              httpGet:       { path: '/index.html', port: EXT_PORT },
              periodSeconds: 10,
            },
          }],
          volumes: [
            { name: 'seed', configMap: { name: object } },
            { name: 'app', hostPath: { path: hostCachePath(name), type: 'DirectoryOrCreate' } },
          ],
        },
      },
    },
  };
}

/**
 * The namespace and the ServiceAccount, which every extension shares.
 *
 * Separate from ensureExtension because it is per cluster rather than per
 * extension, and because a second extension should not re-POST a ClusterRoleBinding
 * that is already there.
 */
async function ensureShared(): Promise<void> {
  const ns = await rancherFetch(`${ EXT_BASE }/v1/namespaces/${ EXT_NS }`).catch(() => null);

  if (!ns) {
    await rancherFetch(`${ EXT_BASE }/v1/namespaces`, {
      method: 'POST',
      body:   JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: EXT_NS } }),
    }).catch(() => null);
  }

  if (!await extGet('serviceaccounts', EXT_ACCOUNT)) {
    await rancherFetch(`${ EXT_BASE }/v1/serviceaccounts`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'ServiceAccount',
        metadata:   { namespace: EXT_NS, name: EXT_ACCOUNT },
      }),
    }).catch(() => null);
  }

  // See EXT_ACCOUNT above for why this is cluster-admin.
  const binding = await rancherFetch(
    `${ EXT_BASE }/v1/rbac.authorization.k8s.io.clusterrolebindings/${ EXT_ROLE_BINDING }`
  ).catch(() => null);

  if (!binding) {
    await rancherFetch(`${ EXT_BASE }/v1/rbac.authorization.k8s.io.clusterrolebindings`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind:       'ClusterRoleBinding',
        metadata:   { name: EXT_ROLE_BINDING },
        roleRef:    { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
        subjects:   [{ kind: 'ServiceAccount', name: EXT_ACCOUNT, namespace: EXT_NS }],
      }),
    }).catch(() => null);
  }
}

// `| undefined` on purpose: an index signature without it types every lookup as a live promise,
// so the guard below reads as always-true and `yarn build-pkg` refuses it (TS2801).
const ensureInFlight: Record<string, Promise<void> | undefined> = {};

/**
 * Create an extension's seed ConfigMap, Deployment and Service if they aren't
 * there yet.
 *
 * Idempotent and safe to call repeatedly (dedup'd in-flight per name); swallows
 * errors (e.g. the user lacks create rights) so it can never break a page. The
 * ConfigMap is upserted so a newer seed reaches an existing cluster; the
 * Deployment and Service are create-if-missing, because replacing them would
 * restart a dev server somebody is editing in.
 */
export function ensureExtension(name: string): Promise<void> {
  const inFlight = ensureInFlight[name];

  if (inFlight) {
    return inFlight;
  }

  const object = extensionObject(name);

  const started = (async() => {
    await ensureShared();

    // Seed ConfigMap (upsert). The pod only writes seeded files it doesn't
    // already have, so this adds new files to a running tree without touching
    // what has been edited in there.
    const cm = await extGet('configmaps', object);
    const data = seedData();

    if (cm) {
      await rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ object }`, {
        method: 'PUT',
        body:   JSON.stringify({ ...cm, data }),
      }).catch(() => null);
    } else {
      await rancherFetch(`${ EXT_BASE }/v1/configmaps`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'ConfigMap',
          metadata:   { namespace: EXT_NS, name: object, labels: { app: object } },
          data,
        }),
      }).catch(() => null);
    }

    // Deployment (node running the dev server over the seeded tree)
    const existing = await extGet('apps.deployments', object);

    if (!existing) {
      await rancherFetch(`${ EXT_BASE }/v1/apps.deployments`, {
        method: 'POST',
        body:   JSON.stringify(deployment(name)),
      }).catch(() => null);
    } else if (existing.spec?.template?.spec?.serviceAccountName !== EXT_ACCOUNT) {
      // The one thing an existing Deployment is brought up to date on.
      //
      // Everything else here is deliberately create-if-missing, because replacing a Deployment
      // restarts a dev server somebody is editing in. This is the exception because a pod
      // running as `default` has no rights at all, which is the difference between a terminal
      // that can answer questions about the cluster and one that gets 403 to all of them - and
      // no amount of granting fixes it, because the grant is to an account the pod is not using.
      //
      // It costs one restart, once. The tree and node_modules are on a hostPath, so the pod is
      // back in seconds rather than reinstalling; what it does end is any tmux session in it.
      existing.spec.template.spec.serviceAccountName = EXT_ACCOUNT;

      await rancherFetch(`${ EXT_BASE }/v1/apps.deployments/${ EXT_NS }/${ object }`, {
        method: 'PUT',
        body:   JSON.stringify(existing),
      }).catch(() => null);
    }

    // Service (ClusterIP :8005, what the service proxy above resolves to)
    if (!await extGet('services', object)) {
      await rancherFetch(`${ EXT_BASE }/v1/services`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'Service',
          metadata:   { namespace: EXT_NS, name: object, labels: { app: object } },
          spec:       { selector: { app: object }, ports: [{ name: 'http', port: EXT_PORT, targetPort: 'http' }] },
        }),
      }).catch(() => null);
    }
  })().finally(() => {
    delete ensureInFlight[name];
  });

  ensureInFlight[name] = started;

  return started;
}

/** The one every Rancher gets, created when this bundle loads. */
export function ensureDefaultExtension(): Promise<void> {
  return ensureExtension(DEFAULT_EXTENSION);
}

/**
 * WebSocket URL for a shell in an extension's pod.
 *
 * This is the Kubernetes exec subresource, the same one the dashboard's own
 * container shell uses, so it carries the browser's Rancher session and needs
 * nothing else to authenticate. The protocol is `base64.channel.k8s.io`: every
 * frame is a channel digit (0 stdin, 1 stdout, 2 stderr, 3 error, 4 resize)
 * followed by base64.
 *
 * The command is `/seed/shell.sh`, which is in the pod's ConfigMap rather than
 * its filesystem, so what a tab starts is whatever this extension last wrote.
 */
export function extensionShellUrl(pod: string, session: string): string {
  return execUrl(pod, ['/bin/sh', '/seed/shell.sh', session], true);
}

/** The exec subresource, for a shell (tty, stdin) or for one command (neither). */
function execUrl(pod: string, command: string[], interactive: boolean): string {
  const origin = window.location.origin.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    container: EXT_CONTAINER,
    stdin:     interactive ? '1' : '0',
    stdout:    '1',
    stderr:    '1',
    tty:       interactive ? '1' : '0',
  });

  // Repeated, not comma-joined: this is argv.
  for (const arg of command) {
    params.append('command', arg);
  }

  return `${ origin }${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/pods/${ pod }/exec?${ params }`;
}

/**
 * Run one command in an extension's pod and return what it wrote to stdout.
 *
 * The same exec subresource the terminal uses, without the tty: a socket that opens, streams
 * frames and closes. It resolves rather than rejects on failure, with whatever it managed to
 * read, because every caller here is reading a file that may simply not exist and an empty
 * string is the right answer to that.
 */
export function podExecOnce(pod: string, command: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';

    try {
      const socket = new WebSocket(execUrl(pod, command, false), 'base64.channel.k8s.io');

      // Every frame is a channel digit then base64. 1 is stdout, which is the only one a
      // caller has asked about so far; 2 is stderr and 3 is the apiserver's own status.
      socket.onmessage = (event) => {
        const frame = String(event.data || '');

        if (frame.startsWith('1')) {
          try {
            out += atob(frame.slice(1));
          } catch { /* a frame that is not base64 is not output */ }
        }
      };

      socket.onclose = () => resolve(out);
      socket.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

/**
 * The files that shape what the agent in this pod does.
 *
 * Everything claude reads before it reads the code: the instructions in the tree, the ones in
 * its home, the skills it can invoke, and the per-session copy `shell.sh` drops into a new
 * conversation. Found rather than listed, because a skill added in the pod half an hour ago is
 * exactly the kind of thing somebody opening this wants to see.
 *
 * `-maxdepth` on each root keeps this from walking node_modules, which is tens of thousands of
 * files and holds a `CLAUDE.md` or two of its own that belong to a dependency rather than here.
 */
export const AGENT_FILE_ROOTS = [
  { path: '/app', depth: 1, label: 'the app' },
  { path: '/app/pkg', depth: 2, label: 'the extension' },
  { path: '/app/.home/.claude', depth: 3, label: 'claude' },
  { path: '/app/.sessions', depth: 2, label: 'this conversation' },
];

const AGENT_FILE_NAMES = ['CLAUDE.md', 'SKILL.md', 'settings.json', 'settings.local.json'];

export async function listAgentFiles(name: string): Promise<string[]> {
  const pod = await extensionPod(name);

  if (!pod) {
    return [];
  }

  const names = AGENT_FILE_NAMES.map((file) => `-name '${ file }'`).join(' -o ');
  const finds = AGENT_FILE_ROOTS
    .map((root) => `find ${ root.path } -maxdepth ${ root.depth } \\( ${ names } \\) -type f 2>/dev/null`)
    .join('; ');

  const out = await podExecOnce(pod, ['/bin/sh', '-c', finds]);

  return out.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

export async function readAgentFile(name: string, path: string): Promise<string> {
  const pod = await extensionPod(name);

  return pod ? podExecOnce(pod, ['/bin/sh', '-c', `cat ${ shellQuote(path) } 2>/dev/null`]) : '';
}

/**
 * Write one back.
 *
 * Through base64 rather than a here-doc: these are markdown files full of backticks, dollars
 * and quotes, and every one of those is something a shell would interpret on the way in.
 */
export async function writeAgentFile(name: string, path: string, contents: string): Promise<void> {
  const pod = await extensionPod(name);

  if (!pod) {
    throw new Error(`${ name } has no running pod to write to`);
  }

  // btoa is byte-oriented and these files are UTF-8, so the string is widened first.
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(contents)));
  const quoted = shellQuote(path);

  await podExecOnce(pod, ['/bin/sh', '-c',
    `mkdir -p "$(dirname ${ quoted })" && echo ${ encoded } | base64 -d > ${ quoted }`]);
}

/** Single-quote for `sh`, the only form that needs no other escaping inside it. */
function shellQuote(value: string): string {
  return `'${ value.split("'").join(`'\\''`) }'`;
}
