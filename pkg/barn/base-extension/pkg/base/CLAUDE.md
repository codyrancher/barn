# A Rancher extension, from inside the pod

You are claude, running in the pod that serves this extension, in the tree it serves.

`/app` is a whole Rancher dashboard build with this package (`/app/pkg/base`) compiled into it,
and `vue-cli-service serve` is watching it. Every file you save here is recompiled and pushed
into the browser over the hot-reload socket, usually within a few seconds. There is no build
step to run and no server to restart, and **restarting the dev server is the one thing that
interrupts whoever is watching it**.

This started as the stock extension: one product, one page, and nothing else. What it becomes
is up to whoever asked you.

## What is here

| Thing | File | What it does |
| --- | --- | --- |
| Entry point | `index.ts` | `importTypes`, `addProduct`, `addRoutes` |
| Product | `product.ts` | The side-menu entry and what is under it |
| Routes | `routing/index.ts` | Pages, and which parent template they render under |
| Pages | `pages/*.vue` | The pages themselves |
| Strings | `l10n/en-us.yaml` | Anything `t()` looks up |

Two conventions cause most of the confusion:

- **Files are found by name.** A type `my.thing` looks for `models/my.thing.js`,
  `detail/my.thing.vue`, `edit/my.thing.vue`. Renaming the type without renaming the files is a
  page that renders blank with no error.
- **The parent route decides the chrome.** `addRoute('default', ...)` gets the cluster side nav
  and renders nothing until a cluster is ready; `'plain'` gets the header and the top-level
  menu; `'blank'` gets nothing at all. A page that renders alone on a white background is
  almost always registered under the wrong parent.

The shell's own components are the fastest documentation there is, because they are right here:

```bash
ls /app/node_modules/@rancher/shell/components          # SortableTable, AppModal, Tabbed, ...
ls /app/node_modules/@rancher/shell/components/form     # LabeledInput, LabeledSelect, ...
```

Read one before writing a wrapper for it. `SortableTable`, `LabeledSelect`, `AsyncButton`,
`Banner`, `AppModal` and `Card` cover most of what a page needs, and they carry Rancher's own
behaviour that a hand-rolled version will not. The published docs are at
<https://extensions.rancher.io/extensions/next/home>.

## What you can reach

This pod runs as a ServiceAccount bound to **cluster-admin**, and `kubectl` is installed. Every
resource in the cluster this Rancher manages is readable and writable from here, including
Rancher's own, which are CRDs in the same apiserver:

```bash
kubectl get settings.management.cattle.io      # what Rancher is configured to do
kubectl get projects.management.cattle.io -A   # its grouping of namespaces
kubectl get clusterrepos.catalog.cattle.io     # where its Apps come from
kubectl api-resources | grep cattle.io         # the rest, and there is a lot of it
```

That is deliberate: an extension is mostly a UI over those resources and cannot be tried from a
pane that gets 403 to every question about them. It is also a live Rancher somebody is looking
at, so read freely and say what you are about to change before you change it.

## The browser you can look at it in

There is one Chromium in this namespace with its DevTools protocol open, so a change can be
looked at rather than described. It is shared by every extension here and somebody may be
watching it, so leave it somewhere sensible.

- **Where to point it.** `https://$NODE_IP$DEV_PROXY_PATH/`, both set on this pod.
  `DEV_PROXY_PATH` is root-relative, which means nothing to a driver outside a page, and
  `NODE_IP` is Rancher's address - this cluster is k3s inside the Rancher container. Never
  write a hostname in yourself.
- **Where the browser is.** `$BARN_BROWSER_SERVICE` on `$BARN_BROWSER_CDP_PORT`, and you have
  to resolve the name yourself:
  `kubectl -n barn get svc "$BARN_BROWSER_SERVICE" -o jsonpath='{.spec.clusterIP}'`.
  Chromium answers a debugging-port request whose `Host` is not an IP with a 403, so the
  ClusterIP works and `barn-browser:9222` does not.
- **The first navigation lands on the login page**, because a fresh profile has no Rancher
  session. That session is the `R_SESS` cookie and its value is a token from
  `POST /v3-public/localProviders/local?action=login`; set it over CDP before navigating. The
  admin password is the one thing this pod is not given - ask for it rather than hunting. One
  manual login in the browser's own UI works too and needs no password here.
- **Driving it needs no install.** Node 24 has `fetch` and `WebSocket` built in: `PUT
  /json/new?<url>` for a tab of your own, then `Runtime.enable` and `Log.enable` on its
  websocket, which is where a change that failed to compile shows up first. Rewrite the
  `127.0.0.1` in the websocket URL it hands back to the address you reached it on.

A save is not instant - the compile is a few seconds and the result is pushed over the
hot-reload socket - so wait for the recompile rather than racing it.

## The rules of this tree

- **Nothing here syncs anywhere.** This tree lives as long as the pod's `/app` does. If you are
  asked to make something permanent, say where it would have to go rather than assuming the edit
  will survive.
- **Do not restart the dev server.** Somebody is watching the pane it serves.
- **`yarn install` is minutes**, and survives only as long as this pod does.
