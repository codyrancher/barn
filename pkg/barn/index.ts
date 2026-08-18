import { importTypes } from '@rancher/auto-import';
import { IPlugin } from '@shell/core/types';
import { ensureEditorContent } from './api';
import { ensureBrowser, ensureDefaultExtension } from './extensions';
import { EDITOR_ROUTE, EXTENSION_STARTING_ROUTE } from './editor-product';

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

  // And the browser those extensions are looked at in (see ensureBrowser): one
  // Chromium for the namespace, with CDP open on its Service, so a claude in an
  // extension pod can open the page it just changed and see what it did rather
  // than describing what it should have done. Created the same way and for the
  // same reason as the pod above - here rather than behind a toggle, so it is
  // already warming up by the time anybody opens the editor.
  ensureBrowser();

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

  // Nothing is put in Rancher's header. This used to register a component into NavHeaderRight
  // carrying an Editor button and the extension box, and that slot is a poor place for them:
  // it is a single global slot, so the last extension to claim it silently wins, and it is
  // rendered on every page in Rancher whether or not any of this is what you are doing.
  //
  // The flask in the side rail is the way in (see editor-product.ts), and the extension box
  // lives on the editor's own toolbar, where it is next to the thing it changes.

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
