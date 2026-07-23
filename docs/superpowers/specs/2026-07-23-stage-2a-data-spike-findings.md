# Stage 2a spike — `why` lens data quality (findings)

**Date:** 2026-07-23 · **Method:** read-only SQLite queries against the live local index
(`nimbus.db`, 26 MB, schema V44) on the primary dev machine. · **Question:** does the data
support building the hover `why` lens now?

## Recommendation: **don't build yet.**

The lens's foundational lane is empty and its enrichment lanes are absent on a real,
actively-used machine. Built today, the hover would render blank almost everywhere — the
exact "correlation quality is data-dependent" failure the roadmap flagged, and strong
support for Open Decision #3's doubt that the editor is even the right first surface.

## Measurements

| Lane | Live value | Lens impact |
| --- | --- | --- |
| `git_blame_line` (V32) | **0 rows, 0 files** | The blame → commit → author chain — the lens's first hop — has no data at all. |
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
3. **At least one conversation/incident lane live** (Slack or Jira or PagerDuty credentials
   on the machine) so "degrades gracefully" degrades to something rather than nothing.
4. Re-run this spike; build when blame coverage on an active repo is non-trivial and the
   blame→PR join rate on recent lines clears a bar worth demoing (suggest: ≥60% of lines in
   a recently-active repo resolve to a PR).

## Notes

- The graph lanes that DO exist (`pr --targets--> repo`, `issue` links) came from the
  GitHub connector alone, which reinforces the roadmap's degradation story — git + GitHub
  is the base lane — but the base lane's own first link (blame) is the missing piece.
- This finding feeds [roadmap Open Decision #3](../../ecosystem-roadmap.md#open-decisions):
  nothing measured here argues the editor must own the lens; the *before* (blast radius,
  shipped as `/blast` in Stage 2b) and *after* (postmortem) jobs are already served by the
  brief agents at current data quality.
