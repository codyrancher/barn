import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import { ensureEditorContent } from './api';
import { ensureDevExtension } from './dev-extension';
import { EDITOR_ROUTE } from './editor-product';
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

  // So is DevExtension's dev server (see dev-extension.ts): the seed ConfigMap,
  // the pod and its Service, created here so the dev server is installed and
  // running from the moment the extension loads rather than behind a toggle.
  // First boot installs and compiles for a couple of minutes; the pod is only
  // ready once it can serve.
  ensureDevExtension();

  // The editor itself: two iframes, no chrome. Registered under the 'blank'
  // parent, which renders nothing but the route — 'plain' still draws a header.
  plugin.addRoute('blank', {
    name:      EDITOR_ROUTE,
    path:      '/barn/editor',
    component: () => import('./pages/editor.vue'),
  });

  // The global buttons, in the header on every page: Editor, and the dev
  // server DevExtension serves. They were two `addAction(ActionLocation.HEADER)`
  // calls, which the shell renders as an icon apiece with the label only on the
  // aria-label, so both arrived as the same anonymous icon and neither said
  // which was which. NavHeaderRight renders a component of ours instead, so the
  // buttons can carry their names. See components/HeaderButtons.vue for what
  // that slot costs.
  plugin.register('component', 'NavHeaderRight', HeaderButtons);

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
