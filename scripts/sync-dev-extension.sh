#!/usr/bin/env bash
# Push this repo's DevExtension source into the running pod, and wait for the
# rebuild.
#
# The seed only covers a *fresh* pod: on boot it writes the files the tree does
# not already have, deliberately, so that edits made inside the pod survive a
# restart. That leaves the other direction unserved - editing here and wanting
# to see it - which is what this is for.
#
# It copies rather than restarts because a restart would lose whatever else is
# in the pod (a claude conversation in the terminal, an install part-way
# through). The dev server picks the files up the same way it picks up an edit
# made in the pod: they land in the tree webpack is watching.
#
#   ./scripts/sync-dev-extension.sh          # sync, then wait for the compile
#   ./scripts/sync-dev-extension.sh --no-wait
#
# Needs kubectl pointed at the cluster the extension created the pod in.
set -euo pipefail

NAMESPACE=magic-closet
APP=magic-closet-dev-extension
CONTAINER=devserver

# The pod's tree is owned by the node user (see pod/boot.sh); exec arrives as
# root, so the untar drops to it rather than leaving root-owned files that the
# pod's own claude could not then edit.
POD_UID=1000

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../dev-extension" && pwd)"

wait_for_compile=true
[ "${1:-}" = "--no-wait" ] && wait_for_compile=false

pod=$(kubectl -n "$NAMESPACE" get pod -l "app=$APP" \
  --field-selector status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)

if [ -z "$pod" ]; then
  echo "no running $APP pod - open the extension in Rancher and let it create one" >&2
  exit 1
fi

# Where the compile log is now, so the wait below reads only what this sync
# caused rather than the last success from ten minutes ago.
before=$(kubectl -n "$NAMESPACE" logs "$pod" -c "$CONTAINER" 2>/dev/null | wc -l)

echo "syncing pkg/dev-extension -> $pod"
tar -C "$SOURCE" -cf - pkg/dev-extension |
  kubectl -n "$NAMESPACE" exec -i "$pod" -c "$CONTAINER" -- \
    setpriv --reuid="$POD_UID" --regid="$POD_UID" --init-groups tar -C /app -xf -

if [ "$wait_for_compile" = false ]; then
  exit 0
fi

echo "waiting for the rebuild"

for _ in $(seq 1 60); do
  sleep 2
  line=$(kubectl -n "$NAMESPACE" logs "$pod" -c "$CONTAINER" 2>/dev/null |
    tail -n "+$((before + 1))" | tr '\r' '\n' |
    grep -E 'Compiled successfully|Compiled with|ERROR in|Failed to compile' | tail -1 || true)

  if [ -n "$line" ]; then
    echo "$line"
    # A failed compile is the answer, not an error in this script: the caller
    # asked what happened, and it is about to be told in the same place.
    case "$line" in
      *'Compiled successfully'*) exit 0 ;;
      *) exit 1 ;;
    esac
  fi
done

echo "no compile seen in 2 minutes - check: kubectl -n $NAMESPACE logs $pod" >&2
exit 1
