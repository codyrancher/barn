import { importTypes } from '@rancher/auto-import';
import { IPlugin, ActionLocation } from '@shell/core/types';
import { ensureEditorContent } from './api';
import { ensureDevExtension, devExtensionUrl } from './dev-extension';
import { EDITOR_ROUTE } from './editor-product';

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
    path:      '/magic-closet/editor',
    component: () => import('./pages/editor.vue'),
  });

  // Global button in the top header (visible everywhere). Ensures the content
  // pod exists, then opens the editor in a new browser tab.
  plugin.addAction(ActionLocation.HEADER, {}, {
    label:   'Editor',
    tooltip: 'Open the Magic Closet editor',
    icon:    'icon-external-link',
    invoke(this: any) {
      // `this` is bound to the Header component when invoked.
      ensureEditorContent();
      const href = this.$router.resolve({ name: EDITOR_ROUTE }).href;

      window.open(href, '_blank');
    },
  });

  // Same, for DevExtension: opens the dev dashboard the pod serves, at its
  // service-proxy URL on this same origin. A plain URL rather than a route,
  // since it is a different dashboard, not a page in this one.
  plugin.addAction(ActionLocation.HEADER, {}, {
    label:   'Dev Extension',
    tooltip: 'Open the DevExtension dev server',
    icon:    'icon-external-link',
    invoke() {
      ensureDevExtension();
      window.open(devExtensionUrl(), '_blank');
    },
  });

  // Override the core /prefs route with a wrapper that renders the original
  // page plus an "Enable Magic Closet" checkbox (see pages/prefs.vue). The core
  // route is a child of the 'plain' parent route, so we must override it under
  // that same parent (a parent-less addRoute is forced under 'default' and would
  // just conflict, not replace).
  plugin.addRoute('plain', {
    name:      'prefs',
    path:      '/prefs',
    component: () => import('./pages/prefs.vue'),
  });
}
