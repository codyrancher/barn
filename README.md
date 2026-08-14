# barn

A Rancher dashboard extension, and a second extension that it plants in the cluster.

`pkg/barn` is the extension you load into Rancher. It adds two things to the cluster
explorer: **Closets**, dev environments provisioned from the `closet` Helm chart in
`charts/`, and **Secret Sets**, per-user bundles of credentials those closets are handed at
start. It also registers an **Editor** page, which is claude in a pod on the left and what
claude is editing on the right.

`pkg/barn/dev-extension` is the second one. It is a whole Rancher dashboard with a
`dev-extension` package compiled into it, running as a pod in the cluster, reached through
the Kubernetes apiserver's service proxy on Rancher's own origin. Editing a file in that pod
recompiles and hot-reloads it in the browser, so it is an extension you develop by using it,
with no build step and nothing to reinstall. `pkg/barn` creates it on load, from a seed baked
into the bundle, which is why it lives under `pkg/barn` rather than beside it.

Inside it is the **Dev** product: the Claude Harness rebuilt on Kubernetes. A workspace is a
namespace with a Deployment and a Service, on any cluster this Rancher manages, with
terminals on the pod's exec subresource, conversations that are tmux sessions, forwarded and
password-shared ports, GitHub work queues, and a SQLite database per person.

## Layout

```
barn/
├── pkg/barn/                     the extension Rancher loads
│   ├── product.ts                nav, spoofed types, the two resources
│   ├── api.ts                    closets, secret sets, the editor pod
│   ├── dev-extension.ts          creates the DevExtension in the cluster
│   ├── dev-extension-seed.generated.ts    its source, baked in
│   ├── detail/ edit/ models/     barn.closet, barn.secret-set
│   └── dev-extension/            the DevExtension's own source tree
│       ├── pkg/dev-extension/    the package the pod serves
│       └── pod/                  the scripts a terminal runs in the pod
├── charts/closet/                the Helm chart a closet is
├── images/closet/                the container a closet runs
└── scripts/                      seed generation, checks, live sync
```

## Building it

Node 24.

```bash
yarn install
yarn build-pkg barn
```

That writes `dist-pkg/barn-<version>/barn-<version>.umd.min.js`. Load it into Rancher with
Extensions → ⋮ → Developer Load, after enabling extension developer features in user
preferences.

## Working on the DevExtension

Its source is `pkg/barn/dev-extension/`, and it reaches the cluster two ways.

A **fresh pod** is seeded from `pkg/barn/dev-extension-seed.generated.ts`, which is generated
and committed. Regenerate it after editing anything under `pkg/barn/dev-extension/`:

```bash
node scripts/gen-dev-extension-seed.mjs
```

A **running pod** is updated in place, which is the loop worth using, because a restart costs
whatever else is in the pod (a conversation part way through, an install):

```bash
./scripts/sync-dev-extension.sh          # checks, syncs, waits for the compile
node scripts/check-dev-extension.mjs     # what the sync runs first, on its own
```

Editing anything in `pod/` needs a third step, and it is the one that gets forgotten. Those
files are mounted from a ConfigMap, so regenerating the seed only reaches a *fresh* pod:

```bash
node scripts/apply-dev-extension-seed.mjs
```

See `pkg/barn/dev-extension/README.md` for how the proxy, the asset URLs and hot reload fit
together.

## What lives elsewhere

`charts/closet` deploys two images. `images/closet` builds one of them. The other, the
closet's control API, is built and published by the closet project, and barn talks to it over
HTTP rather than carrying a copy. `pkg/barn/credentials.generated.ts` is likewise generated
from that project's sidecar declarations by `scripts/gen-credentials.mjs`, and is committed so
that a normal build never needs them.
