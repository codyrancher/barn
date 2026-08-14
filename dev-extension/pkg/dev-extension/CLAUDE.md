# DevExtension, from inside the pod

You are running in the pod that serves this extension, in the tree it serves. `/app` is a
whole Rancher dashboard build with this package (`/app/pkg/dev-extension`) compiled into it,
and `vue-cli-service serve` is watching it. Every file you save here is recompiled and
pushed into the browser over the hot-reload socket, usually within a few seconds. That
includes `/app/node_modules/@rancher/shell`, which is watched too, so the login page, the
nav and the rest of the dashboard are editable the same way.

So: edit files and look at the result. There is no build step to run and no server to
restart, and restarting the dev server is the one thing that will interrupt the person
watching it.

- `pkg/dev-extension/` is this extension: `product.ts` (nav entries), `routing/index.ts`,
  `pages/`, `models/` (overrides of the shell's models, which win over the shell's own).
- The dashboard is reached through the Kubernetes service proxy, not on its own port. Never
  hardcode a hostname; every URL the build hands out is derived from the proxy path in
  `/app/vue.config.js`.
- `yarn` is available. Adding a dependency means an install in here, which is slow and
  survives only as long as this pod's `/app` does.

## This tree is not the repo

Nothing here is checked out from git and nothing syncs back. The repo copy lives in
`rancher-extension/dev-extension/` in the magic-closet repo, and it is what a fresh pod is
seeded from, so a change that should outlive this pod has to be copied back there (and the
seed regenerated with `node rancher-extension/scripts/gen-dev-extension-seed.mjs`).

If you are asked to make a change permanent and you cannot reach the repo, say so rather
than assuming the edit will survive.
