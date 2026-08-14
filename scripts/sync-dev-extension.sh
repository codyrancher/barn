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
# How many deleted source files this is willing to act on without being told to. A source change
# removes one or two; a number much larger than that is this script having got its inputs wrong,
# and refusing is recoverable where deleting is not. A real refactor says so on the command line.
max_deletes=10

for arg in "$@"; do
  case "$arg" in
    --no-wait) wait_for_compile=false ;;
    --allow-deletes=*) max_deletes="${arg#*=}" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# Before anything is pushed, and before the pod is touched at all.
#
# The dev server transpiles without checking types and resolves `.vue` through a wildcard, so a
# type error and an import of a module that is not there both compile there. This is the only
# place in the loop that would notice either, which is why it is in the loop rather than in a
# file somebody remembers to run. `SKIP_CHECKS=1` exists for the case where the checks themselves
# are what is being worked on.
if [ "${SKIP_CHECKS:-}" != "1" ]; then
  node "$(dirname "${BASH_SOURCE[0]}")/check-dev-extension.mjs" || exit 1
fi

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
# node_modules is excluded rather than pushed: nothing in the pod reads a copy under the package,
# and one `yarn install` in there would otherwise put tens of thousands of files across the wire.
tar -C "$SOURCE" --exclude=node_modules -cf - pkg/dev-extension |
  kubectl -n "$NAMESPACE" exec -i "$pod" -c "$CONTAINER" -- \
    setpriv --reuid="$POD_UID" --regid="$POD_UID" --init-groups tar -C /app -xf -

# A source file deleted here has to be deleted there too.
#
# An untar only ever adds and overwrites, so a module removed from the repo stays in the pod and
# goes on satisfying imports of it. That is not a stale copy of something, it is a build that is
# green for a reason the repo does not contain, and the first fresh pod is where it is discovered.
#
# What is deleted is decided from a manifest of what *this script* last pushed, not from a diff of
# the two trees. The diff version of this was capable of deleting the pod's whole source tree, and
# every one of its failure modes came from trusting a listing it had not checked:
#
#   - `find` exits 0 when it matches nothing, so an empty local listing is not an error, and
#     `comm -13` against an empty side returns everything the pod has. Run against the real tree
#     it named all 32 files and exited 0.
#   - there was no prune, so one `yarn install` under pkg/dev-extension put its node_modules on
#     both sides of the comparison: 43,728 files in the delete set.
#   - `comm` needs both sides sorted in its own collation. Unpinned, a UTF-8 locale orders
#     DevTerminal.vue against DevTerminalTab.vue differently from `comm`, which then reports a
#     live file as missing. It says so on stderr, which the script threw away.
#   - anything created inside the pod was in the pod listing and not in ours, so it was deleted,
#     which is the opposite of what this comment promised.
#
# A manifest has none of those properties: it can only ever name files this script put there, so
# a file made in the pod is not a candidate, node_modules is not a candidate, and an empty or
# unreadable manifest means nothing is deleted rather than everything. The first sync after this
# change deletes nothing and writes the manifest; the one after a deletion acts on it.
MANIFEST=/app/.dev-extension-sync-manifest

# LC_ALL for `sort` and `comm`, which have to agree with each other about order.
export LC_ALL=C

# -prune on node_modules and dot directories, so an install inside the package cannot put tens of
# thousands of files into a list this script is about to act on.
pushed=$(cd "$SOURCE" && find pkg/dev-extension \
  \( -name node_modules -o -name '.*' \) -prune -o \
  -type f \( -name '*.ts' -o -name '*.vue' -o -name '*.js' \) -print | sort)

if [ -z "$pushed" ]; then
  echo "refusing to touch the pod: the local listing of pkg/dev-extension is empty" >&2
  exit 1
fi

previous=$(kubectl -n "$NAMESPACE" exec "$pod" -c "$CONTAINER" -- \
  sh -c "cat $MANIFEST 2>/dev/null" 2>/dev/null | LC_ALL=C sort || true)

if [ -n "$previous" ]; then
  gone=$(comm -13 <(printf '%s\n' "$pushed") <(printf '%s\n' "$previous"))

  # A sane delete is a handful of files. Anything larger is this script having got its inputs
  # wrong rather than someone having deleted half the product, and refusing is recoverable where
  # deleting is not.
  count=$(printf '%s' "$gone" | grep -c . || true)

  if [ "$count" -gt "$max_deletes" ]; then
    echo "refusing to delete $count files - more than a source change looks like." >&2
    printf '%s\n' "$gone" | sed 's/^/  /' >&2
    echo "if that is really the change, run again with --allow-deletes=$count" >&2
    exit 1
  fi

  if [ "$count" -gt 0 ]; then
    echo "removing $count file(s) this script previously pushed and the repo no longer has:"
    printf '%s\n' "$gone" | sed 's/^/  /'
    # As the pod's own user, like the untar above, rather than as root.
    printf '%s\n' "$gone" |
      kubectl -n "$NAMESPACE" exec -i "$pod" -c "$CONTAINER" -- \
        setpriv --reuid="$POD_UID" --regid="$POD_UID" --init-groups \
        sh -c 'cd /app && xargs -r rm -f'
  fi
fi

# Written after the deletes, so a failed delete is retried on the next run rather than forgotten.
printf '%s\n' "$pushed" |
  kubectl -n "$NAMESPACE" exec -i "$pod" -c "$CONTAINER" -- \
    setpriv --reuid="$POD_UID" --regid="$POD_UID" --init-groups \
    sh -c "cat > $MANIFEST"

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
