# Where you are

You are claude, running in a terminal of the **Dev** product: a rebuild of the Claude Harness
on top of Rancher, inside the Rancher extension that serves it.

This file is copied into a session's directory the first time that session starts (see
`/seed/shell.sh`). It is yours to edit. It describes the shape of this place, not its contents,
because the contents change and a file that describes them goes stale.

## The pod you are in

`vue-cli-service serve` is running over `/app`, a whole Rancher dashboard with the extension
compiled into it. `/app/pkg/dev-extension` is that extension's source, and it is the live one:
saving a file there is recompiled and pushed into the browser over the hot-reload socket within
seconds. There is no build step and no server to restart, and restarting the dev server is the
one thing that interrupts whoever is watching it.

The tree is not a checkout and nothing syncs back. Its repo copy lives in the barn repo
at `pkg/barn/dev-extension/`, which is what a fresh pod is seeded from, so a change
meant to outlive this pod has to be copied back there.

- `node`, `npm`, `yarn`, `git`, `curl`, `tmux` are here. **`kubectl` is not.**
- Your session is a tmux session. Closing the browser leaves it running; reopening reattaches.
- Each terminal session has its own directory, which is what keeps its conversation its own.

## The cluster this is in

One k3s node, which is Rancher's `local` cluster. Rancher itself runs outside it and reaches it
as the apiserver; from in here, Rancher answers on `https://rancher.cattle-system.svc`.

A **workspace** is the Dev product's unit of work, and it is three objects:

- a namespace `dev-<name>`, which is the record that the workspace exists;
- a Deployment `dev-<name>` in it, which runs it. Starting and stopping is scaling that between
  one replica and none;
- a Service `dev-<name>`, whose ports are reachable through the apiserver's service proxy at
  `/k8s/clusters/local/api/v1/namespaces/dev-<name>/services/http:dev-<name>:<port>/proxy/`, on
  Rancher's own origin.

All three carry `dev.rancher.io/workspace=<name>`, and the namespace also carries
`dev.rancher.io/template=<id>`, which is how the product finds them again. The container a
workspace runs comes from a template, and the templates are code, in
`/app/pkg/dev-extension/templates.ts`.

Deleting a workspace is deleting its namespace, which takes everything else with it.

## What you can and cannot reach from here

Your ServiceAccount token is mounted at `/var/run/secrets/kubernetes.io/serviceaccount/token`,
and it currently has **no rights**: the apiserver answers 403 to everything. So you cannot list
or create workspaces from this pane yet. A ServiceAccount with the rights a global terminal
needs is a known, deliberate gap rather than something broken, and until it lands the product's
own pages are how workspaces are managed.

What you can do from here is the extension itself: read and edit `/app/pkg/dev-extension`, and
watch the result in the browser.
