import { RouteRecordRaw } from 'vue-router';
import { PRODUCT_NAME, HOME_PAGE, HOME_ROUTE } from '../product';
import Home from '../pages/Home.vue';

// A top-level product's pages need the `/{product}/c/:cluster/` shape, and `meta.product` is
// what tells the shell whose nav to show. Without it the page renders with no side menu.
const routes: RouteRecordRaw[] = [
  {
    name:      HOME_ROUTE,
    path:      `/${ PRODUCT_NAME }/c/:cluster/${ HOME_PAGE }`,
    component: Home,
    meta:      { product: PRODUCT_NAME, cluster: '_' },
  },
];

export default routes;
