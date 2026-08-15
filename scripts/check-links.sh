#!/usr/bin/env bash
# Link check with the one mitigation that actually works against a transient 504.
#
# lychee does NOT retry a rejected status code — `max_retries` covers transport
# errors only (measured: a 504 and a 503 were each fetched exactly once, while a
# dropped connection was fetched four times). github.com returns an occasional 504
# from scripted egress, which had been red-flagging this gate on links that answer
# 200 seconds later.
#
# So: cache the successes, keep transient failures OUT of the cache, and run twice.
# The second pass re-checks only what failed, which costs seconds rather than
# repeating the full ~2-minute sweep. A genuinely dead link fails both passes and
# still fails the gate — unlike accepting 5xx as success, which would hide it.
#
# Set GITHUB_TOKEN to resolve github.com links through the API instead of scraping
# HTML; the API path is far less rate-limited. CI does this automatically, so a local
# run without a token is the one most likely to see a 504.
set -uo pipefail

# Transient by nature: rate limits and gateway/upstream failures. Deliberately NOT
# 4xx — a 404 is a real broken link and must stay cached and reported.
readonly TRANSIENT='429,500..504'

run_lychee() {
  lychee --no-progress --config lychee.toml \
    --cache --max-cache-age 1h --cache-exclude-status "${TRANSIENT}" \
    "docs/**/*.md" "*.md"
}

if run_lychee; then
  exit 0
fi

echo ""
echo "lychee reported failures; retrying ONLY the uncached (transient) links." >&2
echo "Anything that fails again is reported as a real broken link." >&2
echo ""
sleep 10
run_lychee
