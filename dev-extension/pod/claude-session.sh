#!/bin/bash
# What runs in the tmux pane: claude, in a loop.
#
# The loop is the point. If claude exits - a crash, a /quit, an update - the
# pane would die with it and take the tmux session down, so the next tab would
# come up blank instead of where you left off. Restarting keeps the session, and
# `--continue` means the restart resumes the conversation rather than opening a
# new one. A run that ends in under three seconds is treated as an error and
# backed off, so a claude that cannot start does not spin.
#
# bash rather than sh: `read` with no variable name is a bashism, and this is
# the pane's interactive shell anyway.
# The pane's own home, set by shell.sh in the tmux environment. The default is
# only for a pane started some other way.
export HOME=${HOME:-/app/.home}

# Ctrl-C at the prompt below leaves you in a shell rather than closing the pane.
# While claude is running it is claude that gets the signal, not this script, so
# this only fires where it is offered.
trap 'echo; exec /bin/bash' INT

if ! command -v claude >/dev/null 2>&1; then
  echo "[claude is not installed in this pod - see /app/.terminal-tools.log]"
  echo "[dropping to a shell]"
  exec /bin/bash
fi

# A prompt somebody queued for this conversation, used once and then gone.
#
# Read before the loop rather than inside it: it is what this conversation is
# for, and a restart of claude within the same pane should carry on rather than
# ask the same thing again. Deleted before claude runs, not after, so a claude
# that crashes on the prompt does not ask it again on every restart.
QUEUE=${1:-}
PROMPT=""

if [ -n "$QUEUE" ] && [ -f "$QUEUE" ]; then
  PROMPT=$(cat "$QUEUE")
  rm -f "$QUEUE"
fi

if [ -n "$PROMPT" ]; then
  claude --dangerously-skip-permissions "$PROMPT" || true
fi

while true; do
  start=$(date +%s)

  # --continue fails when the directory has no conversation yet, which is the
  # only reason for the fallback.
  claude --dangerously-skip-permissions --continue 2>/dev/null ||
    claude --dangerously-skip-permissions

  end=$(date +%s)

  if [ $((end - start)) -lt 3 ]; then
    echo ""
    echo "[claude exited immediately, which usually means an error. Waiting 5s.]"
    sleep 5
  fi

  echo ""
  echo "[claude exited - press Enter to restart, Ctrl-C for a shell]"
  read -r || exec /bin/bash
done
