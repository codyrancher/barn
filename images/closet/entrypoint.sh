#!/bin/bash
# PID 1 of the k8s closet's `closet` container: sets up the workspace (node user,
# shared toolchain, claude, template seed) then holds the pod open. The control
# api runs in a separate pod; the VS Code tunnel is wired by the chart's postStart.
set -e

USER_ID=${PUID:-1000}
GROUP_ID=${PGID:-1000}

# node:22 ships a "node" user at 1000 — reuse whatever owns the requested UID
if ! getent group "$GROUP_ID" > /dev/null 2>&1; then
    groupadd -g "$GROUP_ID" dev
fi
if ! getent passwd "$USER_ID" > /dev/null 2>&1; then
    useradd -m -u "$USER_ID" -g "$GROUP_ID" -s /bin/bash dev
fi
USER_NAME=$(getent passwd "$USER_ID" | cut -d: -f1)
HOME_DIR=$(getent passwd "$USER_ID" | cut -d: -f6)
mkdir -p "$HOME_DIR"
chown "$USER_ID:$GROUP_ID" "$HOME_DIR"

# Persist Claude credentials/config in the claude-data volume.
if [ -d /claude-data ]; then
    chown "$USER_ID:$GROUP_ID" /claude-data
    ln -sfn /claude-data "$HOME_DIR/.claude"
    [ -s /claude-data/.claude.json ] || printf '{}\n' > /claude-data/.claude.json
    chown "$USER_ID:$GROUP_ID" /claude-data/.claude.json
    ln -sfn /claude-data/.claude.json "$HOME_DIR/.claude.json"

    # Preconfigure the Figma MCP server for Claude when a token is provided (the
    # figma sidecar only runs with FIGMA_API_KEY). In-cluster the MCP endpoint is
    # the figma service (:8000, acuvity minibridge, SSE at /sse). User-scoped so
    # there's no per-project trust prompt; removed again if the token is cleared.
    CJ=/claude-data/.claude.json
    if [ -n "${FIGMA_API_KEY:-}" ] && command -v jq >/dev/null 2>&1; then
        TMP=$(mktemp)
        jq --arg url "http://figma:8000/sse" \
           '.mcpServers = ((.mcpServers // {}) + {figma: {type: "sse", url: $url}})' \
           "$CJ" > "$TMP" 2>/dev/null && mv "$TMP" "$CJ"
        echo "figma MCP server preconfigured for Claude (FIGMA_API_KEY set)"
    elif command -v jq >/dev/null 2>&1; then
        TMP=$(mktemp)
        jq 'if .mcpServers then .mcpServers |= del(.figma) else . end' "$CJ" > "$TMP" 2>/dev/null && mv "$TMP" "$CJ"
    fi
    chown "$USER_ID:$GROUP_ID" "$CJ"
fi

# Publish the heavyweight CLIs into the shared tools mount so every sidecar
# that mounts /shared gets them too.
TOOLS_BIN=/shared/tools/bin
if [ -d "$(dirname "$TOOLS_BIN")" ]; then
    mkdir -p "$TOOLS_BIN"
    cp -f /usr/local/bin/claude "$TOOLS_BIN/claude" 2>/dev/null || true
    cp -f "$(command -v gh)" "$TOOLS_BIN/gh" 2>/dev/null || true
    chmod -R a+rx "$TOOLS_BIN"
fi

# tmux config: mouse scrolling + big scrollback
cat > "$HOME_DIR/.tmux.conf" << 'TMUXCONF'
set -g mouse on
set -g history-limit 50000
TMUXCONF
chown "$USER_ID:$GROUP_ID" "$HOME_DIR/.tmux.conf"

# Persistent Claude session: attach if running, otherwise start in /workspace
cat > /usr/local/bin/claude-session << 'WRAPPER'
#!/bin/bash
SESSION_NAME="claude"
if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
    exec tmux attach-session -t "$SESSION_NAME"
fi
exec tmux new-session -s "$SESSION_NAME" -c /workspace bash -c '
    while true; do
        claude --continue --dangerously-skip-permissions 2>/dev/null || \
        claude --dangerously-skip-permissions
        echo ""
        echo "Claude exited. Press Enter to restart or Ctrl+C to exit..."
        read -t 5 || true
    done
'
WRAPPER
chmod +x /usr/local/bin/claude-session

chown "$USER_ID:$GROUP_ID" /workspace

# Seed the closet-root scaffold (CLAUDE.md, ...) into /workspace if not already
# present (baked into the image at /opt/magic-closet/template). -n never
# clobbers a file the user already has.
if [ -d /opt/magic-closet/template ]; then
    cp -rn /opt/magic-closet/template/. /workspace/ 2>/dev/null || true
    chown -R "$USER_ID:$GROUP_ID" /workspace 2>/dev/null || true
fi

# ---- Shared node toolchain (nvm, from the repo's .nvmrc) ----
# Populated into the /opt/toolchain volume so sidecars that mount it share this
# exact node. Install one now, then re-run once the workspace clone brings in
# rancher/dashboard's .nvmrc.
if [ -d /opt/toolchain ]; then
    chown -R "$USER_ID:$GROUP_ID" /opt/toolchain
    gosu "$USER_NAME" env NVM_DIR=/opt/toolchain/nvm HOME="$HOME_DIR" setup-node || true
    ( until [ -f /workspace/dashboard/.nvmrc ]; do sleep 3; done
      gosu "$USER_NAME" env NVM_DIR=/opt/toolchain/nvm HOME="$HOME_DIR" setup-node || true ) &
fi

# Optional per-closet init hook
if [ -f /workspace/init.sh ]; then
    chmod +x /workspace/init.sh
    gosu "$USER_NAME" bash -c '/workspace/init.sh > /workspace/.init.log 2>&1' &
fi

echo "magic-closet closet container ready (user: $USER_NAME)"
exec gosu "$USER_NAME" sleep infinity
