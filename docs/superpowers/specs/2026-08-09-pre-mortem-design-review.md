# Review: `nimbus pre-mortem` Design

This document contains feedback, open questions, and suggested improvements for the [2026-08-09-pre-mortem-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/pre-mortem/docs/superpowers/specs/2026-08-09-pre-mortem-design.md) specification.

---

## 1. Cohort Selection & Service Overlap Bias

### The Monolith/Shared-Service Problem

The spec states: *"The cohort is selected by service overlap: past epics that touched some of the same services as the target."*

* **Risk:** If the target epic touches a very common or monolithic service (e.g., `api-gateway`, `shared-utils`, or a core database service), the candidate pool might instantly match almost every closed epic in the system. This dilutes the cohort's relevance, washing out the signal from more specific services (e.g., `billing-v2` or `auth-service`).
* **Suggestion:**
  * Implement **TF-IDF style weighting** or a **Jaccard similarity coefficient** for ranking service overlaps. An overlap on a rare service (e.g., `billing-provider-x`) should rank a candidate much higher than an overlap on a ubiquitous service (e.g., `monolith-api`).
  * Alternatively, support a configuration blacklist/exclusion list for services that should be ignored for cohort overlap matching (e.g., `infra-config`).

### Candidate Scan Ordering

The parameter `max_candidate_scan` defaults to 200.

* **Open Question:** How are the closed epics sorted before taking the top 200 candidates to evaluate?
* **Suggestion:** They must be sorted by `resolved_at_ms` descending to ensure the cohort is drawn from the most recent historical context first, rather than arbitrary database order.

---

## 2. Structural Risks & Computations

### Target Metrics for Newly Created Epics

* **Open Question:** The cycle time risk compares the cohort's median cycle time against the target epic's *elapsed-so-far* time. If a user runs `nimbus pre-mortem` immediately after creating an epic, the elapsed-so-far is 0 (or a few minutes). How should the brief present this comparison?
* **Suggestion:** If `elapsed_so_far < 1 day`, display the cohort's historical median cycle time as an *estimate/expectation* (e.g., *"Historically, similar epics took 24 days to complete"*) rather than flag it as a comparison.

### Incident Coupling Correlation

* **Open Question:** The spec defines incident coupling as *"share of cohort epics with an incident correlates_with a deploy in-window"*. How is `correlates_with` computed? Is there an existing database schema mapping incidents to deploys, or is this time-proximity based?
* **Suggestion:** Define the exact time-window tolerance (e.g., within 24 hours of a deploy associated with a child PR of the epic) to avoid ambiguity in implementation.

---

## 3. Watchers & Re-runs

### Re-creating Deleted Watchers

The spec states: *"Two rules make re-runs safe: (1) Content-derived watcher id... (2) Insert-if-absent; never update enabled."*

* **Open Question:** If a user runs `pre-mortem`, decides they never want to see a specific watcher, and *deletes* the watcher row entirely from the DB, what happens on the next run? It will be re-inserted as a paused watcher because it is absent. Is this the desired behavior, or should deleted watchers be marked as "ignored/archived" rather than deleted, to prevent re-creation?
* **Suggestion:** If the UI/CLI allows deleting watchers, we should either:
    1. Keep a tombstone state (e.g., `enabled = -1` or `archived = 1`) rather than physical deletion, so the insert-if-absent check knows not to recreate it.
    2. Accept that physical deletion means it will be re-created as paused on re-run, but clarify this in the developer notes.

---

## 4. Background Extraction Pass & Fallbacks

### Verbatim-Snippet Fallback Strategy

* **Open Question:** When no local LLM is available (`use_llm = false` or no local model loaded), the extraction pass falls back to "verbatim-snippet". How are these snippets identified?
* **Suggestion:** Implement a basic regex/keyword heuristic looking for common blocker phrases (e.g., `"block"`, `"delay"`, `"wait"`, `"incident"`, `"fallback"`, `"broken"`, `"dependency"`) in ticket descriptions/summaries to pull contextually rich fallback snippets, rather than grabbing random sentences.

### Performance & Memory Boundaries

* **Suggestion:** Since ticket descriptions can be large and the pass runs debounced post-sync, ensure that the background theme extractor fetches only the necessary text columns (`summary`, `description`) and strictly limits the batch size per pass iteration to avoid high memory usage.
