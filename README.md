# barn

A Rancher dashboard extension, and a second extension that it plants in the cluster.

`pkg/barn` is the extension you load into Rancher. It adds two things to the cluster
explorer: **Closets**, dev environments provisioned from the `closet` Helm chart in
`deploy/`, and **Secret Sets**, per-user bundles of credentials those closets are handed at
start. It also registers an **Editor** page, which is claude in a pod on the left and what
claude is editing on the right.

An extension it creates is a whole Rancher dashboard with that package compiled into it,
running as a pod in the cluster, reached through the Kubernetes apiserver's service proxy on
Rancher's own origin. Editing a file in that pod recompiles and hot-reloads it in the browser,
so it is an extension you develop by using it, with no build step and nothing to reinstall.

`pkg/barn/extension-skeleton` is what a pod is built out of - the dashboard around the package
and the scripts that run inside it - and `pkg/barn/base-extension` is the stock package a new
extension is seeded from. Both are baked into the bundle, because a pod has to be given a tree
before anything in it can fetch one.

Anything else comes from a repository. The **Dev** product - the Claude Harness rebuilt on
Kubernetes, where a workspace is a namespace with a Deployment and a Service, with terminals on
the pod's exec subresource, conversations that are tmux sessions, forwarded and password-shared
ports, GitHub work queues and a SQLite database per person - used to be vendored here as a
second seed. It lives in [codyrancher/dev-extension](https://github.com/codyrancher/dev-extension)
now, and arrives through **Import from GitHub** like anybody else's would.

## Layout

```
barn/
├── pkg/barn/                     the extension Rancher loads
│   ├── product.ts                nav, spoofed types, the two resources
│   ├── api.ts                    closets, secret sets, the editor pod
│   ├── extensions.ts             creates an extension's pod in the cluster
│   ├── extension-seed.generated.ts    the skeleton and base package, baked in
│   ├── detail/ edit/ models/     barn.closet, barn.secret-set
│   ├── base-extension/           the stock package a new extension starts as
│   └── extension-skeleton/       what a pod is built out of
│       └── pod/                  the scripts a terminal runs in the pod
├── deploy/closet/                the Helm chart a closet is
├── images/closet/                the container a closet runs
└── scripts/                      seed generation and applying
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

## Working on what a pod is made of

The skeleton (`pkg/barn/extension-skeleton/`) and the stock package
(`pkg/barn/base-extension/`) are baked into the bundle as a seed, which is generated and
committed. Regenerate it after editing either:

```bash
node scripts/gen-extension-seed.mjs
```

That reaches a **fresh pod**. Editing anything in `pod/` needs a third step, and it is the one
that gets forgotten: those files are mounted from a ConfigMap and are run straight off the
mount, so writing the ConfigMap reaches a pod that already exists, without restarting it.

```bash
node scripts/apply-extension-seed.mjs            # the default extension
node scripts/apply-extension-seed.mjs myThing    # a particular one
```

See `pkg/barn/extension-skeleton/README.md` for how the proxy, the asset URLs and hot reload
fit together.

Working on an extension's *package* does not happen here at all. It happens in the pod, which
is the point of the thing: edit it in the Editor and it hot-reloads. Getting it out of the pod
and somewhere permanent is Publish to GitHub.

## Publishing it

Two different things are called publishing here, and they are for two different moments.

**Publish in the editor** builds the extension in its own pod, serves the bundle from that pod,
and installs it into the Rancher you are looking at. It is a dev loop: what it installs lives
exactly as long as the pod does, and nobody else can reach it.

**A release** puts it on this repository's `gh-pages` branch as a Helm repository, which is how
a Rancher extension is normally distributed. Somebody installing barn adds the Pages URL under
Apps -> Repositories and it appears in Extensions. Tag the commit and publish the release:

```bash
# The tag has to be <package>-<version> and match pkg/barn/package.json, or the build stops.
git tag barn-0.5.15 && git push origin barn-0.5.15
gh release create barn-0.5.15 --generate-notes
```

`.github/workflows/build-extension-charts.yml` does the rest, through rancher/dashboard's own
reusable workflow. It can also be run by hand from the Actions tab, which builds whatever
version package.json currently names.

Two things have to be true before the first release, and neither is something the workflow can
arrange for itself:

- **`gh-pages` has to exist.** The publish script checks for the branch and stops rather than
  creating it.
- **The repository has to be public**, or on a plan whose Pages are public. Rancher fetches the
  chart index from Pages and the extension's files from `raw.githubusercontent.com`, with no
  credential belonging to the person installing it, so a private repository publishes
  successfully and then serves 404 to everyone.

## What lives elsewhere

`deploy/closet` deploys two images. `images/closet` builds one of them. The other, the
closet's control API, is built and published by the closet project, and barn talks to it over
HTTP rather than carrying a copy. `pkg/barn/credentials.generated.ts` is likewise generated
from that project's sidecar declarations by `scripts/gen-credentials.mjs`, and is committed so
that a normal build never needs them.
