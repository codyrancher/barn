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
import { SEEDS } from './dev-extension-seed.generated';

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

/**
 * Where a new extension's files come from.
 *
 * A baked-in seed (`dev`, this product's own extension, or `base`, the stock one) or the live
 * tree of an extension already running here. The last is the interesting case: it is a copy of
 * what somebody has been editing, including whatever they changed an hour ago, which is not
 * something a baked-in seed can be.
 */
export const BUILT_IN_SEEDS = Object.keys(SEEDS);

export const DEFAULT_SEED = 'dev';

function seedFiles(source: string): Record<string, string> {
  return SEEDS[source] || SEEDS[DEFAULT_SEED];
}

function seedData(files: Record<string, string>): Record<string, string> {
  // boot.sh is the container's command and is read straight out of /seed, so it
  // keeps its own name; everything else is a path in the tree.
  const data: Record<string, string> = {};

  for (const [filePath, contents] of Object.entries(files)) {
    data[encodeSeedKey(filePath)] = contents;
  }

  return data;
}

/**
 * The files of a running extension, read out of its pod.
 *
 * One exec, not one per file. The obvious version - list, then read each - is forty-odd
 * websockets and the better part of a minute, and it gets slower as somebody's extension grows.
 * So a small node script is written into the pod and run there, and what comes back is a single
 * JSON object.
 *
 * The script arrives base64-encoded rather than as a quoted argument. It is JavaScript inside a
 * `sh -c` inside a URL query parameter, and every layer of that has its own opinion about
 * quotes; encoding it means none of them gets a say.
 */
const CLONE_SCRIPT = `
const fs = require('fs');
const path = require('path');
const root = fs.readdirSync('/app/pkg').map((d) => path.join('/app/pkg', d)).filter((d) => fs.statSync(d).isDirectory())[0];
const out = {};
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else out['pkg/' + path.relative('/app/pkg', full)] = fs.readFileSync(full, 'utf8');
  }
})(root);
process.stdout.write(JSON.stringify(out));
`;

async function cloneFiles(source: string): Promise<Record<string, string>> {
  const pod = await extensionPod(source);

  if (!pod) {
    throw new Error(`${ source } has no running pod to copy from`);
  }

  const encoded = btoa(CLONE_SCRIPT);
  const script = '/tmp/barn-clone.js';

  await podExecOnce(pod, asPodUser(`echo ${ encoded } | base64 -d > ${ script }`));

  const out = await podExecOnce(pod, asPodUser(`node ${ script }`));

  let tree: Record<string, string>;

  try {
    tree = JSON.parse(out);
  } catch {
    throw new Error(`could not read ${ source }'s tree: ${ out.slice(0, 200) || 'no output' }`);
  }

  // The package keeps the directory name it had in the pod it came from, which is what makes
  // this a copy rather than a rename. The skeleton and the pod scripts come from the default
  // seed, because they are the same in every extension and are not part of what was cloned.
  const skeleton = { ...seedFiles(DEFAULT_SEED) };

  for (const key of Object.keys(skeleton)) {
    if (key.startsWith('pkg/')) {
      delete skeleton[key];
    }
  }

  return { ...skeleton, ...tree };
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
export function ensureExtension(name: string, source = DEFAULT_SEED): Promise<void> {
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
    // A clone reads the source pod; a built-in seed is already here. Either way the result is
    // one ConfigMap, and from the pod's point of view there is no difference between them.
    const files = BUILT_IN_SEEDS.includes(source) ? seedFiles(source) : await cloneFiles(source);
    const data = seedData(files);

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
 * A command run in the pod as the user that owns the tree.
 *
 * The exec subresource runs as the container's user, which is root, and everything under /app
 * belongs to uid 1000 (boot.sh hands it over so that claude, which refuses to run as root, can
 * edit what the dev server is watching). Two things go wrong without this drop: git refuses a
 * tree it calls "dubious ownership", and a file written here comes out root-owned, which claude
 * then cannot edit - a failure that shows up minutes later in a pane nobody was watching.
 */
function asPodUser(script: string): string[] {
  // HOME with it. setpriv changes the uid and not the environment, so HOME stays /root, and
  // git then warns twice on every call that it cannot read /root/.config/git. Harmless - it is
  // on stderr and nothing here reads stderr - but it is the sort of noise that costs somebody
  // ten minutes the first time they run one of these by hand.
  const withHome = `export HOME=/app/.home; ${ script }`;

  return ['/bin/sh', '-c', `setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh -c ${ shellQuote(withHome) }`];
}

/**
 * Where the extension's own source is inside the pod.
 *
 * Resolved by looking rather than by name. Every pod is seeded from one tree, so the package
 * directory is called whatever that tree calls it (`pkg/dev-extension`) no matter what the
 * extension is named, and a constant here would be right for one of them and wrong for the
 * rest. There is exactly one directory under `/app/pkg`, which is what makes this safe.
 */
const PACKAGE_DIR = '"$(ls -d /app/pkg/*/ | head -1)"';

/** Run something in the pod, in the extension's package directory, as the tree's owner. */
async function inPackage(name: string, script: string): Promise<string> {
  const pod = await extensionPod(name);

  if (!pod) {
    return '';
  }

  // Braces, not a bare `&&`. Several of these scripts are `;`-separated lists, and `cd X &&
  // a ; b` only guards `a`: a failed cd would run the rest of the list wherever the shell
  // happened to be, which for `git init` means initialising a repository in /.
  return podExecOnce(pod, asPodUser(`cd ${ PACKAGE_DIR } && { ${ script } ; }`));
}

/**
 * Make the package a git repository if it is not one yet.
 *
 * The pod's tree is seeded from a ConfigMap rather than cloned, so it starts with no history at
 * all: nothing to diff an edit against, nothing to undo it with, and no answer to "what did
 * claude change in the last hour". One `git init` and one commit of the seeded state is the
 * whole fix, and it is cheap enough (42 files) to do the first time anybody looks.
 *
 * `main` explicitly, because git's default branch name depends on the version and on a config
 * nobody set in here, and a branch dropdown that says `master` on one pod and `main` on the next
 * is a needless surprise.
 */
export async function ensureExtensionRepo(name: string): Promise<void> {
  await inPackage(name, [
    'test -d .git && exit 0',
    'printf "node_modules/\\n" > .gitignore',
    'git init -q -b main',
    'git add -A',
    'git -c user.email=barn@rancher.local -c user.name=barn commit -q -m "The seeded extension"',
  ].join(' ; '));
}

/** Every file in the package, as paths relative to it. Excludes node_modules by construction. */
export async function listExtensionFiles(name: string): Promise<string[]> {
  // `find` rather than `git ls-files`, so a file created a moment ago and not yet added is
  // listed. An untracked file is still a file somebody wants to open.
  const out = await inPackage(name, "find . -name node_modules -prune -o -name .git -prune -o -type f -print | sed 's|^\\./||'");

  return out.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

export async function readExtensionFile(name: string, path: string): Promise<string> {
  return inPackage(name, `cat ${ shellQuote(path) } 2>/dev/null`);
}

/**
 * Write one back.
 *
 * Through base64 rather than a here-doc: these are source files full of backticks, dollars and
 * quotes, and every one of those is something a shell would interpret on the way in.
 */
export async function writeExtensionFile(name: string, path: string, contents: string): Promise<void> {
  const pod = await extensionPod(name);

  if (!pod) {
    throw new Error(`${ name } has no running pod to write to`);
  }

  // btoa is byte-oriented and these files are UTF-8, so the string is widened first.
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(contents)));
  const quoted = shellQuote(path);

  await inPackage(name, `mkdir -p "$(dirname ${ quoted })" && echo ${ encoded } | base64 -d > ${ quoted }`);
}

export interface ExtensionBranches {
  current: string;
  branches: string[];
}

export async function listBranches(name: string): Promise<ExtensionBranches> {
  const out = await inPackage(name, 'git branch --format="%(refname:short)" 2>/dev/null; echo ---; git rev-parse --abbrev-ref HEAD 2>/dev/null');
  const [listed = '', current = ''] = out.split('---');

  return {
    current:  current.trim(),
    branches: listed.split('\n').map((line) => line.trim()).filter(Boolean),
  };
}

/** Switch to a branch, creating it from where HEAD is if it does not exist. */
export async function checkoutBranch(name: string, branch: string): Promise<string> {
  // `git checkout -B` would reset an existing branch to HEAD, which is a data-losing way to
  // spell "switch to". So: try to switch, and only create when there is nothing to switch to.
  return inPackage(name, `git checkout ${ shellQuote(branch) } 2>&1 || git checkout -b ${ shellQuote(branch) } 2>&1`);
}

export interface ExtensionCommit {
  sha: string;
  subject: string;
  when: string;
  who: string;
}

/**
 * The branch's commits, newest first.
 *
 * A unit separator between the fields rather than a comma or a tab, because a commit subject can
 * contain either and this is parsed by splitting.
 */
export async function listCommits(name: string, limit = 50): Promise<ExtensionCommit[]> {
  const out = await inPackage(name, `git log -n ${ limit } --format='%h%x1f%s%x1f%cr%x1f%an' 2>/dev/null`);

  return out.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sha, subject, when, who] = line.split('\x1f');

    return {
      sha, subject, when, who
    };
  });
}

/** Commit whatever is currently different, which is how an edit here becomes history. */
export async function commitExtension(name: string, message: string): Promise<string> {
  return inPackage(name, [
    'git add -A',
    `git -c user.email=barn@rancher.local -c user.name=barn commit -q -m ${ shellQuote(message) } 2>&1`,
    'git log -1 --format=%h',
  ].join(' && '));
}

/** How many files differ from the last commit, so the UI can offer to make one. */
export async function countChanges(name: string): Promise<number> {
  const out = await inPackage(name, 'git status --porcelain 2>/dev/null | wc -l');

  return parseInt(out.trim(), 10) || 0;
}

/**
 * Write a binary file into an extension's pod.
 *
 * For images pasted into the terminal. Base64 all the way in, because the payload is binary and
 * everything between here and the file is a shell: the exec subresource takes argv, the argv is
 * a `sh -c` script, and a PNG put through that directly would be mangled by the first byte that
 * looked like a quote.
 *
 * Chunked, because a screenshot is a megabyte or two and the whole command is a URL query
 * parameter on the exec websocket. There is no documented ceiling on that and the ones that
 * exist are in whatever proxies the request, so this appends in pieces small enough that none
 * of them is anywhere near a limit rather than finding out where the limit is in production.
 */
const IMAGE_CHUNK = 48 * 1024;

export async function writePodImage(name: string, path: string, data: ArrayBuffer): Promise<void> {
  const pod = await extensionPod(name);

  if (!pod) {
    throw new Error(`${ name } has no running pod to write to`);
  }

  const bytes = new Uint8Array(data);
  let binary = '';

  // A chunk at a time rather than String.fromCharCode(...bytes), which blows the argument limit
  // and throws on anything the size of a screenshot.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  const encoded = btoa(binary);
  const quoted = shellQuote(path);
  const stage = `${ quoted }.b64`;

  await podExecOnce(pod, asPodUser(`mkdir -p "$(dirname ${ quoted })" && : > ${ stage }`));

  for (let i = 0; i < encoded.length; i += IMAGE_CHUNK) {
    const chunk = encoded.slice(i, i + IMAGE_CHUNK);

    // printf %s rather than echo: the payload is base64, which cannot contain a quote or a
    // backslash, so this is safe, and echo would interpret escapes on some shells.
    await podExecOnce(pod, asPodUser(`printf %s '${ chunk }' >> ${ stage }`));
  }

  const out = await podExecOnce(pod, asPodUser(
    `base64 -d ${ stage } > ${ quoted } && rm -f ${ stage } && wc -c < ${ quoted }`
  ));

  if (!parseInt(out.trim(), 10)) {
    throw new Error(`the image did not land in ${ name }`);
  }
}

/** Single-quote for `sh`, the only form that needs no other escaping inside it. */
function shellQuote(value: string): string {
  return `'${ value.split("'").join(`'\\''`) }'`;
}

// ---------------------------------------------------------------------------
// Publishing: from the pod's working tree to an extension Rancher has installed.
//
// Rancher loads UI extensions from the index it serves at /v1/uiplugins, which is built from
// the UIPlugin resources in cattle-ui-plugin-system. An entry whose metadata says
// `direct: "true"` is loaded by the browser straight from its `endpoint`, as a script tag -
// that is the mechanism behind Developer Load, and it is the whole of what publishing needs
// here.
//
// So: build in the pod, put the bundle where the pod's dev server already serves static files,
// and point a UIPlugin at it through the apiserver's service proxy. The browser fetches it on
// Rancher's own origin, carrying the session it already has, and there is nothing to
// authenticate and nothing to host.
//
// What this deliberately does not do is add a Helm repository. That is the other route - a
// chart in a repo, a ClusterRepo pointing at it, the plugin operator downloading and serving
// the contents - and every part of it is machinery this does not need: Rancher would have to
// reach the pod server-side, the operator would have to be installed, and the result is the
// same extension loaded from the same pod. The trade is real and worth knowing: an extension
// published this way lives exactly as long as the pod serving it does. It is a dev loop, not a
// release.
// ---------------------------------------------------------------------------

/** Where Rancher keeps the resources behind its /v1/uiplugins index. */
const PLUGIN_NS = 'cattle-ui-plugin-system';

/** Under /app/public, which the pod's dev server serves at the root of the proxy path. */
const PUBLISHED_DIR = 'plugins';

/**
 * The package's name, version and Rancher annotations, read out of the tree rather than assumed.
 *
 * By reading the file and parsing it here rather than by running `node -p` in the pod. The node
 * version worked when it was pasted into a shell and returned nothing at all through the exec
 * websocket, and chasing that is time spent on a quoting problem that did not need to exist:
 * the command had a JavaScript expression inside double quotes inside a single-quoted `sh -c`
 * inside a query parameter. `cat` has none of those layers, and the browser can parse JSON.
 *
 * The annotations matter as much as the name. Rancher's dashboard refuses to load an extension
 * whose entry carries no `catalog.cattle.io/ui-extensions-version`, and says so only as
 * `plugins.error.apiAnnotationMissing` in a store nobody is looking at, so the symptom is an
 * extension that installs cleanly, reports Ready, and never appears. A published chart carries
 * these across from package.json; this does the same thing by hand.
 */
interface PackageIdentity {
  name: string;
  version: string;
  annotations: Record<string, string>;
}

async function packageIdentity(name: string): Promise<PackageIdentity> {
  const raw = await readExtensionFile(name, 'package.json');

  try {
    const parsed = JSON.parse(raw);

    return {
      name:        parsed.name,
      version:     parsed.version,
      annotations: parsed.rancher?.annotations || {},
    };
  } catch {
    throw new Error(`could not read the package.json of ${ name }: ${ raw.trim() || 'no output' }`);
  }
}

export interface PublishResult {
  plugin: string;
  version: string;
  url: string;
  log: string;
}

/**
 * The steps a publish goes through, in order, so the page can say which one it is on.
 *
 * Named here rather than in the page because the page cannot know: only this file knows that
 * "building" and "copying it where the dev server can serve it" are two separate things, and a
 * bar that counted them differently from the code that runs them would be a bar that lies.
 */
export const PUBLISH_STAGES = [
  'Reading the package',
  'Building the extension',
  'Serving it from the pod',
  'Installing it into Rancher',
];

export type PublishProgress = (stage: number, label: string, total: number) => void;

/** Thrown with the output attached, because a build failure is only diagnosable from its log. */
export class PublishError extends Error {
  log: string;
  stage: string;

  constructor(message: string, stage: string, log: string) {
    super(message);
    this.name = 'PublishError';
    this.stage = stage;
    this.log = log;
  }
}

/**
 * Build the extension in its own pod and install it into this Rancher.
 *
 * The build is `build-pkg`, run in the pod, and it takes minutes: it is a production build of
 * the package against the shell. It is one exec that stays open for the duration rather than
 * something polled, because the output is the only diagnostic there is when it fails.
 */
export async function publishExtension(name: string, onProgress?: PublishProgress): Promise<PublishResult> {
  const total = PUBLISH_STAGES.length;
  const report = (stage: number) => onProgress?.(stage, PUBLISH_STAGES[stage - 1], total);
  const pod = await extensionPod(name);

  if (!pod) {
    throw new PublishError(`${ name } has no running pod to build in`, PUBLISH_STAGES[0], '');
  }

  report(1);

  const { name: plugin, version, annotations } = await packageIdentity(name);
  const built = `${ plugin }-${ version }`;

  report(2);

  // `2>&1` because build-pkg says everything useful on stderr, and this exec reads only stdout.
  const log = await podExecOnce(pod, asPodUser(
    `cd /app && ./node_modules/@rancher/shell/scripts/build-pkg.sh ${ plugin } 2>&1`
  ));

  const bundle = `dist-pkg/${ built }/${ built }.umd.min.js`;
  const builtOk = await podExecOnce(pod, asPodUser(`test -f /app/${ bundle } && echo yes`));

  if (!builtOk.includes('yes')) {
    throw new PublishError(`${ plugin } did not build`, PUBLISH_STAGES[1], log);
  }

  report(3);

  // /app/public is what the dev server serves at the root of the proxy path, so a copy in there
  // is reachable at a URL on Rancher's own origin without anything else being started.
  const copyLog = await podExecOnce(pod, asPodUser([
    'cd /app',
    `mkdir -p public/${ PUBLISHED_DIR }`,
    `rm -rf public/${ PUBLISHED_DIR }/${ built }`,
    `cp -r dist-pkg/${ built } public/${ PUBLISHED_DIR }/${ built }`,
    'echo BARN-COPY-OK',
  ].join(' && ')));

  if (!copyLog.includes('BARN-COPY-OK')) {
    throw new PublishError('the built bundle could not be copied where the pod serves it', PUBLISH_STAGES[2], `${ log }\n${ copyLog }`);
  }

  report(4);

  // Cache-busting on the URL rather than trust in noCache. The browser has almost certainly
  // loaded this exact path before, and a republish that serves the previous bundle is the
  // failure this whole button exists to avoid. The stamp is the pod's own clock, which is the
  // only clock that knows when the build happened.
  const stamp = (await podExecOnce(pod, asPodUser('date +%s'))).trim();
  const url = `${ extensionProxyPath(name) }/${ PUBLISHED_DIR }/${ built }/${ built }.umd.min.js?t=${ stamp }`;

  try {
    await upsertUiPlugin(plugin, version, url, annotations);
  } catch (e: any) {
    throw new PublishError(e?.message || String(e), PUBLISH_STAGES[3], log);
  }

  return {
    plugin, version, url, log
  };
}

/**
 * Create or update the UIPlugin that makes Rancher load it.
 *
 * PUT rather than delete-and-create on an update: the resource is what Rancher's index is built
 * from, and removing it even briefly is an extension disappearing out of somebody's nav.
 */
async function upsertUiPlugin(
  plugin: string, version: string, url: string, annotations: Record<string, string>
): Promise<void> {
  const body = {
    apiVersion: 'catalog.cattle.io/v1',
    kind:       'UIPlugin',
    metadata:   { namespace: PLUGIN_NS, name: plugin },
    spec:       {
      plugin: {
        name:     plugin,
        version,
        endpoint: url,
        noCache:  true,
        metadata: {
          ...annotations,
          // What makes the browser load `endpoint` itself instead of asking Rancher to serve
          // the plugin's files from a chart it downloaded. See extension-manager-impl.js.
          direct: 'true',
        },
      },
    },
  };

  const type = 'catalog.cattle.io.uiplugins';
  const existing = await rancherFetch(`${ EXT_BASE }/v1/${ type }/${ PLUGIN_NS }/${ plugin }`).catch(() => null);

  if (existing) {
    await rancherFetch(`${ EXT_BASE }/v1/${ type }/${ PLUGIN_NS }/${ plugin }`, {
      method: 'PUT',
      body:   JSON.stringify({ ...existing, spec: body.spec }),
    });

    return;
  }

  await rancherFetch(`${ EXT_BASE }/v1/${ type }`, { method: 'POST', body: JSON.stringify(body) });
}

/** What is installed right now, so the button can say "update" rather than "install". */
export async function publishedVersion(name: string): Promise<string> {
  const plugin = await packageIdentity(name).then((identity) => identity.name).catch(() => '');

  if (!plugin) {
    return '';
  }

  const existing = await rancherFetch(
    `${ EXT_BASE }/v1/catalog.cattle.io.uiplugins/${ PLUGIN_NS }/${ plugin }`
  ).catch(() => null);

  return existing?.spec?.plugin?.version || '';
}
