#!/usr/bin/env bash
# List the unresolved review threads of a pull request.
#
# `reviewThreads(first: 100)` plus `totalCount` is a trap: the count includes
# every thread, but only the first page's nodes are inspected, so unresolved
# threads on later pages read as zero (measured: 5 open threads all sat on page
# 7 of 7 while the first page reported none). This paginates every page.
#
# Usage: scripts/pr-threads.sh <owner/repo> <number>
#
# Exit status: 0 always (it reports, it does not gate), 2 on a usage error.

set -uo pipefail

REPO=${1:?usage: pr-threads.sh <owner/repo> <number>}
NUMBER=${2:?missing pull request number}
OWNER=${REPO%%/*}
NAME=${REPO##*/}

COUNT_QUERY='query ($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        totalCount
        nodes { isResolved }
      }
    }
  }
}'

LIST_QUERY='query ($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          path
          comments(first: 1) { nodes { author { login } createdAt body } }
        }
      }
    }
  }
}'

counts=$(gh api graphql --paginate -F owner="$OWNER" -F name="$NAME" -F number="$NUMBER" \
  -f query="$COUNT_QUERY" \
  --jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length' 2>&1)
if printf '%s' "$counts" | grep -qi 'error\|timed out'; then
  printf 'pr-threads: gh failed: %s\n' "$counts"
  exit 2
fi

total=$(printf '%s\n' "$counts" | awk '{s+=$1} END {print s+0}')
pages=$(printf '%s\n' "$counts" | wc -l | tr -d ' ')
printf '%s#%s: %s unresolved thread(s) across %s page(s)\n' "$REPO" "$NUMBER" "$total" "$pages"

if [ "$total" -gt 0 ]; then
  gh api graphql --paginate -F owner="$OWNER" -F name="$NAME" -F number="$NUMBER" \
    -f query="$LIST_QUERY" \
    --jq '.data.repository.pullRequest.reviewThreads.nodes[]
          | select(.isResolved == false)
          | "  \(.path) | \(.comments.nodes[0].author.login) \(.comments.nodes[0].createdAt)\n    \(.comments.nodes[0].body[0:300] | gsub("\n"; " "))"' 2>&1 \
    | grep -v '^$'
fi
