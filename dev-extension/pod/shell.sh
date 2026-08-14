#!/bin/sh
# Entrypoint for a terminal tab. The extension's terminal component runs this
# over the Kubernetes exec subresource, with the tab's session id as $1 and,
# optionally, the directory the pane should start in as $2.
#
# Everything the tab runs comes out of /seed rather than the tree, so a tab
# always starts the scripts the extension last wrote, without a pod restart.
#
# The session is a tmux session, which is the whole persistence story: `-A`
# attaches to it if it is already there and creates it otherwise, so closing the
# browser leaves claude running and reopening the editor lands back in the same
# conversation.
set -e

SESSION=${1:-main}

# Where the pane starts, and what claude is therefore pointed at. The default is
# DevExtension's own source, the tree this pod's dev server is compiling and
# serving, which is what the editor's pane wants.
#
# It is an argument because claude keys its conversation history by working
# directory, so one directory means one conversation, and two panes sharing a
# directory means the second one resumes the first one's conversation rather than
# having its own. The harness gives each terminal tab a directory for exactly
# this reason. Callers that want several independent sessions (the Dev product's
# global terminals) pass one per session; callers that want the source tree pass
# nothing.
WORKDIR=${2:-/app/pkg/dev-extension}

HOME_DIR=/app/.home

/bin/sh /seed/terminal-tools.sh

# A session directory has to exist before tmux is told to start in it, and it has
# to belong to the node user, since everything in the pane is that user and
# claude writes here. Only for a directory this creates: the default is the
# source tree, which boot.sh already handed over.
if [ ! -d "$WORKDIR" ]; then
  mkdir -p "$WORKDIR"

  if [ "$(id -u)" = 0 ]; then
    chown node:node "$WORKDIR"
  fi
fi

# What claude reads before it is asked anything. A session in a directory of its
# own would otherwise start knowing nothing about the cluster it is in and
# re-derive it, badly, every time. Copied rather than linked so a session can
# edit its own, and only when there is none, so an edited one is never
# overwritten. The source tree has its own CLAUDE.md, so this is a no-op there.
if [ ! -f "$WORKDIR/CLAUDE.md" ] && [ -f /seed/session-claude.md ]; then
  cp /seed/session-claude.md "$WORKDIR/CLAUDE.md"

  if [ "$(id -u)" = 0 ]; then
    chown node:node "$WORKDIR/CLAUDE.md"
  fi
fi

# The shared login, before anything that would use it. Run as the node user and
# with the pane's HOME, because it writes into that user's ~/.claude and a
# root-owned credentials file is one claude cannot then refresh.
if [ "$(id -u)" = 0 ]; then
  setpriv --reuid=1000 --regid=1000 --init-groups \
    env "HOME=$HOME_DIR" node /seed/claude-credentials.mjs pull || true
else
  env "HOME=$HOME_DIR" node /seed/claude-credentials.mjs pull || true
fi

set -- tmux -f /seed/tmux.conf new-session -A -s "mc-$SESSION" -c "$WORKDIR" \
  "/bin/bash /seed/claude-session.sh"

# The exec subresource runs as the container's user, which is root, whatever the
# dev server dropped itself to. Everything in the pane has to be the node user
# instead: claude refuses --dangerously-skip-permissions as root, and the files
# it edits are the ones webpack is watching, which boot.sh made node's.
if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=1000 --regid=1000 --init-groups \
    env "HOME=$HOME_DIR" TERM=xterm-256color "$@"
fi

exec env "HOME=$HOME_DIR" TERM=xterm-256color "$@"
