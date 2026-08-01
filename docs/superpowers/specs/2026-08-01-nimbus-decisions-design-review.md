# Review & Feedback: `nimbus decisions` Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design of the `nimbus decisions` command and agent system specified in [2026-08-01-nimbus-decisions-design.md](./2026-08-01-nimbus-decisions-design.md).

---

## 1. Row Identity Stability & Redundant LLM Calls

### Issue: Edit-Induced Cue Shifts
The design states:
> `id` is a BLAKE3 hash of `source_item_id` plus `cue_offset`... an edit that shifts a cue's position produces a new row and orphans the old one — which the reconciliation sweep demotes...

If a user makes a minor edit to a Slack post, Notion page, or issue description (e.g., fixing a typo or adding text prior to the cue), the `cue_offset` shifts. This will:
1. Orphan the old decision row (marking it demoted or deleting it via reconciliation).
2. Create a brand-new candidate row with a new `id`.
3. Re-queue the new candidate for Phase B, triggering a redundant LLM extraction call on the same text.

This wastes the local LLM budget (limited to `max_llm_calls_per_pass = 25`) and can lead to duplicate extractions if the old row has not been garbage collected yet.

### Recommendation
Instead of using the raw character offset `cue_offset` as part of the identity hash, base the identity on the **sentence content** or a surrounding sliding window:
* `id = hash(source_item_id + normalized_cue_sentence)`
* Normalizing the sentence (stripping leading/trailing whitespace, punctuation, and converting to lowercase) ensures that moving the sentence around in the document or editing text *outside* the sentence does not trigger a new extraction.

---

## 2. Corroboration Window & Post-Hoc Documentation

### Issue: Backward Corroboration
The design specifies a **90-day forward window** from `decided_at` for code evidence (PRs, commits, migrations):
> Forward-only: a PR that predates the thread did not implement its decision.

In practice, development workflows often operate in reverse:
1. A developer implements a feature, database migration, or infrastructure change and merges the PR.
2. Shortly after (e.g., a few days later during a retrospectives meeting, in a post-mortem Slack thread, or when updating the project wiki), the team formalizes the decision: *"We decided to go with Postgres because X..."*

Under a strict forward-only window, this corroborating evidence is missed.

### Recommendation
Introduce a short **backward window** (e.g., 7 to 14 days) in the temporal corroboration check:
* Allow evidence whose timestamp satisfies `decided_at - 14 days <= occurred_at <= decided_at + 90 days`.
* Keep the PR/commit connection check, but widen the timeline slightly to handle post-hoc documentation.

---

## 3. Candidate Queue Prioritization & Scoring

### Issue: Starvation of Strong Cues
The design states:
> The extraction queue is ordered by score.

However, prior to Phase B extraction, the final confidence score is not yet computed (as corroboration and completeness are unknown). It is unclear how candidates are scored for extraction ordering. If the system simply uses the `cue_tier` strength as a baseline, that should be formalized. Otherwise, a burst of `weak` cues (e.g., "instead of", "going with") might saturate the 25-call budget, starving `explicit` or `heading` cues.

### Recommendation
Specify the sorting/prioritization logic for candidate rows in `decision_record` where `status = 'pending'`:
* Prioritize by `cue_tier` (e.g., `heading` > `explicit` > `weak`).
* For ties, sort by `decided_at DESC` to ensure fresh decisions are processed first.

---

## 4. Snippet Mode Upgrades & Veto Persistence

### Q4.1: How are snippet-sourced rows selected for upgrade?
When an LLM becomes available, the design states that `snippet`-sourced rows are automatically upgraded.
* **Clarification Question:** How does the refresher select these? Do they bypass the normal watermark query since they were already scanned?
* **Recommendation:** The Phase B extractor should run a secondary query for `status = 'extracted' AND extraction_source = 'snippet'` to fill any remaining slots in the LLM pass budget after processing new `pending` candidates.

### Q4.2: Evicting Vetoed Decisions
What happens if the system prompt or model changes significantly, or if a user wants to force re-evaluation of previously vetoed candidates?
* **Recommendation:** Include an option or clear path to reset vetoes (e.g., `nimbus decisions --reset-vetoed` or resetting `status = 'pending'` for rows where `attempts > X` if requested).

---

## 5. Service Scoping for Non-Code Decisions

### Issue: Missing Context for Process Decisions
> A decision with no code evidence is therefore not matched by `--service`...

Some decisions are process-oriented (e.g., "Adopt trunk-based development") and will have no linked PR or commit. If a user runs `nimbus decisions --service billing`, decisions documented in a channel like `#billing-alerts` or a Notion page under the "Billing Team" namespace will be completely omitted because they lack code-graph edges.

### Recommendation
If a decision has no code evidence, attempt to resolve the service context from the source item itself:
* Check if the source item (e.g., Slack channel name, Notion database name, or Jira project key) matches the `--service` query.
* This ensures high-level process decisions are not lost when filtering by service.
