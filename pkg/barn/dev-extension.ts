// ---------------------------------------------------------------------------
// DevExtension: a Rancher extension whose dev server runs as a pod in the
// cluster, and is edited inside that pod.
//
// The pod runs `vue-cli-service serve` over the tree in
// pkg/barn/dev-extension/, which is a whole dashboard with the
// dev-extension package compiled in. The browser reaches it through the
// Kubernetes apiserver's service proxy, on Rancher's own origin, so it is a
// second, live-reloading dashboard at a URL of its own, and Rancher's own UI
// and its `ui-dashboard-index` setting are left completely alone.
//
// Everything it needs travels with this extension: the source is baked in as a
// seed (dev-extension-seed.generated.ts) and written into a ConfigMap, the pod
// installs from it on first boot, and ensureDevExtension() is called when the
// extension loads. There is no install step and nothing to run outside the
// cluster.
//
// Editing is done in the pod. That tree is the live source once it has booted:
//   kubectl -n barn exec -it deploy/barn-dev-extension \
//     -- bash -c 'cd /app/pkg/dev-extension && exec bash'
// ---------------------------------------------------------------------------
import { rancherFetch } from './api';
import { SEED_FILES } from './dev-extension-seed.generated';

// The `local` cluster, like the editor's content pod: the extension loads in
// contexts that have no cluster of their own, and the dev server should be at
// one URL regardless of where you were when you opened it.
const DEV_CLUSTER = 'local';
const DEV_NS = 'barn';
const DEV_NAME = 'barn-dev-extension';
const DEV_PORT = 8005;

// The one container in the pod. Named here because two things address it: the
// Deployment below creates it, and a terminal tab execs into it.
const DEV_CONTAINER = 'devserver';

// Plain node, not a built image: the pod installs from the seeded package.json,
// so there is nothing to publish and nothing that can be older than the source.
const DEV_IMAGE = 'node:24';

// Where the node keeps the working tree and node_modules between pod restarts.
// The install is minutes and the tree is what you edit, so neither can live in
// the pod's own filesystem.
const HOST_CACHE_PATH = '/var/lib/rancher/barn/dev-extension';

const DEV_BASE = `/k8s/clusters/${ DEV_CLUSTER }`;

/** ConfigMap keys cannot contain '/', so paths are flattened and boot.sh rebuilds them. */
export const PATH_SEPARATOR = '__';

function encodeSeedKey(filePath: string): string {
  return filePath.split('/').join(PATH_SEPARATOR);
}

/**
 * The apiserver's service-proxy path in front of the dev server.
 *
 * Root-relative on purpose: the browser resolves it against Rancher's own
 * origin, so neither this extension nor the pod ever learns what hostname
 * Rancher is served on. It is also the only thing the pod's vue.config.js is
 * given: asset URLs, the router base and the hot-reload socket are all derived
 * from it, out of the same constants that name the Service just below.
 */
export function devExtensionProxyPath(): string {
  return `${ DEV_BASE }/api/v1/namespaces/${ DEV_NS }/services/http:${ DEV_NAME }:${ DEV_PORT }/proxy`;
}

/** Where to point a browser at the dev dashboard. */
export function devExtensionUrl(): string {
  return `${ devExtensionProxyPath() }/`;
}

/**
 * Whether the dev server is serving yet.
 *
 * First boot installs and compiles for a few minutes, and until it does the
 * service proxy answers with an error of its own ("no endpoints available")
 * rather than the dashboard. Anything that frames the dev server waits on this,
 * so what it shows in the meantime is its own, not the proxy's error page.
 */
export async function devExtensionReady(): Promise<boolean> {
  try {
    // Not rancherFetch: that one expects JSON, and this is the dashboard's HTML.
    const resp = await fetch(`${ devExtensionProxyPath() }/index.html`, { cache: 'no-store' });

    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * The running dev server pod, or null while there isn't one.
 *
 * A terminal tab needs the pod by name, because exec is a subresource of the pod
 * rather than of the Deployment or the Service. Steve ignores labelSelector, so
 * the filtering is done here.
 *
 * `Running` is the bar, not `Ready`: the pod is ready only once the dev server
 * serves, which is minutes on a first boot, and a shell is useful (arguably most
 * useful) before then.
 */
export async function devExtensionPod(): Promise<string | null> {
  const pods = await rancherFetch(`${ DEV_BASE }/v1/pods/${ DEV_NS }`).catch(() => null);

  const running = (pods?.data || []).find((pod: any) => (
    pod.metadata?.labels?.app === DEV_NAME &&
    pod.status?.phase === 'Running' &&
    !pod.metadata?.deletionTimestamp
  ));

  return running?.metadata?.name || null;
}

/**
 * WebSocket URL for a shell in that pod.
 *
 * This is the Kubernetes exec subresource, the same one the dashboard's own
 * container shell uses, so it carries the browser's Rancher session and needs
 * nothing else to authenticate. The protocol is `base64.channel.k8s.io`: every
 * frame is a channel digit (0 stdin, 1 stdout, 2 stderr, 3 error, 4 resize)
 * followed by base64.
 *
 * The command is `/seed/shell.sh`, which is in the pod's ConfigMap rather than
 * its filesystem, so what a tab starts is whatever the extension last wrote.
 */
export function devExtensionShellUrl(pod: string, session: string): string {
  const origin = window.location.origin.replace(/^http/, 'ws');
  const params = new URLSearchParams({
    container: DEV_CONTAINER,
    stdin:     '1',
    stdout:    '1',
    stderr:    '1',
    tty:       '1',
  });

  // Repeated, not comma-joined: this is argv.
  for (const arg of ['/bin/sh', '/seed/shell.sh', session]) {
    params.append('command', arg);
  }

  return `${ origin }${ DEV_BASE }/api/v1/namespaces/${ DEV_NS }/pods/${ pod }/exec?${ params }`;
}

// GET a Steve resource; resolve null if it isn't there yet.
function devGet(type: string): Promise<any> {
  return rancherFetch(`${ DEV_BASE }/v1/${ type }/${ DEV_NS }/${ DEV_NAME }`).catch(() => null);
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

function deployment(): Record<string, unknown> {
  return {
    apiVersion: 'apps/v1',
    kind:       'Deployment',
    metadata:   { namespace: DEV_NS, name: DEV_NAME },
    spec:       {
      replicas: 1,
      selector: { matchLabels: { app: DEV_NAME } },
      // Recreate, not RollingUpdate: /app is a hostPath, so two dev servers
      // would be watching and rebuilding the same tree at the same time.
      strategy: { type: 'Recreate' },
      template: {
        metadata: { labels: { app: DEV_NAME } },
        spec:     {
          containers: [{
            name:    DEV_CONTAINER,
            image:   DEV_IMAGE,
            command: ['/bin/sh', '/seed/boot.sh'],
            ports:   [{ name: 'http', containerPort: DEV_PORT }],
            env:     [
              { name: 'DEV_PROXY_PATH', value: devExtensionProxyPath() },
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
              httpGet:          { path: '/index.html', port: DEV_PORT },
              periodSeconds:    10,
              failureThreshold: 90,
            },
            readinessProbe: {
              httpGet:       { path: '/index.html', port: DEV_PORT },
              periodSeconds: 10,
            },
          }],
          volumes: [
            { name: 'seed', configMap: { name: DEV_NAME } },
            { name: 'app', hostPath: { path: HOST_CACHE_PATH, type: 'DirectoryOrCreate' } },
          ],
        },
      },
    },
  };
}

let ensureDevInFlight: Promise<void> | null = null;

/**
 * Create the namespace + seed ConfigMap + dev server Deployment + Service if
 * they aren't there yet.
 *
 * Idempotent and safe to call repeatedly (dedup'd in-flight); swallows errors
 * (e.g. the user lacks create rights) so it can never break a page. The
 * ConfigMap is upserted so a newer seed reaches an existing cluster; the
 * Deployment and Service are create-if-missing, because replacing them would
 * restart a dev server somebody is editing in.
 */
export function ensureDevExtension(): Promise<void> {
  if (ensureDevInFlight) {
    return ensureDevInFlight;
  }

  ensureDevInFlight = (async() => {
    // Namespace (shared with the editor's content pod)
    const ns = await rancherFetch(`${ DEV_BASE }/v1/namespaces/${ DEV_NS }`).catch(() => null);

    if (!ns) {
      await rancherFetch(`${ DEV_BASE }/v1/namespaces`, {
        method: 'POST',
        body:   JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: DEV_NS } }),
      }).catch(() => null);
    }

    // Seed ConfigMap (upsert). The pod only writes seeded files it doesn't
    // already have, so this adds new files to a running tree without touching
    // what has been edited in there.
    const cm = await devGet('configmaps');
    const data = seedData();

    if (cm) {
      await rancherFetch(`${ DEV_BASE }/v1/configmaps/${ DEV_NS }/${ DEV_NAME }`, {
        method: 'PUT',
        body:   JSON.stringify({ ...cm, data }),
      }).catch(() => null);
    } else {
      await rancherFetch(`${ DEV_BASE }/v1/configmaps`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'ConfigMap',
          metadata:   { namespace: DEV_NS, name: DEV_NAME },
          data,
        }),
      }).catch(() => null);
    }

    // Deployment (node running the dev server over the seeded tree)
    if (!await devGet('apps.deployments')) {
      await rancherFetch(`${ DEV_BASE }/v1/apps.deployments`, {
        method: 'POST',
        body:   JSON.stringify(deployment()),
      }).catch(() => null);
    }

    // Service (ClusterIP :8005, what the service proxy above resolves to)
    if (!await devGet('services')) {
      await rancherFetch(`${ DEV_BASE }/v1/services`, {
        method: 'POST',
        body:   JSON.stringify({
          apiVersion: 'v1',
          kind:       'Service',
          metadata:   { namespace: DEV_NS, name: DEV_NAME },
          spec:       { selector: { app: DEV_NAME }, ports: [{ name: 'http', port: DEV_PORT, targetPort: 'http' }] },
        }),
      }).catch(() => null);
    }
  })().finally(() => {
    ensureDevInFlight = null;
  });

  return ensureDevInFlight;
}
