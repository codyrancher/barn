import { RouteRecordRaw } from 'vue-router';
import { PluginRouteRecordRaw } from '@shell/core/types';
import {
  PRODUCT_NAME, CUSTOM_PAGE_NAME, BLANK_CLUSTER, HOME_ROUTE,
  EXPLORER_PRODUCT, FLOOF_PAGE, FLOOF_ROUTE,
  DEV_PRODUCT, WORKSPACES_PAGE, TEMPLATES_PAGE, CREATE_PAGE,
  TERMINAL_PAGE, MY_WORK_PAGE, SETTINGS_PAGE,
  WORKSPACES_ROUTE, WORKSPACE_ROUTE, CREATE_ROUTE, TEMPLATES_ROUTE,
  TERMINAL_ROUTE, MY_WORK_ROUTE, SETTINGS_ROUTE
} from '../config/constants';
import DevHome from '../pages/DevHome.vue';
import Floof from '../pages/Floof.vue';
import Workspaces from '../pages/Workspaces.vue';
import CreateWorkspace from '../pages/CreateWorkspace.vue';
import WorkspaceDetail from '../pages/WorkspaceDetail.vue';
import Templates from '../pages/Templates.vue';
import GlobalTerminal from '../pages/GlobalTerminal.vue';
import MyWork from '../pages/MyWork.vue';
import Settings from '../pages/Settings.vue';

/**
 * This extension's own product page. Top-level products need the `/{product}/c/:cluster/`
 * shape and the BLANK_CLUSTER param, since they have no cluster of their own.
 */
const ownRoutes: RouteRecordRaw[] = [
  {
    name:      HOME_ROUTE,
    path:      `/${ PRODUCT_NAME }/c/:cluster/${ CUSTOM_PAGE_NAME }`,
    component: DevHome,
    meta:      {
      product: PRODUCT_NAME,
      cluster: BLANK_CLUSTER
    }
  }
];

/**
 * Floof, which belongs to Rancher's Cluster Explorer rather than to this extension.
 *
 * `parent: 'default'` is what makes it an explorer page rather than a bare page at an
 * explorer-shaped URL. The shell's own cluster pages are children of the `default` template
 * route (shell/config/router/routes.js), which is what supplies the side nav, the cluster
 * switcher and the header. Registered at the top level instead, the component renders alone
 * on a blank page - the usual symptom of getting this wrong.
 *
 * `meta.product` is equally load-bearing: it tells the shell which product's nav to show and
 * which entry to highlight. Without it the page renders inside the explorer but the nav does
 * not know Floof is the current page.
 */
const explorerRoutes: PluginRouteRecordRaw[] = [
  {
    parent: 'default',
    route:  {
      name:      FLOOF_ROUTE,
      path:      `/c/:cluster/${ EXPLORER_PRODUCT }/${ FLOOF_PAGE }`,
      component: Floof,
      meta:      { product: EXPLORER_PRODUCT }
    }
  }
];

/**
 * The Dev product's pages.
 *
 * Same shape as ownRoutes above and for the same reasons: `/{product}/c/:cluster/` with
 * BLANK_CLUSTER, and `meta.product` so the shell knows whose nav to draw and which entry to
 * highlight. `meta.cluster` matters as much: without it the shell tries to resolve `_` as a
 * real cluster and the page renders with no nav around it.
 *
 * The create page is deliberately a sibling of the list rather than a child of it. Nested
 * under `workspaces/`, `create` would also match the detail route's `:workspace` param, and
 * which of the two won would come down to registration order.
 *
 * Being a sibling costs it the nav highlight, which the shell derives from the path: the list
 * and the detail page light Workspaces up because their paths start with the nav entry's, and
 * `/dev/c/_/create` does not. `meta.nav` is the shell's own answer to exactly that (see
 * isNavItemActive in shell/utils/router.js) - it names the nav path to highlight, with route
 * params substituted in, so `:cluster` resolves to whichever cluster the page was reached at.
 */
const devRoutes: RouteRecordRaw[] = [
  {
    name:      WORKSPACES_ROUTE,
    path:      `/${ DEV_PRODUCT }/c/:cluster/${ WORKSPACES_PAGE }`,
    component: Workspaces,
    meta:      { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
  },
  {
    name:      CREATE_ROUTE,
    path:      `/${ DEV_PRODUCT }/c/:cluster/${ CREATE_PAGE }`,
    component: CreateWorkspace,
    meta:      {
      product: DEV_PRODUCT,
      cluster: BLANK_CLUSTER,
      nav:     `/${ DEV_PRODUCT }/c/:cluster/${ WORKSPACES_PAGE }`
    }
  },
  {
    // A workspace's tab is not in this path. It is the hash, and pages/WorkspaceDetail.vue
    // says why: a path segment per tab, which is the shape the harness uses, remounts the page
    // on every tab click and leaks a shell into the pod each time.
    name:      WORKSPACE_ROUTE,
    path:      `/${ DEV_PRODUCT }/c/:cluster/${ WORKSPACES_PAGE }/:workspace`,
    component: WorkspaceDetail,
    meta:      { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
  },
  {
    name:      TEMPLATES_ROUTE,
    path:      `/${ DEV_PRODUCT }/c/:cluster/${ TEMPLATES_PAGE }`,
    component: Templates,
    meta:      { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
  },
  {
    // `:terminal?` is a terminal's number, so a link can open one. The terminals themselves
    // live in Rancher's window manager rather than on this page, which is why the page puts the
    // address back afterwards (see pages/GlobalTerminal.vue).
    name:      TERMINAL_ROUTE,
    path:      `/${ DEV_PRODUCT }/c/:cluster/${ TERMINAL_PAGE }/:terminal?`,
    component: GlobalTerminal,
    meta:      { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
  },
  {
    name:      MY_WORK_ROUTE,
    path:      `/${ DEV_PRODUCT }/c/:cluster/${ MY_WORK_PAGE }`,
    component: MyWork,
    meta:      { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
  },
  {
    name:      SETTINGS_ROUTE,
    path:      `/${ DEV_PRODUCT }/c/:cluster/${ SETTINGS_PAGE }`,
    component: Settings,
    meta:      { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
  }
];

export default [...ownRoutes, ...devRoutes, ...explorerRoutes];
