# DevExtension

A Rancher extension whose dev server runs as a pod inside the Rancher instance it is served
into, and is edited inside that pod. Save a file in the pod and the page updates live, with
no rebuild, no install and nothing running outside the cluster.

The pod serves a *whole dashboard* with the `dev-extension` package compiled in, plus webpack
HMR. The browser reaches it through the Kubernetes apiserver's service proxy, on Rancher's
own origin:

```
https://<rancher>/k8s/clusters/local/api/v1/namespaces/barn/services/http:barn-dev-extension:8005/proxy/
```

So it is a second dashboard at a URL of its own. Rancher's own UI is untouched: no
`ui-dashboard-index` repointing, no writing into Rancher's static directory, nothing to put
back when you are done. The **Dev Extension** button in the Rancher header opens it.

## How it fits together

```
  barn extension (loaded in Rancher)
     |
     |  ensureDevExtension()  on plugin load
     v
  ConfigMap  barn-dev-extension    <- the seed: this directory, baked in
  Deployment barn-dev-extension    <- node:24, runs /seed/boot.sh
  Service    barn-dev-extension    <- ClusterIP :8005
     ^
     |  apiserver service proxy (same origin as Rancher, needs a session)
     |
  browser: assets, index.html, and the HMR websocket
```

- `pkg/dev-extension/` is the extension itself: its own product with a Live Reload Demo page,
  a `Floof` page registered into Rancher's Cluster Explorer, and model overrides for
  ConfigMap and Secret. This is the part you edit.
- `pod/boot.sh` is the container's command. It hands the tree to the `node` user, seeds it out
  of the ConfigMap, installs, and starts the dev server.
- `pod/vue.config.js` is the dev server config, seeded to `/app/vue.config.js`. It is the one
  place that knows the build is addressed through a proxy.
- `pod/shell.sh`, `pod/claude-session.sh`, `pod/terminal-tools.sh`, `pod/claude-defaults.mjs`
  and `pod/tmux.conf` are the terminal (see below). Unlike the tree, they are run straight out of `/seed`, so editing one
  and pushing the seed reaches a running pod without restarting it.
- `package.json`, `babel.config.js` and `tsconfig.json` are the app skeleton the dev server
  needs around the package.
- The seed is generated, not hand-copied:
  `node scripts/gen-dev-extension-seed.mjs` writes
  `pkg/barn/dev-extension-seed.generated.ts`. **Run it after editing anything here.**
  The output is committed, so normal builds and CI never run it.

Nothing is parameterised. Every name and port is a constant in
`pkg/barn/dev-extension.ts`, and the proxy path the pod is told about is built from
those same constants, so neither this build nor the pod ever learns what hostname Rancher is
served on.

## The terminal

The editor page's left pane is a terminal in this pod, with claude running in it, so the two
panes are two views of the same thing: what claude edits on the left hot-reloads on the
right. It is the Claude Harness's terminal, moved into an extension.

The harness runs a `node-pty` per browser socket, and there is no server here to run one, so
the pty comes from Kubernetes instead: `components/PodTerminal.vue` opens the pod's **exec
subresource** over a WebSocket, through Rancher's cluster proxy, authenticated by the session
the browser already has. Everything on the far side is the harness's design:

- **tmux** (`pod/shell.sh`, `new-session -A`), so the session outlives the browser tab.
  Closing the editor detaches; reopening it reattaches to the same claude, mid-conversation.
- **claude in a loop** (`pod/claude-session.sh`), so an exit does not take the pane and the
  session down with it, and `--continue` resumes rather than restarts.
- **tmux's scrollback and clipboard** (`pod/tmux.conf`): the mouse wheel scrolls 50k lines,
  and a drag-select copies to the browser clipboard over OSC 52, which the component
  forwards. Shift+drag is a plain xterm.js selection instead.

What is not the harness's: the colours are Rancher's own `--terminal-*` variables, so the
pane follows the dashboard's theme, and tmux's status bar is off (see `pod/tmux.conf`).
The font is the harness's - Cascadia Code, renamed - and ships with the extension.

A tab opens on a prompt, or on `Run /login` if the pod has no credentials yet, and nothing
else. A pod is a fresh machine, so a fresh claude would otherwise open on a theme picker, then
a trust dialog, then the bypass-permissions confirmation - three questions with the same
answer every time. `pod/claude-defaults.mjs` answers them before claude can ask, idempotently
and without touching the file when they are already set. Credentials are the one thing it
cannot answer, which is why logging in is the one thing left. `HOME` is `/app/.home`, on the
hostPath, so a login outlives the pod.

`tmux` and the claude CLI are installed into the container on every boot
(`pod/terminal-tools.sh`), in the background so the dev server never waits for them. A tab
that opens before that finishes waits for it, visibly, instead.

## Editing

The pod's tree is the live source once it has booted. There is no local working copy to keep
in sync. The terminal in the editor's left pane is already there, and claude in it is already
pointed at `pkg/dev-extension` (with a `CLAUDE.md` explaining where it is). Otherwise:

```bash
kubectl -n barn exec -it deploy/barn-dev-extension \
  -- bash -c 'cd /app/pkg/dev-extension && exec bash'
```

Edit any file in there with ordinary tools and the page updates without a reload. That
extends to the shell: `@rancher/shell` is watched too (webpack's managed-paths cache is
cleared for it in `pod/vue.config.js`), so the login page, the nav and anything else outside
`pkg/` are editable the same way.

To pull an edit back into the repo, copy it out (`kubectl cp`) and regenerate the seed.

## Things worth knowing

- **First boot takes a few minutes.** It pulls `node:24`, installs dependencies and compiles
  the dashboard. The pod is not ready until it can serve, and the startup probe has a 15
  minute budget so the kubelet does not restart a pod that is working fine. The tree and
  `node_modules` live on the node under `/var/lib/rancher/barn/dev-extension`, so
  later restarts skip all of that.
- **Everything in the pod runs as the `node` user**, not root: claude refuses
  `--dangerously-skip-permissions` as root, and it has to own the files webpack is watching.
  `boot.sh` takes ownership of `/app` once, then drops. The exec subresource still arrives as
  root, so `pod/shell.sh` drops again on its way into tmux.
- **The install is guarded by a marker file**, not by `node_modules` existing. A pod killed
  part-way through an install leaves a directory that is present and unusable, and the
  failure would then surface as a compile error rather than an install that never finished.
- **Hot reload needs a Rancher session**, because the apiserver proxy does. It works on every
  page you are logged in for, and not on the login page.
- **Re-seeding is additive.** On boot the pod writes only seeded files it does not already
  have, so a new file reaches an existing pod while edits made in there survive. The one
  exception is `vue.config.js`, refreshed every boot, since it is plumbing rather than
  something anyone edits in the pod. To start over completely, delete the deployment and the
  `/var/lib/rancher/barn/dev-extension` directory on the node.
