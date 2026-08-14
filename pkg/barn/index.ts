import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import { ensureEditorContent } from './api';
import { ensureDefaultExtension } from './extensions';
import { EDITOR_ROUTE, EXTENSION_STARTING_ROUTE } from './editor-product';
import HeaderButtons from './components/HeaderButtons.vue';

// Init the package
export default function(plugin: IPlugin): void {
  // Auto-import model, detail, edit, list from the folders
  importTypes(plugin);

  // Provide plugin metadata from package.json
  plugin.metadata = require('./package.json');

  // Closets live on the cluster explorer product (flat nav entry + generic
  // explorer routes)
  plugin.addProduct(require('./product'));

  // Side-menu button (flask icon) -> the chrome-less editor page below.
  plugin.addProduct(require('./editor-product'));

  // The editor's content pod is created when the extension loads (idempotent,
  // create-if-missing; errors swallowed so it never blocks the UI).
  ensureEditorContent();

  // So is the default extension's dev server (see extensions.ts): the seed
  // ConfigMap, the pod and its Service, created here so there is somewhere to
  // edit from the moment this bundle loads rather than behind a toggle. First
  // boot installs and compiles for a couple of minutes; the pod is only ready
  // once it can serve. Any others are made from the header's box, on demand.
  ensureDefaultExtension();

  // The editor itself: two panes under Rancher's own header.
  //
  // 'plain' rather than 'blank'. Blank renders the route and nothing else, which meant the
  // editor had to carry a Back button to be escapable at all, and a page whose only way out
  // is a button it drew itself is a dead end when that button is the thing you are editing.
  // Plain draws the header and the top-level menu, so leaving is the same click it is
  // everywhere else in Rancher.
  //
  // 'default' would have been the other candidate and is wrong: it renders nothing until
  // `clusterReady`, and this route has no cluster in it.
  //
  // The extension is a path segment rather than a query, and optional: `/barn/editor` is the
  // default one, which is what the side-menu button and every existing link point at.
  plugin.addRoute('plain', {
    name:      EDITOR_ROUTE,
    path:      '/barn/editor/:extension?',
    component: () => import('./pages/editor.vue'),
  });

  // Where a newly created extension is watched while its pod pulls, installs and compiles.
  plugin.addRoute('plain', {
    name:      EXTENSION_STARTING_ROUTE,
    path:      '/barn/extension/:extension/starting',
    component: () => import('./pages/extension-starting.vue'),
  });

  // The global buttons, in the header on every page: Editor, and the dev
  // server DevExtension serves. They were two `addAction(ActionLocation.HEADER)`
  // calls, which the shell renders as an icon apiece with the label only on the
  // aria-label, so both arrived as the same anonymous icon and neither said
  // which was which. NavHeaderRight renders a component of ours instead, so the
  // buttons can carry their names. See components/HeaderButtons.vue for what
  // that slot costs.
  // Cast because the shell types register()'s third argument as `Function | Boolean`, which is
  // the signature for the other things it registers rather than for a component: a Vue options
  // object is neither, and the same call is what every extension makes to fill a slot. The dev
  // server transpiles without checking, so this only ever surfaces in `yarn build-pkg`.
  plugin.register('component', 'NavHeaderRight', HeaderButtons as any);

  // Override the core /prefs route with a wrapper that renders the original
  // page plus an "Enable Barn" checkbox (see pages/prefs.vue). The core
  // route is a child of the 'plain' parent route, so we must override it under
  // that same parent (a parent-less addRoute is forced under 'default' and would
  // just conflict, not replace).
  plugin.addRoute('plain', {
    name:      'prefs',
    path:      '/prefs',
    component: () => import('./pages/prefs.vue'),
  });
}
