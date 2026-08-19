#!/usr/bin/env bash
# scripts/git-doctor.sh — is a git lock file a real problem, or just litter?
#
#   npm run git:doctor          # report only
#   npm run git:doctor -- --fix # remove locks it has judged safe
#
# WHY THIS EXISTS: a stale `.git/index.lock` blocked commits twice in Aug 2026. `index.lock` is
# git's mutex on the staging area — git creates it before touching `.git/index` (add/commit/
# checkout) and deletes it after, so two processes can't corrupt the index at once. A leftover one
# means a git process died before cleaning up. It affects ONLY git; it cannot touch app data.
#
# The judgement this makes: a lock is safe to remove when NO git process is running. If one IS
# running, removing the lock risks corrupting the index, so it says wait instead. Deliberately
# never removes anything without --fix.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
GITDIR="$(git rev-parse --git-dir 2>/dev/null)" || { echo "not a git repo"; exit 1; }
FIX=0; [ "${1:-}" = "--fix" ] && FIX=1

# Any live git process? (grep pattern bracketed so this script doesn't match itself.)
RUNNING="$(pgrep -fl '[g]it ' 2>/dev/null | grep -v git-doctor || true)"
LOCKS="index.lock HEAD.lock config.lock packed-refs.lock shallow.lock objects/maintenance.lock"

echo "=== git lock check ==="
FOUND=0; REMOVED=0
for rel in $LOCKS; do
  f="$GITDIR/$rel"
  [ -e "$f" ] || continue
  FOUND=$((FOUND+1))
  size=$(wc -c < "$f" | tr -d ' ')
  when=$(date -r "$f" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "?")
  echo
  echo "  found: $rel  (${size} bytes, created ${when})"
  if [ -n "$RUNNING" ]; then
    echo "  ⛔ A git process IS running — LEAVE IT ALONE. Removing this could corrupt the index."
    echo "     $RUNNING"
  else
    echo "  ✅ No git process running → this lock is STALE and safe to remove."
    if [ "$FIX" = "1" ]; then rm -f "$f" && echo "     removed." && REMOVED=$((REMOVED+1));
    else echo "     to clear it:  npm run git:doctor -- --fix"; fi
  fi
done

if [ "$FOUND" = "0" ]; then echo "  ✅ No lock files present — nothing wrong."; fi

# The two things that were genuinely broken in Aug 2026 — flag them if they come back.
echo
echo "=== config health ==="
helper="$(git config --local --get credential.helper || true)"
if [ -n "$helper" ]; then
  path="$(printf '%s' "$helper" | sed -n 's/.*--file=\([^ ]*\).*/\1/p')"
  if [ -n "$path" ] && [ ! -e "$path" ]; then
    echo "  ⚠️  local credential.helper points at a MISSING file: $path"
    echo "     that throws 'unable to get credential storage lock' on every push. Clear it with:"
    echo "     git config --local --unset-all credential.helper"
  else
    echo "  ✅ local credential.helper looks fine ($helper)"
  fi
else
  echo "  ✅ no local credential.helper override (falls back to the system one)"
fi

if [ -e "$GITDIR/gc.log" ]; then
  echo "  ⚠️  .git/gc.log exists → a background gc failed. Read it, then: git gc --prune=now"
else
  echo "  ✅ no failed gc"
fi

echo
echo "=== working tree ==="
git status --porcelain=v1 >/dev/null 2>&1 && echo "  ✅ git status works ($(git status --porcelain | wc -l | tr -d ' ') uncommitted files)" \
  || echo "  ⛔ git status FAILED — see the lock section above"

[ "$FIX" = "1" ] && [ "$REMOVED" -gt 0 ] && echo && echo "Removed $REMOVED lock file(s). Try your git command again."
exit 0
