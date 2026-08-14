import { IPlugin } from '@shell/core/types';

// A product registered in the 'management' store with no category shows up as a
// button in the side menu's top (multi-cluster) group, alongside Cluster
// Management and Continuous Delivery. It owns no resources — `to` points
// straight at the chrome-less editor page registered in index.ts.
export const EDITOR_PRODUCT = 'barn-editor';
export const EDITOR_ROUTE = 'barn-editor';

export function init($plugin: IPlugin, store: any) {
  const { product } = $plugin.DSL(store, EDITOR_PRODUCT);

  // Widened because `removable` is honoured at runtime but missing from
  // TypeMapProduct. The dev build only warns about that; `yarn build-pkg`
  // type-checks and fails, which is the first thing that ever compiles this for
  // real.
  const options: Record<string, unknown> = {
    icon:                'flask',
    inStore:             'management',
    // Nothing to switch between — the page is the whole product.
    showClusterSwitcher: false,
    removable:           false,
    // After Cluster Management (-1) and Continuous Delivery (1).
    weight:              2,
    to:                  { name: EDITOR_ROUTE },
  };

  product(options);
}
