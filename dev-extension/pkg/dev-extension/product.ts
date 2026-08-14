import { IPlugin } from '@shell/core/types';
import {
  PRODUCT_NAME, CUSTOM_PAGE_NAME, BLANK_CLUSTER, HOME_ROUTE,
  EXPLORER_PRODUCT, FLOOF_PAGE, FLOOF_ROUTE,
  DEV_PRODUCT, WORKSPACES_PAGE, TEMPLATES_PAGE, TERMINAL_PAGE, MY_WORK_PAGE, SETTINGS_PAGE,
  WORKSPACES_ROUTE, TEMPLATES_ROUTE, TERMINAL_ROUTE, MY_WORK_ROUTE, SETTINGS_ROUTE
} from './config/constants';

// `store` is the raw Vuex store the extension manager hands to every product init, and
// $plugin.DSL takes it as `any`. There is no narrower type to reach for.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function init($plugin: IPlugin, store: any) {
  const { product, basicType, virtualType } = $plugin.DSL(store, PRODUCT_NAME);

  // `public` is what makes the product visible without a session, and the shell honours it at
  // runtime, but TypeMapProduct does not declare it. The dev build only warns; the production
  // build that `hmr: off` mode needs treats it as an error, so the literal is widened here.
  const productOpts: Record<string, unknown> = {
    icon:                'flask',
    public:              true,
    inStore:             'management',
    weight:              100,
    showClusterSwitcher: false,
    to:                  {
      name:   HOME_ROUTE,
      params: { product: PRODUCT_NAME, cluster: BLANK_CLUSTER }
    }
  };

  product(productOpts);

  virtualType({
    name:  CUSTOM_PAGE_NAME,
    label: 'Live Reload Demo',
    route: {
      name:   HOME_ROUTE,
      params: { product: PRODUCT_NAME, cluster: BLANK_CLUSTER }
    },
    weight: 100
  });

  basicType([CUSTOM_PAGE_NAME]);

  // Floof goes into Rancher's Cluster Explorer, not into this product.
  //
  // A second DSL() call scoped to 'explorer' is how an extension adds to a product it does
  // not own - the same virtualType/basicType calls, aimed at someone else's nav. `group:
  // 'Root'` puts it at the top level alongside Cluster and Workloads rather than inside a
  // resource group, matching how the shell registers its own non-resource pages.
  const explorer = $plugin.DSL(store, EXPLORER_PRODUCT);

  explorer.virtualType({
    name:       FLOOF_PAGE,
    label:      'Floof',
    group:      'Root',
    icon:       'folder',
    namespaced: false,
    weight:     99,
    route:      { name: FLOOF_ROUTE },
    exact:      true
  });

  explorer.basicType([FLOOF_PAGE], 'Root');

  devProduct($plugin, store);
}

/**
 * The Dev product: the Claude Harness on Kubernetes.
 *
 * A second `product()` from a second DSL() call, which is how one extension registers two
 * unrelated products. It owns no cluster, so it takes BLANK_CLUSTER and hides the cluster
 * switcher, exactly as the demo product above does.
 *
 * The nav entries are virtualTypes: they are pages, not resource types, so there is no schema
 * for the shell to build a list route from and the route is given outright. `basicType` is
 * what puts them in the side nav at all; a virtualType registered and never named in a
 * basicType is registered and invisible, which is the usual way this goes wrong.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function devProduct($plugin: IPlugin, store: any) {
  const { product, basicType, virtualType } = $plugin.DSL(store, DEV_PRODUCT);

  // See the note above productOpts: `public` is honoured at runtime but not declared on
  // TypeMapProduct, so the literal is widened for the production build's sake.
  const devOpts: Record<string, unknown> = {
    icon:                'terminal',
    public:              true,
    inStore:             'management',
    weight:              99,
    showClusterSwitcher: false,
    to:                  {
      name:   WORKSPACES_ROUTE,
      params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
    }
  };

  product(devOpts);

  virtualType({
    name:  WORKSPACES_PAGE,
    label: 'Workspaces',
    icon:  'folder',
    route: {
      name:   WORKSPACES_ROUTE,
      params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
    },
    weight: 100
  });

  // The harness's own top-level routes, in its own order: what am I doing (My Work), the
  // things I am doing it in (Workspaces), the terminal that belongs to none of them, and the
  // two pages that describe the tooling. Keeping the nav the same shape as the harness's is
  // the point of the layout, so an entry exists here even where the page behind it is still
  // being built, and each such page says so rather than showing something invented.
  virtualType({
    name:  TERMINAL_PAGE,
    label: 'Terminal',
    icon:  'terminal',
    route: {
      name:   TERMINAL_ROUTE,
      params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
    },
    weight: 99
  });

  virtualType({
    name:  MY_WORK_PAGE,
    label: 'My Work',
    icon:  'user',
    route: {
      name:   MY_WORK_ROUTE,
      params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
    },
    weight: 98
  });

  virtualType({
    name:  TEMPLATES_PAGE,
    label: 'Templates',
    icon:  'file',
    route: {
      name:   TEMPLATES_ROUTE,
      params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
    },
    weight: 97
  });

  virtualType({
    name:  SETTINGS_PAGE,
    label: 'Settings',
    icon:  'gear',
    route: {
      name:   SETTINGS_ROUTE,
      params: { product: DEV_PRODUCT, cluster: BLANK_CLUSTER }
    },
    weight: 96
  });

  basicType([WORKSPACES_PAGE, TERMINAL_PAGE, MY_WORK_PAGE, TEMPLATES_PAGE, SETTINGS_PAGE]);
}
