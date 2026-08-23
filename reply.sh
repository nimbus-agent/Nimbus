#!/usr/bin/env bash
# reply.sh <threadId> <bodyFile>  — post a reply into a review thread, then resolve it.
set -euo pipefail
TID="$1"; BODY_FILE="$2"
BODY="$(cat "$BODY_FILE")"
gh api graphql -f query='mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t, body:$b}){clientMutationId}}' -f t="$TID" -f b="$BODY" >/dev/null
gh api graphql -f query='mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{isResolved}}}' -f t="$TID" --jq '.data.resolveReviewThread.thread.isResolved'
