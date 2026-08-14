export const PRODUCT_NAME = 'devextension';
export const CUSTOM_PAGE_NAME = 'home';

// Rancher's stand-in cluster id for a product that has no cluster of its own.
export const BLANK_CLUSTER = '_';

export const HOME_ROUTE = `${ PRODUCT_NAME }-c-cluster-${ CUSTOM_PAGE_NAME }`;

/**
 * The Floof page, which lives in Rancher's Cluster Explorer rather than in this extension's
 * own product.
 *
 * Hence the naming: explorer pages are `c-cluster-<product>-<page>`, matching the shell's own
 * (`c-cluster-explorer-tools`, `c-cluster-explorer-workload-dashboard`). Getting this wrong
 * is the usual reason an extension page renders without the cluster nav around it - the route
 * has to sit under the explorer's parent for the surrounding chrome to come with it.
 */
export const EXPLORER_PRODUCT = 'explorer';
export const FLOOF_PAGE = 'floof';
export const FLOOF_ROUTE = `c-cluster-${ EXPLORER_PRODUCT }-${ FLOOF_PAGE }`;

/**
 * The Dev product: the Claude Harness, rebuilt on Kubernetes.
 *
 * A second product in the same extension rather than more pages in the first one, because the
 * two have nothing to do with each other: `devextension` exists to prove the live-reload loop
 * works, this one is a tool with its own nav. Its routes follow the same
 * `/{product}/c/:cluster/` shape and the same BLANK_CLUSTER param, since it owns no cluster
 * either.
 *
 * The thing this product manages is a workspace, not a project. The harness calls it a
 * project, but Rancher already means something specific by that word - a group of namespaces
 * inside a cluster, with its own members and quotas - and it means it in the very nav this
 * product sits next to. So the harness's word is dropped at the border rather than carried
 * in and left to collide.
 */
export const DEV_PRODUCT = 'dev';

export const WORKSPACES_PAGE = 'workspaces';
export const CREATE_PAGE = 'create';
export const MY_WORK_PAGE = 'my-work';
export const INSIGHTS_PAGE = 'insights';
export const SETTINGS_PAGE = 'settings';

/** The product's own page template, which every page below is a child of. */
export const DEV_SHELL_ROUTE = `${ DEV_PRODUCT }-c-cluster`;

export const WORKSPACES_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ WORKSPACES_PAGE }`;
export const WORKSPACE_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ WORKSPACES_PAGE }-workspace`;
export const CREATE_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ CREATE_PAGE }`;
export const MY_WORK_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ MY_WORK_PAGE }`;
export const INSIGHTS_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ INSIGHTS_PAGE }`;
export const SETTINGS_ROUTE = `${ DEV_PRODUCT }-c-cluster-${ SETTINGS_PAGE }`;

/**
 * The tabs a workspace opens as, and the one a link with no tab in it means.
 *
 * Conversations is first and is the default, because it is the reason to open a workspace at
 * all. There is no Overview: what it held was the namespace, the Deployment, the Service and
 * the pod, which are plumbing, and the two facts on it anyone acts on are elsewhere already,
 * the state on the sidebar's row and the ports in the Ports tab. A link to `#overview` lands on
 * Conversations, since an unknown tab falls back to the default.
 *
 * Named here rather than in the page because the route carries a tab (see routing/index.ts):
 * the tab is part of the address so that a tab can be linked to and shared, which is the whole
 * reason it is not component state. The list is also what the page validates against, so a URL
 * naming a tab that does not exist lands on Overview instead of on an empty pane.
 */
export const WORKSPACE_TABS = ['conversations', 'browser', 'ports', 'sidecars'];
export const DEFAULT_WORKSPACE_TAB = 'conversations';

/**
 * The pod this dashboard is served from, which is what the global terminal attaches to.
 *
 * Repeated here rather than imported from the barn extension that creates it, because
 * that package is not in this one's tree: the pod is seeded with `pkg/dev-extension` and
 * nothing else, so an import of it would compile in a checkout and fail in the pod that
 * actually runs this. Three constants, all of them things that would break loudly rather than
 * silently if they drifted: the terminal would say it is waiting for a pod that is right
 * there.
 */
export const DEV_POD_NAMESPACE = 'barn';
export const DEV_POD_LABELS = { app: 'barn-dev-extension' };
export const DEV_POD_CONTAINER = 'devserver';

/**
 * The tmux session prefix for a global terminal.
 *
 * `/seed/shell.sh <id> <dir>` starts or reattaches `mc-<id>`, and the editor's pane in the
 * barn extension uses `editor`, so anything not called that is a session of its own.
 * The numbers after it are the drawer's terminal numbers, so Terminal 2 is always the same
 * conversation, whether it was closed and reopened or reached from a link (see terminals.ts).
 */
export const TERMINAL_SESSION_PREFIX = 'global';
