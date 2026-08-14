#!/bin/sh
# Entrypoint for the dev server pod.
#
# A real file rather than a string built in TypeScript: it is baked into the seed ConfigMap
# verbatim by scripts/gen-dev-extension-seed.mjs, so what is in the repo is exactly what
# runs. The only thing substituted is __PATH_SEPARATOR__, read out of
# pkg/barn/dev-extension.ts, so the flattening this loop undoes cannot drift from
# the flattening that produced the ConfigMap keys.
set -e

SEP=__PATH_SEPARATOR__
APP_HOME=/app/.home

# ---------------------------------------------------------------------------
# Root section. The container starts as root and nothing after this does.
#
# A terminal tab runs claude in this tree, claude refuses
# --dangerously-skip-permissions as root, and the files it edits are the ones
# webpack is watching - so the tree has to belong to an ordinary user, and the
# dev server has to be that same user or the two would fight over who owns what
# they each write.
# ---------------------------------------------------------------------------
if [ "$(id -u)" = 0 ]; then
  mkdir -p /app "$APP_HOME"
  # Cheap, so unconditional: a directory this created as root a moment ago is
  # one the node user cannot write, and .home in particular is where claude
  # keeps state it has to be able to update.
  chown node:node /app "$APP_HOME"

  # Once, not every boot: after the first install this is tens of thousands of
  # files, and the hostPath keeps them between restarts.
  if [ ! -f /app/.owned ]; then
    echo "[boot] handing /app to the node user"
    chown -R node:node /app
    touch /app/.owned
    chown node:node /app/.owned
  fi

  # tmux and the claude CLI, in the background: the dev server does not depend
  # on either, and installing them here would put minutes in front of it. A
  # terminal tab that opens before this finishes waits for it in shell.sh.
  /bin/sh /seed/terminal-tools.sh >/app/.terminal-tools.log 2>&1 &

  exec setpriv --reuid=1000 --regid=1000 --init-groups /bin/sh /seed/boot.sh
fi

export HOME="$APP_HOME"
export YARN_CACHE_FOLDER=/app/.yarn-cache

cd /app

# Seed the tree from the ConfigMap.
#
# Only files that are not already there are written. Once the pod has booted, its copy of
# the tree is the live source - you edit it in here, and a terminal tab points claude at it -
# and a restart must not throw those edits away. Writing just the missing ones still lets a
# file added to the seed reach a pod that already exists.
#
# vue.config.js is the exception, refreshed on every boot: it is pod plumbing (it is what
# addresses this server through the apiserver proxy), not something anyone edits in here.
for f in /seed/*; do
  name=$(basename "$f")

  # /seed holds two kinds of file: this app tree, whose paths are flattened with $SEP, and
  # the pod's own scripts, which are run straight out of /seed so that a terminal tab always
  # starts the version the extension last wrote, with no pod restart in between. Only the
  # tree belongs in /app - plus the skeleton files that sit at the root of it.
  case "$name" in
    *"$SEP"*|package.json|babel.config.js|tsconfig.json|vue.config.js) ;;
    *) continue ;;
  esac

  dest="/app/$(echo "$name" | sed "s|$SEP|/|g")"

  if [ ! -f "$dest" ] || [ "$dest" = "/app/vue.config.js" ]; then
    mkdir -p "$(dirname "$dest")"
    cp "$f" "$dest"
  fi
done

# The install is guarded by a marker rather than by node_modules existing. /app is a
# hostPath, so a pod killed part-way through an install leaves a directory that is present
# and unusable, and "does node_modules exist" would then skip the install forever and fail
# in the compile instead. The marker is only written by an install that exited 0.
if [ ! -f /app/.install-done ]; then
  echo "[boot] installing dependencies (first start only, this takes a few minutes)"
  rm -rf /app/node_modules
  yarn install --network-timeout 600000
  touch /app/.install-done
else
  echo "[boot] dependencies already installed"
fi

echo "[boot] starting the dev server"
exec ./node_modules/.bin/vue-cli-service serve
