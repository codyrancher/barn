#!/bin/sh
# What a terminal tab needs, on top of what the dev server needs: tmux, so a
# session outlives the browser tab that opened it, and the claude CLI, which is
# what actually runs in the pane.
#
# Both land in the container filesystem, which a restart throws away, so this
# runs on every boot. It is called twice, deliberately:
#
#   - from boot.sh, in the background, because the dev server does not depend on
#     any of it and must not wait for it;
#   - from shell.sh, in the foreground, so a tab opened before the background
#     run finished waits here, where the waiting is visible, rather than landing
#     in a pane with no claude in it.
#
# Hence the lock: the two can overlap on a pod that has just started.
set -e

LOCK=/tmp/terminal-tools.lock

while ! mkdir "$LOCK" 2>/dev/null; do
  echo "[tools] another install is running, waiting for it"
  sleep 3
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM

if ! command -v tmux >/dev/null 2>&1; then
  echo "[tools] installing tmux"
  apt-get update -qq
  apt-get install -y -qq tmux </dev/null
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "[tools] installing the claude cli (this takes a moment)"
  npm install -g --silent @anthropic-ai/claude-code
fi

# Answer claude's first-run questions before it can ask them, so a tab opens on
# a prompt or a login rather than on a theme picker. Idempotent, and a no-op
# once the flags are set, so it is safe to run on every boot and every tab.
#
# As the node user: this writes into the home claude runs with, and a root-owned
# .claude.json is one claude cannot then update.
if [ "$(id -u)" = 0 ]; then
  setpriv --reuid=1000 --regid=1000 --init-groups env HOME=/app/.home node /seed/claude-defaults.mjs
else
  env HOME=/app/.home node /seed/claude-defaults.mjs
fi

echo "[tools] ready"
