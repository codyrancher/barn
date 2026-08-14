#!/bin/sh
# Entrypoint for a terminal tab. The extension's terminal component runs this
# over the Kubernetes exec subresource, with the tab's session id as $1.
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

# Where the pane starts, and what claude is therefore pointed at: DevExtension's
# own source, the tree this pod's dev server is compiling and serving.
WORKDIR=/app/pkg/dev-extension

# claude keys its conversation history by working directory, so one directory
# means one conversation. The harness gives each terminal tab a directory of its
# own for that reason; here there is one pane, pointed at the thing you came to
# edit, so there is nothing to keep apart.
HOME_DIR=/app/.home

/bin/sh /seed/terminal-tools.sh

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
