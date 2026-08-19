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

# A directory, because mkdir is the atomic test-and-set every shell already has. What is in it
# is the pid of whoever took it, and that is the whole difference between a lock somebody is
# using and a lock somebody left behind.
#
# One does get left behind. A tab is a Kubernetes exec, and closing the browser tab - or
# reloading the page, or losing the network for long enough - hangs up the shell on the other
# end. An uncaught HUP kills it without running its EXIT trap, so if that shell was the one
# holding the lock, the lock outlives it. Every tab opened afterwards then sits printing
# "another install is running" at an install that finished hours ago, which is not a wait that
# ends: nothing is coming to release it short of the pod restarting.
#
# So: HUP is trapped below, which stops most of them being created, and a lock whose holder is
# gone is taken over here, which recovers the ones that get created anyway.
waited=0

while ! mkdir "$LOCK" 2>/dev/null; do
  holder=$(cat "$LOCK/pid" 2>/dev/null || true)

  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    echo "[tools] the install holding this lock is gone; clearing it"
    rm -rf "$LOCK"
    continue
  fi

  # No pid in it at all is either the microsecond between mkdir and the write below, or a
  # process that died inside that microsecond. Waiting a little distinguishes them without
  # having to guess: the first resolves itself, the second never will.
  if [ -z "$holder" ] && [ "$waited" -ge 10 ]; then
    echo "[tools] this lock has no owner; clearing it"
    rm -rf "$LOCK"
    continue
  fi

  echo "[tools] another install is running, waiting for it"
  waited=$((waited + 1))
  sleep 3
done

echo $$ > "$LOCK/pid"

# HUP is the one that matters here; see above. The others are for completeness.
trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT INT TERM HUP

if ! command -v tmux >/dev/null 2>&1; then
  echo "[tools] installing tmux"
  apt-get update -qq
  apt-get install -y -qq tmux </dev/null
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "[tools] installing the claude cli (this takes a moment)"
  npm install -g --silent @anthropic-ai/claude-code
fi

# kubectl, so the pod's own ServiceAccount is usable from a terminal. It needs
# no configuration: in-cluster credentials are mounted and client-go finds them,
# which is the whole reason the terminals can manage the cluster at all.
#
# Pinned to the cluster's version rather than "stable", so what a terminal gets
# does not change under it on a day when upstream moves.
if ! command -v kubectl >/dev/null 2>&1; then
  echo "[tools] installing kubectl"
  curl -sSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/v1.36.1/bin/linux/amd64/kubectl"
  chmod 0755 /usr/local/bin/kubectl
fi

# Answer claude's first-run questions before it can ask them, so a tab opens on
# a prompt or a login rather than on a theme picker. Idempotent, and a no-op
# once the flags are set, so it is safe to run on every boot and every tab.
#
# As the node user: this writes into the home claude runs with, and a root-owned
# .claude.json is one claude cannot then update.
# HOME_DIR is passed by shell.sh, since which directory outlives the pod depends
# on which kind of pod this is: /app for the dev server, /workspace for a
# workspace. The default is for the background run from boot.sh, which is the
# dev server's.
APP_HOME=${HOME_DIR:-/app/.home}

# TRUST_DIRS is the pane's own directory, passed by shell.sh, so the folder the
# tab is about to open in is one claude already trusts rather than one it stops
# and asks about.
if [ "$(id -u)" = 0 ]; then
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env "HOME=$APP_HOME" "TRUST_DIRS=${TRUST_DIRS:-}" node /seed/claude-defaults.mjs
else
  env "HOME=$APP_HOME" "TRUST_DIRS=${TRUST_DIRS:-}" node /seed/claude-defaults.mjs
fi

echo "[tools] ready"
