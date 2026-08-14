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
- It registers two products. `devextension` is the live-reload demo. `dev` is the Claude
  Harness rebuilt on Kubernetes: a workspace is a namespace with a Deployment and a Service,
  started and stopped by scaling, with a terminal on the pod's exec subresource. Its
  Kubernetes calls are in `api.ts`, the container each workspace runs is in `templates.ts`,
  and the terminal is `components/DevTerminal.vue`, which will point at any pod given a
  namespace, labels, a container and an argv.
- The `dev` product's nav is Workspaces, Terminal, My Work, Templates, Settings. A workspace
  opens as tabs (Overview, Conversations, Browser, Ports) at
  `/dev/c/_/workspaces/<name>#<tab>`; the tab is the hash rather than a path segment, and
  `pages/WorkspaceDetail.vue` says at the top why that is not cosmetic. Terminal is the same
  DevTerminal pointed at this pod, running `/seed/shell.sh <session> /app/.sessions/<session>`,
  so it is a tmux session that survives the browser and a conversation of its own. My Work and
  Settings are deliberately empty pages describing what they are waiting on, which is a GitHub
  token in a Secret and shared claude credentials.
- Editing anything in `pod/` needs three steps, and the third is the one that gets forgotten:
  edit it in the repo, regenerate the seed, then `scripts/apply-dev-extension-seed.mjs` to put
  it in the ConfigMap this pod mounts at `/seed`. Without the third it only reaches a fresh pod;
  patched by hand instead, the extension writes its own copy back over it on the next load.
- The harness calls a workspace a project. This does not, because Rancher's own nav already
  uses that word for a group of namespaces in a cluster. The `dev-` namespace prefix is
  unchanged by that: it names the product, not the concept.
- The dashboard is reached through the Kubernetes service proxy, not on its own port. Never
  hardcode a hostname; every URL the build hands out is derived from the proxy path in
  `/app/vue.config.js`.
- `yarn` is available. Adding a dependency means an install in here, which is slow and
  survives only as long as this pod's `/app` does.

## This tree is not the repo

Nothing here is checked out from git and nothing syncs back. The repo copy lives in
`pkg/barn/dev-extension/` in the barn repo, and it is what a fresh pod is
seeded from, so a change that should outlive this pod has to be copied back there (and the
seed regenerated with `node scripts/gen-dev-extension-seed.mjs`).

If you are asked to make a change permanent and you cannot reach the repo, say so rather
than assuming the edit will survive.
