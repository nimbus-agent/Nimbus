#!/usr/bin/env bash
# Link check that survives a transient github.com 504.
#
# WHY A RETRY IS NEEDED AT ALL: lychee does NOT retry a rejected status code.
# `max_retries` / `retry_wait_time` cover TRANSPORT errors only. Measured against a
# local server that counts requests: a 504 and a 503 were each fetched exactly ONCE,
# while a dropped connection was fetched FOUR times (1 + 3 retries). So a 504 — which
# github.com returns intermittently to scripted egress, on URLs that answer 200
# seconds later — is final as far as lychee is concerned, and the retry has to happen
# out here.
#
# WHY THE RETRY IS CHEAP: `--cache` stores SUCCESSFUL results, so the second pass
# re-checks only what failed. Verified by request count across two passes: the two OK
# URLs were fetched once each, the 504 URL twice. A full sweep is ~2 minutes; the
# retry is sub-second.
#
# WHAT --cache-exclude-status IS AND IS NOT DOING: on lychee 0.24.2 it is redundant —
# a control run WITHOUT it still re-fetched 500/503/504 on the second pass and left an
# empty cache file, i.e. this version does not cache failures at all. It is kept as
# belt-and-braces in case that behaviour changes, and written in the INCLUSIVE form
# (`500..=504`); the exclusive form `500..504` would mean 500-503 and silently drop 504
# from the set, which is the one status this script exists for.
#
# NOT `accept = ["504"]`: treating 5xx as success would hide a genuinely dead host,
# which is the one thing a link checker must not do. A real 404 fails BOTH passes and
# still fails the gate (verified).
#
# Set GITHUB_TOKEN to resolve github.com links through the API rather than scraping
# HTML. It reduces the 504 rate but does NOT eliminate it — a CI run with the token
# set still hit one, which is what prompted this script.
set -uo pipefail

# Transient by nature: rate limits, and gateway/upstream failures. Deliberately NOT
# 4xx — a 404 is a real broken link and must stay reported.
readonly TRANSIENT='429,500..=504'

# lychee's exit codes: 0 = all links OK, 1 = input/config error (e.g. a missing input
# file), 2 = link-check failures. Only 2 is worth a second pass — retrying an input
# error just repeats it. Note 2 is also the conventional usage-error code, so a typo in
# the flags below would be retried once; that costs nothing, since lychee rejects it
# immediately.
readonly EXIT_LINK_FAILURES=2

run_lychee() {
  lychee --no-progress --config lychee.toml \
    --cache --max-cache-age 1h --cache-exclude-status "${TRANSIENT}" \
    "docs/**/*.md" "*.md"
}

run_lychee
status=$?

if [ "${status}" -ne "${EXIT_LINK_FAILURES}" ]; then
  # 0, or a failure a retry cannot help with. Pass it through unchanged.
  exit "${status}"
fi

echo "" >&2
echo "lychee reported link failures; retrying — the cache means only the failed" >&2
echo "links are re-checked. Anything that fails again is a real broken link." >&2
echo "" >&2
sleep 10
run_lychee
