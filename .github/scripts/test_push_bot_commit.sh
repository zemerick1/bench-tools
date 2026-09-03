#!/usr/bin/env bash
# Race and conflict checks for push-bot-commit.sh. Uses a throwaway
# bare remote and two clones — no network.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/.github/scripts/push-bot-commit.sh"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

git_init() {
  git -C "$1" config user.name test
  git -C "$1" config user.email test@example.com
}

git init --bare "$WORKDIR/remote.git" >/dev/null
git -C "$WORKDIR/remote.git" symbolic-ref HEAD refs/heads/main
git clone "$WORKDIR/remote.git" "$WORKDIR/a" >/dev/null
git_init "$WORKDIR/a"
echo seed >"$WORKDIR/a/file.txt"
git -C "$WORKDIR/a" add file.txt
git -C "$WORKDIR/a" commit -m seed >/dev/null
git -C "$WORKDIR/a" push -u origin HEAD:main >/dev/null
git -C "$WORKDIR/remote.git" symbolic-ref HEAD refs/heads/main

git clone "$WORKDIR/remote.git" "$WORKDIR/b" >/dev/null
git_init "$WORKDIR/b"
git -C "$WORKDIR/b" checkout main >/dev/null

echo oui >"$WORKDIR/a/oui.txt"
git -C "$WORKDIR/a" add oui.txt
git -C "$WORKDIR/a" commit -m "Refresh IEEE OUI registry." >/dev/null

echo other >"$WORKDIR/b/other.txt"
git -C "$WORKDIR/b" add other.txt
git -C "$WORKDIR/b" commit -m "other change" >/dev/null
git -C "$WORKDIR/b" push origin HEAD:main >/dev/null

if git -C "$WORKDIR/a" push origin HEAD:main >/dev/null 2>&1; then
  echo "expected A's naive push to be rejected" >&2
  exit 1
fi

(
  cd "$WORKDIR/a"
  PUSH_BOT_RETRY_SLEEP=0 bash "$SCRIPT" main
)

git clone "$WORKDIR/remote.git" "$WORKDIR/c" >/dev/null
test -f "$WORKDIR/c/oui.txt"
test -f "$WORKDIR/c/other.txt"
echo "race: ok"

git clone "$WORKDIR/remote.git" "$WORKDIR/d" >/dev/null
git clone "$WORKDIR/remote.git" "$WORKDIR/e" >/dev/null
git_init "$WORKDIR/d"
git_init "$WORKDIR/e"
echo d >"$WORKDIR/d/file.txt"
git -C "$WORKDIR/d" add file.txt
git -C "$WORKDIR/d" commit -m d >/dev/null
echo e >"$WORKDIR/e/file.txt"
git -C "$WORKDIR/e" add file.txt
git -C "$WORKDIR/e" commit -m e >/dev/null
git -C "$WORKDIR/e" push origin HEAD:main >/dev/null

set +e
out="$(
  cd "$WORKDIR/d"
  PUSH_BOT_RETRY_SLEEP=0 bash "$SCRIPT" main 2>&1
)"
status=$?
set -e
if [ "$status" -eq 0 ]; then
  echo "expected conflict rebase to fail" >&2
  echo "$out" >&2
  exit 1
fi
echo "$out" | grep -q "not retrying" || {
  echo "expected conflict to skip retries" >&2
  echo "$out" >&2
  exit 1
}
echo "conflict: ok"
echo "push-bot-commit tests passed"
