import { IPlugin } from '@shell/core/types';

export const PRODUCT_NAME = 'base';
export const HOME_PAGE = 'home';
export const HOME_ROUTE = `${ PRODUCT_NAME }-c-cluster-${ HOME_PAGE }`;

// A product is a top-level entry in the side menu with its own pages under it.
export function init($plugin: IPlugin, store: any) {
  const { product, basicType, virtualType } = $plugin.DSL(store, PRODUCT_NAME);

  product({
    icon:                'gear',
    inStore:             'management',
    showClusterSwitcher: false,
    removable:           false,
    weight:              100,
  });

  virtualType({
    label:      'Home',
    name:       HOME_PAGE,
    namespaced: false,
    weight:     100,
    route:      { name: HOME_ROUTE, params: { cluster: '_' } },
  });

  basicType([HOME_PAGE]);
}
