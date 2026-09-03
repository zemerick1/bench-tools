#!/usr/bin/env bash
# Rebase a bot commit onto the remote branch this job ran on, then push.
# Scheduled jobs often lose a race with a merge or another bot push.
#
# Usage: bash .github/scripts/push-bot-commit.sh <branch>
#   <branch> is GITHUB_REF_NAME: main on schedule/workflow_dispatch and
#   on push-to-main, or e.g. feature/openapi-docs when that branch is
#   what triggered the job. Do not hardcode main — OpenAPI also pushes
#   back to feature/openapi-docs.
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "usage: $0 <branch>" >&2
  exit 2
fi
branch="$1"

git config user.name "${GIT_AUTHOR_NAME:-github-actions[bot]}"
git config user.email "${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}"

max_attempts=5
attempt=0
retry_sleep="${PUSH_BOT_RETRY_SLEEP:-4}"

while true; do
  echo "fetch origin ${branch}"
  git fetch origin "$branch"

  echo "rebase onto origin/${branch}"
  if ! git rebase "origin/$branch"; then
    echo "rebase onto origin/${branch} failed; not retrying (conflict or missing history)"
    git rebase --abort 2>/dev/null || true
    exit 1
  fi

  echo "push HEAD -> ${branch}"
  if git push origin "HEAD:$branch"; then
    echo "pushed to ${branch}"
    exit 0
  else
    status=$?
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$max_attempts" ]; then
    echo "push still rejected after ${attempt} attempts (exit ${status})"
    exit "$status"
  fi
  echo "push failed (exit ${status}); retry ${attempt}/${max_attempts}"
  sleep $((attempt * retry_sleep))
done
