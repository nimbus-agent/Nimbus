# Review: Brief Honesty Contract Design Spec

Below is a detailed review of the proposed design in [2026-08-17-brief-honesty-contract-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/brief-honesty-contract/docs/superpowers/specs/2026-08-17-brief-honesty-contract-design.md), along with actionable improvements, suggestions, and responses to the open questions.

---

## 1. Validation of Core Design Choices

### Layered Approach (Layer 1 & Layer 2)
The split between **Layer 1 (Reserved Sections)** for whole-section disclosures and **Layer 2 (Anchor Phrases)** for interleaved lines is elegant and correct. It avoids the fragile and paraphrase-killing approach of requiring exact phrase matches for multi-paragraph caveats, while still ensuring that inline, context-sensitive disclaimers are not quietly dropped by LLM rewrites.

### Appending at the End vs. Placeholders
The decision to reject the placeholder scheme in favor of appending reserved blocks at the end is sensible. LLMs are notoriously prone to mangling or omitting raw HTML comments (`<!-- nimbus-reserved:* -->`), which would cause unnecessary synthesis failures. Since the deterministic layout naturally places these sections at the tail of every brief, appending them post-synthesis reproduces the original structure robustly without relying on LLM cooperation.

---

## 2. Technical Edge Cases & Suggestions

### A. Code Blocks and Backticks in Brief Content
* **The Risk:** Glossary entries, git commit messages, or Slack messages index-matched by agents might contain literal markdown headings (e.g., a code snippet demonstrating Markdown structure containing `## Gaps`). A naive heading parser could misinterpret these lines as document section boundaries.
* **Suggestion:** The shared heading parser (extracted from `brief-contract.ts:40` `sectionBody()`) should be code-block aware. It must ignore any heading pattern that occurs within triple backticks (```).

### B. Stripping Hallucinated Near-Miss Headings
* **The Risk:** The spec states that LLMs will be instructed not to emit reserved sections, but they may ignore negative constraints. If the LLM emits a heading like `### Gaps`, `## Gaps and Caveats`, or `## Gaps:`, a strict string prefix check might fail to strip it, resulting in duplicate or confusing headers in the final output.
* **Suggestion:** Implement a robust regex matcher for stripping hallucinated headings from the model's output. The pattern should support:
  * Optional variations in heading levels (e.g., `##` or `###`).
  * Case insensitivity.
  * Common trailing punctuation or modifiers (e.g. `## Gaps & Caveats`, `## Gaps:`).
  * Example: `/^(?:##+|#)\s*Gaps\b/i`

### C. Double-Rendering Performance Check
* **Assertion Overhead:** The fail-closed check calls `deterministicRender` twice: once with `omitReserved: true` and once without.
* **Verification:** Ensure that all fourteen `render*` functions are completely pure and operate strictly on the pre-fetched `brief` memory object. No renderer should perform database queries or asynchronous network operations during string concatenation. 

### D. Static Analysis Rule for Registry Completeness
* **The Risk:** A developer might add a 15th agent brief kind next year and forget to add its reserved heading configuration to the registry or fail to wire `omitReserved` in its renderer.
* **Suggestion:** While the spec notes there is no static `D`-rule, we should add a check in `scripts/structure-audit/check-nimbus-invariants.ts` that enforces:
  1. The union of all implemented brief kinds matches the registry keys.
  2. Every renderer function has a parameter signature accepting `RenderOpts`.

---

## 3. Responses to Open Questions

### Q1: Invariant placement (I29)
* **Agreement:** **Separate this into a new invariant `I31`.**
* **Rationale:** Keeping `I29` focused purely on egress-ledger completeness avoids overloading the invariant. `I31` specifically guards disclosure integrity and maps to a separate threat model (silent LLM censorship/omission of caveats).
* **Renumbering worked example:** Make sure `SECURITY-INVARIANTS.md:677` is updated to use `I32` (or the next free index) as its illustrative example to prevent documentation drift.

### Q2: Glossary list-mode `— authored` suffix
* **Agreement:** **Defer as proposed.**
* **Rationale:** The visual and informational loss of a list-mode provenance tag is minimal compared to a dropped confidence ceiling. Widening the parser to support level-1 headings (`# Glossary`) just for this single inline label introduces unnecessary complexity and potential parser regressions.

---

## 4. Layer 2 Anchor Verification

The revised anchors are far superior to the original `not necessarily` draft:
* `no indexed assignee or resolver` (Incidents)
* `no indexed author` (Decisions)
* `no LLM configured` (Glossary snippet)
* `not derived from indexed sources` (Glossary manual)

### Suggestion for Test Coverage
Ensure the test suite explicitly asserts that **synthesized paraphrases** that keep the anchor are accepted. For example, a test should verify that:
> *"The decisions listed are authorship-derived, but they are not necessarily yours since..."*

passes the Layer 2 guard successfully, while a paraphrase that drops the anchor fails.
