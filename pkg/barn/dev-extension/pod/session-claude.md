# Where you are

You are claude, running in a terminal inside a Rancher extension's own dev server pod. The
thing you are building is a **Rancher dashboard extension**, and the Rancher you are building
it against is the one two clicks away in the next pane.

This file is copied into a session's directory the first time that session starts (see
`/seed/shell.sh`). It is yours to edit. It describes the shape of this place, not its contents,
because the contents change and a file that describes them goes stale.

## The pod you are in

`vue-cli-service serve` is running over `/app`, a whole Rancher dashboard with the extension
compiled into it. `/app/pkg/$EXTENSION_NAME-extension` (or `/app/pkg/dev-extension` if this pod
was made before extensions had names) is that extension's source, and it is the live one:
saving a file there is recompiled and pushed into the browser over the hot-reload socket within
seconds. There is no build step and no server to restart, and **restarting the dev server is the
one thing that interrupts whoever is watching it**.

`/app/node_modules/@rancher/shell` is watched too, so the login page, the nav and the rest of
the dashboard are editable the same way. That is deliberate and it is also a trap: an edit in
there changes this dashboard and nothing else, and it is not in any repo.

- `node`, `npm`, `yarn`, `git`, `curl`, `tmux` and `kubectl` are here.
- Your session is a tmux session. Closing the browser leaves it running; reopening reattaches.
- Each terminal session has its own directory, which is what keeps its conversation its own.

## What you can reach

Your ServiceAccount is `barn-extension`, and it is bound to **cluster-admin**. `kubectl` is
configured from it, so from this pane you can read and change every resource in the cluster this
Rancher manages. That is not an accident and it is the point: an extension is mostly a UI over
Rancher's own resources, and it cannot be written, and certainly cannot be tried, from a pane
that gets 403 to every question.

Rancher's own objects are CRDs in that same apiserver, so `kubectl` is how you look at them:

```bash
kubectl get settings.management.cattle.io                 # what Rancher is configured to do
kubectl get users.management.cattle.io                    # who can log in
kubectl get projects.management.cattle.io -A              # Rancher's grouping of namespaces
kubectl get clusters.management.cattle.io                 # the clusters it manages
kubectl get clusterrepos.catalog.cattle.io                # where its Apps come from
kubectl get uiplugins.catalog.cattle.io -A                # extensions installed into its UI
kubectl api-resources | grep cattle.io                    # the rest, and there is a lot of it
```

Treat that access the way you would treat a root shell on somebody's cluster: it is a live
Rancher that a person is looking at. Reading is free. Before you change or delete something that
was not yours to begin with, say what you are about to do.

## What you are building

A Rancher extension is a package under `pkg/`, and the dashboard loads it by convention rather
than by configuration. The parts, and where to look:

| Thing | File | What it does |
| --- | --- | --- |
| Entry point | `index.ts` | `importTypes`, `addProduct`, `addRoutes`, `register` |
| Product | `product.ts` | Nav entries, resource types, which store they live in |
| Routes | `routing/index.ts` | Pages, and which parent template they render under |
| Pages | `pages/*.vue` | The pages themselves |
| Models | `models/<type>.js` | Behaviour on a resource: actions, computed fields, links |
| Detail/Edit | `detail/`, `edit/` | Resolved by resource type name, not by import |
| Strings | `l10n/en-us.yaml` | `nav.group.*`, `typeLabel.*`, and anything `t()` looks up |

Two conventions cause most of the confusion:

- **Files are found by name.** A spoofed type `my.thing` looks for `models/my.thing.js`,
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
ls /app/node_modules/@rancher/shell/pkg                 # what a packaged extension looks like
```

Read one before writing a wrapper for it. `SortableTable`, `LabeledSelect`, `AsyncButton`,
`Banner`, `AppModal` and `Card` cover most of what a page needs, and they carry Rancher's own
behaviour (sorting, paging, the busy state on a button) that a hand-rolled version will not.

The published docs are at <https://extensions.rancher.io/extensions/next/home>. They are thin on
everything above, which is why this file lists it.

## The rules of this tree

- **Nothing here syncs back.** The repo copy lives in the barn repo at
  `pkg/barn/dev-extension/`, which is what a fresh pod is seeded from. A change meant to outlive
  this pod has to be copied back there. If you are asked to make something permanent and you
  cannot reach the repo, say so rather than assuming the edit will survive.
- **Do not restart the dev server.** Somebody is watching the pane it serves.
- **`yarn install` is minutes.** Adding a dependency is a real cost here and it survives only as
  long as this pod's `/app` does.
