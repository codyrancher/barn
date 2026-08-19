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

  return withSkeleton(tree);
}

/**
 * A cloned or imported package, plus the parts every extension has and nobody edits.
 *
 * The skeleton and the pod scripts come from the default seed because they are the same in
 * every extension and are not part of what was copied; `pkg/` is stripped out of it so the
 * copy's own package is the only one in the result.
 */
function withSkeleton(tree: Record<string, string>): Record<string, string> {
  const skeleton = { ...seedFiles(DEFAULT_SEED) };

  for (const key of Object.keys(skeleton)) {
    if (key.startsWith('pkg/')) {
      delete skeleton[key];
    }
  }

  return { ...skeleton, ...tree };
}

/** `github:owner/repo`, or `github:owner/repo#branch`. Null for anything that is not one. */
export function parseGithubSource(source: string): { repo: string; ref: string } | null {
  const match = /^github:([\w.-]+\/[\w.-]+)(?:#(.+))?$/.exec(source);

  return match ? { repo: match[1], ref: match[2] || '' } : null;
}

/**
 * Walks the clone rather than the pod's own tree, and names the package after its package.json.
 *
 * The directory a package lives in and the name inside its package.json have to agree - the
 * build reads one and the dev server serves the other - so the repository's own name wins over
 * anything typed into a modal. BARN_IMPORT_NAME is the fallback for a repository that has no
 * package.json to ask.
 */
const IMPORT_SCRIPT = `
const fs = require('fs');
const path = require('path');
const root = '/tmp/barn-import';
let named = '';
try { named = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name || ''; } catch (e) {}
const dir = named || process.env.BARN_IMPORT_NAME;
const out = {};
(function walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(d, entry.name);
    if (entry.isDirectory()) walk(full);
    else out['pkg/' + dir + '/' + path.relative(root, full)] = fs.readFileSync(full, 'utf8');
  }
})(root);
process.stdout.write(JSON.stringify(out));
`;

/**
 * A pod - any pod - to run a clone in.
 *
 * Importing needs git, a network and a filesystem, and the extension being imported has none of
 * them yet: it does not exist. So it borrows a pod that does. Any running extension will do,
 * because nothing of that extension is touched: the clone lands in /tmp and is read straight
 * back out.
 */
async function anyRunningPod(): Promise<string | null> {
  for (const extension of await listExtensions().catch(() => [])) {
    if (!extension.ready) {
      continue;
    }

    const pod = await extensionPod(extension.name);

    if (pod) {
      return pod;
    }
  }

  return null;
}

/**
 * The files of a repository, cloned in a pod and read back.
 *
 * In a pod rather than in the browser because the alternative is the GitHub API, which hands
 * back a tree and then one request per blob - forty-odd of them for an extension - and cannot
 * do it at all for a repository whose files somebody has to be logged in to read. `git clone`
 * is one command that already handles both, and there is a container here that has git in it.
 */
async function githubFiles(repo: string, ref: string, fallbackName: string): Promise<Record<string, string>> {
  const pod = await anyRunningPod();

  if (!pod) {
    throw new Error('importing needs one extension already running, because the clone happens in its pod');
  }

  const token = await readToken();
  // Public repositories need no token. A private one without a token fails in `git clone` with
  // GitHub's own message, which says more than a check here would.
  const auth = token ? btoa(`x-access-token:${ token }`) : '';
  const scrub = (text: string) => (token ? text.split(token).join('***').split(auth).join('***') : text);
  const authArg = auth ? `-c http.extraheader=${ shellQuote(`AUTHORIZATION: basic ${ auth }`) }` : '';
  const branchArg = ref ? `--branch ${ shellQuote(ref) }` : '';

  const clone = await podExecOnce(pod, asPodUser(
    `rm -rf /tmp/barn-import && git ${ authArg } clone --depth 1 ${ branchArg } ${ shellQuote(`https://github.com/${ repo }.git`) } /tmp/barn-import 2>&1 && echo BARN-CLONE-OK`
  ));

  if (!clone.includes('BARN-CLONE-OK')) {
    throw new Error(scrub(`could not clone ${ repo }: ${ clone.slice(0, 400) || 'no output' }`));
  }

  const encoded = btoa(IMPORT_SCRIPT);
  const script = '/tmp/barn-import.js';

  await podExecOnce(pod, asPodUser(`echo ${ encoded } | base64 -d > ${ script }`));

  const out = await podExecOnce(pod, asPodUser(
    `BARN_IMPORT_NAME=${ shellQuote(fallbackName) } node ${ script }`
  ));

  let tree: Record<string, string>;

  try {
    tree = JSON.parse(out);
  } catch {
    throw new Error(`could not read ${ repo }'s tree: ${ out.slice(0, 200) || 'no output' }`);
  }

  if (!Object.keys(tree).length) {
    throw new Error(`${ repo } has no files to import`);
  }

  // Tidy up after ourselves: this pod belongs to an extension somebody is working in, and a
  // clone left in its /tmp is the next person's confusion.
  await podExecOnce(pod, asPodUser('rm -rf /tmp/barn-import /tmp/barn-import.js')).catch(() => null);

  return withSkeleton(tree);
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
              // Which Service the browser is, so a terminal in here does not have to be
              // told. One browser serves every extension - see ensureBrowser. The name
              // rather than a URL on purpose: Chromium rejects a CDP request whose Host
              // header is not an IP, so this has to be resolved before it is used, and a
              // variable that looked like a working endpoint would be worse than none.
              { name: 'BARN_BROWSER_SERVICE', value: BROWSER_OBJECT },
              { name: 'BARN_BROWSER_CDP_PORT', value: `${ BROWSER_CDP_PORT }` },
              // Rancher's address from inside the cluster, which is the node's:
              // this cluster is k3s inside the Rancher container. With
              // DEV_PROXY_PATH above it is the whole absolute URL of this
              // extension's own dashboard, which is what the browser has to be
              // pointed at - a root-relative path means nothing to a driver.
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
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
    // Three kinds of source now: a built-in seed that is already in this bundle, a repository
    // to clone, and the name of an extension running here to copy out of its pod.
    const github = parseGithubSource(source);
    let files: Record<string, string>;

    if (BUILT_IN_SEEDS.includes(source)) {
      files = seedFiles(source);
    } else if (github) {
      files = await githubFiles(github.repo, github.ref, name);
    } else {
      files = await cloneFiles(source);
    }

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

// ---------------------------------------------------------------------------
// The browser the editor looks at its own changes in.
// ---------------------------------------------------------------------------

/**
 * One browser for the namespace, not one per extension.
 *
 * What it is for is claude in an extension pod being able to look at the page it
 * just changed, and that wants a browser that is already logged in and already
 * pointed somewhere rather than a fresh one per tree. It is also the most
 * expensive thing in here - Chromium with a desktop around it - so a second one
 * would be paid for again on every extension anybody creates.
 */
export const BROWSER_OBJECT = 'barn-browser';

/**
 * The image the closet's own browser sidecar runs, and the harness's Browser tab
 * with it: Chromium plus a web UI in front of it, so the thing a person frames is
 * a page rather than a screen protocol that would need a plugin.
 */
const BROWSER_IMAGE = 'lscr.io/linuxserver/chromium:latest';

/**
 * Its web UI, on the port CUSTOM_PORT tells it to serve. Plain http inside the
 * cluster, because Rancher's proxy terminates the TLS a person's browser sees and
 * would not talk to this image's self-signed certificate on the way through.
 */
const BROWSER_UI_PORT = 3000;

/**
 * Chromium's DevTools protocol, which is the half of this the workspace browser
 * does not have.
 *
 * That one drops its CDP flags on purpose, because it is there for a person to
 * look at. This one is driven: something opens a page, waits for the dev server
 * to finish compiling, reads the console and takes a screenshot, and none of that
 * is reachable through a web UI built for a mouse.
 *
 * It is bound to 0.0.0.0 and unauthenticated, which is worth saying plainly:
 * anything that can reach this Service can drive this browser, and this browser
 * holds a Rancher session. That is the same set of people who can already open a
 * terminal in an extension pod - see EXT_ACCOUNT - so it widens what is reachable
 * without widening who can reach it.
 */
const BROWSER_CDP_PORT = 9222;

/**
 * The ConfigMap holding the two s6 services the image runs alongside Chromium.
 *
 * Both are copies of the closet's own browser sidecar (`workspace/sidecars/dev/
 * rancher-browser/`), which runs this same image outside Kubernetes and needed
 * both for the same reasons. Copied rather than shared because an extension
 * bundle cannot read the repo it was built from, and kept as whole files rather
 * than command lines because each has an ordering in it.
 */
const BROWSER_SERVICES = 'barn-browser-services';

/**
 * Republishes CDP on the pod's own address.
 *
 * Headful Chromium binds its DevTools port to 127.0.0.1 and cannot be told not
 * to, so without this the Service's port 9222 answers connection refused from
 * everywhere except inside this container.
 *
 * The consequence for whoever drives it is the one thing to know about this
 * browser: Chromium validates the Host header on that port and rejects anything
 * that is not an IP or localhost, so `barn-browser:9222` gets a 403 while the
 * Service's ClusterIP works. See the seeded CLAUDE.md, which says so where it
 * will be read.
 */
const CDP_PROXY = String.raw`#!/usr/bin/with-contenv bash
# s6 service (mounted into /custom-services.d/): exposes Chromium's CDP to the
# compose network. Headful Chromium only binds 127.0.0.1:9222, so we forward
# <container-ip>:9222 -> 127.0.0.1:9222. Connect using the IP, not the
# service name — Chrome rejects non-localhost/non-IP Host headers.
exec python3 - <<'PYEOF'
import asyncio, socket

def container_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.connect(('10.255.255.255', 1))  # no traffic sent; selects default-route iface
    ip = s.getsockname()[0]
    s.close()
    return ip

async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass

async def handle(client_r, client_w):
    try:
        upstream_r, upstream_w = await asyncio.open_connection('127.0.0.1', 9222)
    except Exception:
        client_w.close()
        return
    await asyncio.gather(pipe(client_r, upstream_w), pipe(upstream_r, client_w))

async def main():
    ip = container_ip()
    server = await asyncio.start_server(handle, ip, 9222)
    print(f'cdp-proxy: {ip}:9222 -> 127.0.0.1:9222', flush=True)
    async with server:
        await server.serve_forever()

asyncio.run(main())
PYEOF
`;

/**
 * Holds one display client connected so screenshots keep working.
 *
 * Selkies resizes the virtual display to 1x1 when the last viewer disconnects,
 * and Page.captureScreenshot then hangs rather than failing. A browser that is
 * driven rather than watched is in that state almost always, which is why this
 * is here and not in the workspace browser: that one has a person in front of it.
 */
const STREAM_KEEPALIVE = String.raw`#!/usr/bin/with-contenv bash
# s6 service: hold ONE Selkies display client connected at all times so the
# virtual display never tears down to 1x1. Selkies resizes the display to 1x1
# when the LAST viewer disconnects; once it's 1x1, Chromium's CDP
# Page.captureScreenshot hangs forever (verified: it returns in ~50ms while a
# client is held, and HANGs ~10s after the last client leaves).
#
# We deliberately do NOT send START_VIDEO: a connected client alone keeps the
# display alive (verified across the teardown window), and streaming would just
# encode+transmit frames nothing reads. We also don't pin manual-resolution mode,
# so a real human viewer on :8303 connecting at their own size takes over cleanly.
# (Holding a client does cost ~8% of one core in the Selkies capture loop — that's
# inherent to this image whenever the display is held full-size for headless
# screenshots, not the video stream.)
exec python3 - <<'PYEOF'
import asyncio, json
import websockets

URI = "ws://127.0.0.1:3000/websocket"
# Minimal: assert a usable display size (so headless screenshots aren't 1x1),
# but not manual-resolution mode — a human viewer's own size then wins.
SETTINGS = "SETTINGS," + json.dumps({
    "initialClientWidth": 1280, "initialClientHeight": 800, "displayId": "primary",
})

async def run():
    delay = 1
    while True:
        try:
            async with websockets.connect(URI, max_size=None, ping_interval=20, open_timeout=10) as ws:
                await ws.send(SETTINGS)
                await ws.send("r,1280x800,primary")
                print("stream-keepalive: holding display (no video)", flush=True)
                delay = 1  # reset backoff once a session is established
                async for _ in ws:  # stay connected; drain any server messages
                    pass
        except Exception as e:
            # Selkies not up yet (boot) or the connection dropped — back off so we
            # don't churn/log-spam every 3s indefinitely if it never comes up.
            print(f"stream-keepalive: reconnect in {delay}s ({e})", flush=True)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30)

asyncio.run(run())
PYEOF
`;

/** Where a person watches it: the same service proxy every other page here is on. */
export function browserUrl(): string {
  return `${ EXT_BASE }/api/v1/namespaces/${ EXT_NS }/services/http:${ BROWSER_OBJECT }:${ BROWSER_UI_PORT }/proxy/`;
}

function browserDeployment(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace: EXT_NS, name: BROWSER_OBJECT, labels: { app: BROWSER_OBJECT } },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: BROWSER_OBJECT } },
      // Recreate rather than RollingUpdate: two Chromiums sharing one profile
      // directory is a browser that will not start, and the second one wins the
      // race often enough to look intermittent.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { app: BROWSER_OBJECT } },
        spec:     {
          containers: [{
            name:  'browser',
            image: BROWSER_IMAGE,
            ports: [
              { name: 'http', containerPort: BROWSER_UI_PORT },
              { name: 'cdp', containerPort: BROWSER_CDP_PORT },
            ],
            env: [
              // The image runs as this user and writes its profile as it. A
              // root-owned profile in a container that then drops privileges is a
              // browser that cannot start twice.
              { name: 'PUID', value: '1000' },
              { name: 'PGID', value: '1000' },
              { name: 'CUSTOM_PORT', value: `${ BROWSER_UI_PORT }` },
              { name: 'TITLE', value: 'Barn' },
              // The node's address, which is the one thing in here nothing else
              // knows: the kubelet telling the pod where it is running. This
              // cluster is k3s inside the Rancher container, so the node and
              // Rancher are the same address, and it is how a pod reaches Rancher
              // without being told a hostname. Declared before CHROME_CLI because
              // Kubernetes expands $(VAR) only against variables already listed.
              { name: 'NODE_IP', valueFrom: { fieldRef: { fieldPath: 'status.hostIP' } } },
              {
                name: 'CHROME_CLI',
                // What it opens on: the default extension's dev server, through
                // the same service proxy a person would reach it at, on Rancher's
                // own origin. It opens on Rancher's login page the first time,
                // because a fresh profile has no session - see the CLAUDE.md in
                // the seed for the log-in-then-navigate the driver does about it.
                //
                // --ignore-certificate-errors is the flag that is not cosmetic:
                // Rancher serves its own certificate here and without this the
                // browser opens on an interstitial instead of the page.
                // --remote-allow-origins is the one that is easy to miss: recent
                // Chromium refuses a CDP websocket whose Origin it does not know,
                // which reads as a driver that connects and then hangs.
                // The backgrounding flags are not cosmetic either: Chromium throttles a
                // renderer nothing is looking at, and a driven browser is exactly that, so
                // without them Page.captureScreenshot answers slowly or not at all.
                //
                // --remote-debugging-address is deliberately absent. Headful Chromium binds
                // CDP to 127.0.0.1 whatever it is told, so that flag is a no-op that would
                // only fight the forwarder below for the port if a future Chromium honoured
                // it. The closet's own browser sidecar says the same thing at more length.
                value: `https://$(NODE_IP)${ extensionUrl(DEFAULT_EXTENSION) } --no-first-run --start-maximized --disable-infobars --disable-session-crashed-bubble --hide-crash-restore-bubble --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --allow-insecure-localhost --ignore-certificate-errors --remote-debugging-port=${ BROWSER_CDP_PORT } --allow-running-insecure-content`,
              },
            ],
            // A memory-backed /dev/shm rather than the 64MB a container gets by
            // default. It is the pod's own memory, and Chromium is the one thing
            // here that has ever needed it: below about this, a page with a
            // dashboard in it crashes the tab rather than rendering slowly.
            volumeMounts: [
              { name: 'dshm', mountPath: '/dev/shm' },
              // One mount per file with subPath, because each of these is a file the image
              // runs, not a directory: /custom-services.d holds one executable per service.
              { name: 'services', mountPath: '/custom-services.d/cdp-proxy', subPath: 'cdp-proxy', readOnly: true },
              { name: 'services', mountPath: '/custom-services.d/stream-keepalive', subPath: 'stream-keepalive', readOnly: true },
            ],
            // Ready when CDP answers, not when the container starts. The web UI
            // comes up before Chromium does, so probing the UI port would say
            // ready to a driver that then gets connection refused.
            readinessProbe: {
              httpGet:       { path: '/json/version', port: BROWSER_CDP_PORT },
              periodSeconds: 10,
            },
          }],
          volumes: [
            // A container gets 64MB of shared memory by default and Chromium's renderers pass
            // their surfaces through it: the documented symptom of leaving it there is tabs
            // dying as "Aw, Snap". Memory-backed, so it is the pod's own memory.
            { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '1Gi' } },
            // 0o555: the image execs these, so they have to arrive executable.
            { name: 'services', configMap: { name: BROWSER_SERVICES, defaultMode: 0o555 } },
          ],
        },
      },
    },
  };
}

let ensureBrowserInFlight: Promise<void> | null = null;

/**
 * Create the browser's Deployment and Service if they aren't there yet.
 *
 * Idempotent, deduped in flight and error-swallowing, for the same reasons
 * ensureExtension is: it runs when the bundle loads, in front of a page, on
 * behalf of somebody who may not be allowed to create any of it.
 *
 * Create-if-missing rather than upsert, because replacing the Deployment
 * restarts the browser - which throws away the Rancher session in its profile
 * and whatever page somebody was looking at.
 */
export function ensureBrowser(): Promise<void> {
  if (ensureBrowserInFlight) {
    return ensureBrowserInFlight;
  }

  ensureBrowserInFlight = (async() => {
    await ensureShared();

    // The s6 services (upsert, unlike the Deployment below): a fixed script that has been
    // corrected reaches an existing cluster on the next load, and the pod reads them at
    // boot, so the correction lands the next time it restarts rather than needing one.
    const services = { 'cdp-proxy': CDP_PROXY, 'stream-keepalive': STREAM_KEEPALIVE };
    const cm = await extGet('configmaps', BROWSER_SERVICES);

    if (cm) {
      await rancherFetch(`${ EXT_BASE }/v1/configmaps/${ EXT_NS }/${ BROWSER_SERVICES }`, {
        method: 'PUT',
        body:   JSON.stringify({ ...cm, data: services }),
      }).catch(() => null);
    } else {
      await rancherFetch(`${ EXT_BASE }/v1/configmaps`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'ConfigMap',
          metadata:   { namespace: EXT_NS, name: BROWSER_SERVICES, labels: { app: BROWSER_OBJECT } },
          data:       services,
        }),
      }).catch(() => null);
    }

    if (!await extGet('apps.deployments', BROWSER_OBJECT)) {
      await rancherFetch(`${ EXT_BASE }/v1/apps.deployments`, {
        method: 'POST',
        body:   JSON.stringify(browserDeployment()),
      }).catch(() => null);
    }

    if (!await extGet('services', BROWSER_OBJECT)) {
      await rancherFetch(`${ EXT_BASE }/v1/services`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'Service',
          metadata:   { namespace: EXT_NS, name: BROWSER_OBJECT, labels: { app: BROWSER_OBJECT } },
          spec:       {
            selector: { app: BROWSER_OBJECT },
            ports:    [
              { name: 'http', port: BROWSER_UI_PORT, targetPort: 'http' },
              { name: 'cdp', port: BROWSER_CDP_PORT, targetPort: 'cdp' },
            ],
          },
        }),
      }).catch(() => null);
    }
  })().finally(() => {
    ensureBrowserInFlight = null;
  });

  return ensureBrowserInFlight;
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

/**
 * One commit's diff, as the text `git show` produces.
 *
 * Parsed by DiffView into files, hunks and numbered lines, which is what makes it look like the
 * diff on a pull request rather than like terminal output pasted into a dialog.
 *
 * No `--stat`, because DiffView counts its own totals from the patch, and no colour, because
 * this goes into HTML rather than a terminal.
 */
export async function showCommit(name: string, sha: string): Promise<string> {
  return inPackage(name, `git show --patch --no-color ${ shellQuote(sha) } 2>&1`);
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
// ---------------------------------------------------------------------------
// What the editor is configured with.
// ---------------------------------------------------------------------------

/**
 * One Secret in the extensions' own namespace, holding what the editor needs and does not
 * generate: today a GitHub token and the repository it belongs to.
 *
 * A Secret rather than localStorage, and not because a token is dramatic. It is that the
 * thing which eventually uses it is a pod: publishing runs in the extension's own container,
 * so a credential kept in one person's browser is a credential the build cannot reach.
 */
export const SETTINGS_SECRET = 'barn-settings';

/** The key names are the Secret's, so `kubectl get secret barn-settings -o yaml` reads plainly. */
export const TOKEN_KEY = 'gh_token';

/**
 * The repository is per extension; the token is not.
 *
 * A token is an account's, and the account is the person using this - one of them, reused by
 * everything they publish. A repository is the extension's own: two extensions in here are two
 * separate things that belong in two separate repositories, and a single setting would mean
 * publishing one of them over the other. Which has to be a setting rather than a convention
 * because the name in the pod and the name of a repository agree only by luck.
 *
 * A Secret key may hold `[-._a-zA-Z0-9]`, and an extension's name is normalised into that same
 * alphabet before it ever names an object (see normalizeExtensionName), so this cannot produce
 * a key Kubernetes will reject.
 */
export function repoKey(extension: string): string {
  return `gh_repo.${ extension }`;
}

export interface EditorSettings {
  /**
   * Whether a token is stored - never the token itself.
   *
   * A credential that has been saved does not come back out to a page. What a settings form
   * needs to know is whether the field is already filled, which this answers, and the field
   * then says "leave blank to keep" rather than showing a value somebody could shoulder-read.
   */
  hasToken: boolean;
  /** `owner/name`. Not a secret, so it comes back as typed and the field can show it. */
  repo: string;
}

/** UTF-8 safe, because btoa alone throws on anything outside latin-1 and a repo name can be. */
function encodeSecret(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)));
}

function decodeSecret(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(value), (c) => c.charCodeAt(0)));
}

/**
 * What is configured for one extension. Absent, unreadable and empty Secret are all "nothing yet".
 *
 * The token half of the answer is the same whichever extension asks; the repository half is
 * that extension's own.
 */
export async function readSettings(extension: string): Promise<EditorSettings> {
  const secret = await extGet('secrets', SETTINGS_SECRET);
  const data = secret?.data || {};
  const repo = data[repoKey(extension)];

  return {
    hasToken: !!data[TOKEN_KEY],
    repo:     repo ? decodeSecret(repo) : '',
  };
}

/**
 * Write only the keys that were touched.
 *
 * A field the form left `undefined` is not in `changes` and is not written, which is what stops
 * opening settings and saving from blanking a token nobody could see. `''` is a deliberate
 * clear, and is the only way to remove one.
 */
export async function saveSettings(extension: string, changes: { token?: string; repo?: string }): Promise<void> {
  const existing = await extGet('secrets', SETTINGS_SECRET);
  const data: Record<string, string> = { ...(existing?.data || {}) };
  const apply = (key: string, value: string | undefined) => {
    if (value === undefined) {
      return;
    }
    if (value === '') {
      delete data[key];
    } else {
      data[key] = encodeSecret(value);
    }
  };

  apply(TOKEN_KEY, changes.token);
  apply(repoKey(extension), changes.repo);

  await ensureShared();

  if (existing) {
    await rancherFetch(`${ EXT_BASE }/v1/secrets/${ EXT_NS }/${ SETTINGS_SECRET }`, {
      method: 'PUT',
      body:   JSON.stringify({ ...existing, data }),
    });
  } else {
    await rancherFetch(`${ EXT_BASE }/v1/secrets`, {
      method: 'POST',
      body:   JSON.stringify({
        apiVersion: 'v1',
        kind:       'Secret',
        type:       'Opaque',
        metadata:   { namespace: EXT_NS, name: SETTINGS_SECRET },
        data,
      }),
    });
  }
}

/** The token itself, for the one caller that has to send it somewhere. Never for a page. */
async function readToken(): Promise<string> {
  const secret = await extGet('secrets', SETTINGS_SECRET);

  return secret?.data?.[TOKEN_KEY] ? decodeSecret(secret.data[TOKEN_KEY]) : '';
}

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


export const GITHUB_PUBLISH_STAGES = [
  'Reading the settings',
  'Reading the package',
  'Committing the package',
  'Pushing to GitHub',
];

/**
 * Push the extension's own source to the repository configured in settings.
 *
 * The other Publish builds a bundle and points this Rancher at it, which reaches exactly the
 * cluster you are standing in. This one is the other half: the package is already a git
 * repository in the pod (see ensureExtensionRepo), so publishing it is adding a remote and
 * pushing, and what comes out is a repository somebody else can build from.
 *
 * It pushes source rather than a built bundle deliberately. A chart repository is built by the
 * receiving repository's own workflow from a tagged version - that is how barn itself is
 * published - and a bundle committed by hand would be the same artifact with no provenance.
 *
 * The token never reaches this page and never reaches the returned log: it is read straight
 * out of the Secret into the command, and scrubbed out of the output before it comes back. See
 * scrub below, which is not decoration - the log is shown in the UI when a publish fails.
 *
 * The repository is asked for at the point of publishing rather than configured beforehand,
 * because it is a decision about this push and not a property of the extension. It is
 * remembered afterwards so the next one only has to be agreed with, which is the difference
 * between a cache and a setting: the answer is kept, but the question is still asked.
 */
export async function publishExtensionToGithub(name: string, repo: string, onProgress?: PublishProgress): Promise<GithubPublishResult> {
  const total = GITHUB_PUBLISH_STAGES.length;
  const report = (stage: number) => onProgress?.(stage, GITHUB_PUBLISH_STAGES[stage - 1], total);

  report(1);

  const token = await readToken();

  if (!repo) {
    throw new PublishError('No repository was given.', GITHUB_PUBLISH_STAGES[0], '');
  }

  if (!token) {
    throw new PublishError('No GitHub token is configured. Add one in the editor settings.', GITHUB_PUBLISH_STAGES[0], '');
  }

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new PublishError(`"${ repo }" is not owner/name`, GITHUB_PUBLISH_STAGES[0], '');
  }

  // Remembered before the push rather than after it. A push that fails is the one most likely
  // to be tried again, and retyping the repository to do so is the annoyance this avoids.
  await saveSettings(name, { repo }).catch(() => null);

  const pod = await extensionPod(name);

  if (!pod) {
    throw new PublishError(`${ name } has no running pod to push from`, GITHUB_PUBLISH_STAGES[0], '');
  }

  report(2);

  const { name: plugin, version } = await packageIdentity(name);

  // The same basic auth GitHub Actions uses for a token: the header rather than the URL, so it
  // is not written into .git/config where the next person to open a terminal would find it.
  const auth = btoa(`x-access-token:${ token }`);
  const remote = `https://github.com/${ repo }.git`;
  const scrub = (text: string) => text.split(token).join('***').split(auth).join('***');

  // A repository to push, which for a pod that has never had one is one `git init`.
  await ensureExtensionRepo(name);

  report(3);

  const commitLog = await inPackage(name, [
    'git add -A',
    // Nothing to commit is not a failure: the push below is still worth making, because the
    // last one may have been what failed.
    `git diff --cached --quiet || git -c user.email=barn@rancher.local -c user.name=barn commit -q -m ${ shellQuote(`${ plugin } ${ version }`) }`,
    'echo BARN-COMMIT-OK',
  ].join(' ; '));

  if (!commitLog.includes('BARN-COMMIT-OK')) {
    throw new PublishError('the package could not be committed', GITHUB_PUBLISH_STAGES[2], scrub(commitLog));
  }

  report(4);

  const pushLog = await inPackage(name, [
    `git -c http.extraheader=${ shellQuote(`AUTHORIZATION: basic ${ auth }`) } push ${ shellQuote(remote) } HEAD:refs/heads/main 2>&1`,
    'echo BARN-PUSH-OK',
  ].join(' && '));

  if (!pushLog.includes('BARN-PUSH-OK')) {
    throw new PublishError(`could not push to ${ repo }`, GITHUB_PUBLISH_STAGES[3], scrub(pushLog));
  }

  return {
    plugin, version, repo, url: `https://github.com/${ repo }`, log: scrub(pushLog),
  };
}

export interface GithubPublishResult {
  plugin: string;
  version: string;
  repo: string;
  url: string;
  log: string;
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
