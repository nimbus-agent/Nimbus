# Review & Feedback: `nimbus glossary` LLM Wiring, Snippet Upgrades, and Manual Refresh Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design of the `nimbus glossary` LLM wiring, upgrades, and CLI commands specified in [2026-07-31-nimbus-glossary-llm-wiring-design.md](./2026-07-31-nimbus-glossary-llm-wiring-design.md).

---

## 1. Local LLM Selection & Provider Availability

### Q1.1: Visibility of Fallback to Snippet Mode

Because the glossary is a default-on background task, if `use_llm = true` (the default) but local LLM providers (Ollama / Llama.cpp) are unavailable, the pass silently falls back to snippet mode.

- **The Issue:** The user might assume their glossary definitions are being consolidated by a local LLM, when in reality they are getting raw snippets because Ollama isn't running or the model isn't downloaded.
- **Recommendation:**
  1. Add a warning/status indicator in `nimbus glossary` output or logs indicating if the last pass fell back to snippet mode due to lack of a local LLM.
  2. When the user explicitly runs `nimbus glossary --refresh`, if the LLM adapter returns `null` (falling back to snippets), print a warning to the console: `Warning: No local LLM provider is available. Consolidating terms using raw snippets.`

### Q1.2: Abort Signal Propagation to Local Providers

The design opts not to propagate the `AbortSignal` to the underlying HTTP clients of Ollama/Llama.cpp to avoid widening `LlmGenerateOptions`.

- **The Issue:** On lower-spec consumer hardware, local LLM calls are expensive. If a pass is cancelled (e.g., during gateway shutdown or a manual abort), the model execution will continue running on the host system until it hits the 120s timeout. If multiple passes are triggered and cancelled, this could stack up background model runs and degrade performance.
- **Questions:**
  1. How complex is it to pass the signal to `LlmGenerateOptions`? If the underlying `fetch` calls in `OllamaProvider` and `LlamaCppProvider` already support aborting, propagating the signal might be trivial.
  2. If propagation is deferred, should we at least document this as a potential performance bottleneck under heavy restarts?

---

## 2. Snippet-to-LLM Upgrade Path & Starvation

### Q2.1: Guaranteed Budget / Allocation for Upgrades

The design uses a shared budget: `upgradeBatch.length = maxNewTermsPerPass - pendingBatch.length`.

- **The Issue:** Under a permanently-saturated pending queue (e.g., during initial indexing or large sync operations), the pending batch will consistently consume the entire budget (`maxNewTermsPerPass`), completely starving snippet upgrades. Upgrades will never run until the pending queue is fully drained.
- **Recommendation:** Introduce a guaranteed minimum slice for upgrades, or a separate cap. For example:
  - Allocate a minimum of 5 slots (out of 25) for upgrades if any are available.
  - Or add a separate `max_upgrades_per_pass = 5` config parameter to decouple them, keeping background resource consumption predictable while preventing starvation.

### Q2.2: Veto-on-Upgrade and Data Loss Experience

The design states:
> **turning the LLM on can remove terms that were previously in the glossary.** It is not data loss [...] and the row survives as `vetoed`.

- **The Issue:** From a user's perspective, terms they previously saw in their glossary might suddenly vanish after they start or enable their local LLM. This can feel like a bug or data loss.
- **Recommendation:**
  1. When a term is vetoed during an upgrade pass, log it or include it in the `GlossaryPassSummary` (e.g., `vetoedOnUpgrade: string[]` or a count).
  2. In the CLI output for `--refresh`, print a summary of terms that were vetoed (e.g., `Vetoed 3 terms that were previously snippet-defined`).

### Q2.3: Maximum Attempts / Backoff Ceiling

For snippet upgrades, the design uses the retry backoff: `last_attempt_at + MIN(86400000, ? * (1 << (attempts - 1)))`.

- **Question:** Is there a maximum number of attempts? If a snippet consistently fails to upgrade (perhaps due to ambiguous context that causes the LLM to error or timeout repeatedly), it will retry every 24 hours indefinitely. Should there be a cap (e.g. `attempts >= 5`) where we mark it as "failed_upgrade" or stop retrying, leaving it as a snippet?

---

## 3. `--refresh` and `--rebuild` CLI UX

### Q3.1: Detailed Preview for `--rebuild`

`nimbus glossary --rebuild` without `--yes` prints a count:
`47 consolidated terms and 12 pending candidates would be deleted. Re-run with --yes to confirm.`

- **Recommendation:** Show a preview of the terms that will be affected (e.g., the first 5 or 10 terms, followed by `... and 37 more`). This gives the user confidence before executing a destructive command that will trigger a costly re-consolidation.

### Q3.2: Concurrent Pass Cancellation

If a scheduled pass is running, `nimbus glossary --refresh` will fail fast with `ERR_GLOSSARY_PASS_RUNNING`.

- **Question:** Since a scheduled pass can take up to 12.5 minutes, can we provide a way to cancel the current running pass and start the requested one (perhaps via `--force`), or at least display the progress/estimated remaining time of the active pass?

---

## 4. Security & Invariants Check

### Q4.1: Static Verification of `ALLOWED_METHODS`

The design notes that `ALLOWED_METHODS` count remains at 102 because the new glossary RPC methods are not exposed to the Tauri renderer.

- **Verification:** Ensure that adding the new RPC namespace doesn't accidentally trigger static audit failures in `check-nimbus-invariants.ts`. The invariant tests should verify that `glossary.refresh` and `glossary.rebuild` are correctly blocked by `FORBIDDEN_OVER_LAN` and omitted from the Tauri allowlist.
