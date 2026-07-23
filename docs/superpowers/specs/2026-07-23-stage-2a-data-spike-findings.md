# Stage 2a spike — `why` lens data quality (findings)

**Date:** 2026-07-23 · **Method:** read-only SQLite queries against the live local index
(`nimbus.db`, 26 MB, schema V44) on the primary dev machine. · **Question:** does the data
support building the hover `why` lens now?

## Recommendation: **don't build yet.**

The lens's **precomputed** foundational lane is empty and its enrichment lanes are absent
on a real, actively-used machine. This spike measured persisted index data only; whether an
on-demand local `git blame` fallback could paper over the empty table was out of scope —
but even a perfect fallback still lands on id-only PR titles, 5 issue joins, and zero
conversation/incident sources, so the hover would carry almost nothing worth showing. That
is the exact "correlation quality is data-dependent" failure the roadmap flagged, and
strong support for Open Decision #3's doubt that the editor is even the right first
surface.

## Measurements

| Lane | Live value | Lens impact |
| --- | --- | --- |
| `git_blame_line` (V32) | **0 rows, 0 files** | The precomputed blame → commit → author lane has no data; any hover would depend entirely on on-demand blame (unmeasured here). |
| Index items | 546: gmail 228, `ci_run` 214, `pr` 79, `file` 13, `folder` 5, `issue` 5, `web_clip` 2 | Only 5 services carry data out of ~95 registered connectors. |
| Graph | 86 entities / 89 relations: `targets` 79, `opened` 5, `belongs_to` 5 | PR→issue joins exist for **5 issues total**; 1 person entity (vs 65 rows in `person`). |
| PR titles | Literally `"PR #220"` | Even a working hover would display id-only titles — no human-readable summary lane. |
| Slack / incident / ticket lanes | No Slack, PagerDuty, or Jira items | The "the Slack thread, the incident that drove the change" hover rows have zero sources. |

## What would have to be true first

1. **`git_blame_line` populated** — find out why it is empty on a machine with active git
   repos (unconfigured `[[filesystem.roots]]`? blame indexing gated behind a setting or
   never scheduled?) and fix the pipeline. Without this the lens cannot take its first hop.
2. **PR title enrichment** — `"PR #220"` titles make every downstream hover row unreadable;
   the GitHub connector needs to carry real titles before any UI consumes them.
3. **At least one conversation lane (Slack/Teams) or incident-driver lane (PagerDuty,
   Sentry, or another alerting source) live** on the machine, so "degrades gracefully"
   degrades to something rather than nothing. Jira is the *ticket* lane — useful, but it
   substitutes for neither the discussion thread nor the incident driver.
4. Re-run this spike; build when the precompute lane clears a reproducible bar. Suggested
   bar: sample the `git_blame_line` rows for files modified in the last 90 days in one
   actively-developed indexed repo; **≥60% of those sampled rows must resolve to a PR**
   (numerator: rows whose `commit_sha` joins to a `pr` item; denominator: the sampled
   rows). If the blame table is still empty, the bar is unmet by definition.

## Notes

- The graph lanes that DO exist (`pr --targets--> repo`, `issue` links) came from the
  GitHub connector alone, which reinforces the roadmap's degradation story — git + GitHub
  is the base lane — but the base lane's own first link (blame) is the missing piece.
- This finding feeds [roadmap Open Decision #3](../../ecosystem-roadmap.md#open-decisions):
  nothing measured here argues the editor must own the lens; the *before* (blast radius,
  shipped as `/blast` in Stage 2b) and *after* (postmortem) jobs are already served by the
  brief agents at current data quality.
