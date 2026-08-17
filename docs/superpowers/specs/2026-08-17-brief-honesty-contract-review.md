# Review: Brief Honesty Contract Design Spec

Below is a detailed review of the proposed design in [2026-08-17-brief-honesty-contract-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/brief-honesty-contract/docs/superpowers/specs/2026-08-17-brief-honesty-contract-design.md), along with actionable improvements, suggestions, and answers to the open questions.

---

## 1. Heading Parser Edge Cases & Code Blocks

### The Risk
The heading parser scans for `##` to partition reserved sections. If a brief contains user data or code snippets that include `## Gaps` or `## Sources` (for instance, a markdown snippet in a glossary definition or a commit message), a naive line-by-line heading scan might:
1. Incorrectly split the document mid-snippet.
2. Trigger the fail-closed "reserved heading found in body" check and fallback to deterministic rendering.

### Suggestion
Ensure the shared heading parser is **markdown-aware** or at least aware of code blocks (i.e. skips lines between triple backticks ` ``` `). 
* **Action:** The parser should track state to ignore headers within code blocks when splitting.

---

## 2. Structure Preservation via Placeholders (Alternative to End-Appends)

### The Problem
The spec notes that `## Sources` sits mid-document in the deterministic render, but the proposed reassembly algorithm moves all reserved sections to the end of the document. While this simplifies reassembly, it changes the visual flow and document outline of the brief.

### Improvement
Instead of just stripping and appending all reserved sections to the end, replace each isolated reserved section in the template sent to the LLM with a unique HTML comment placeholder (e.g., `<!-- nimbus-reserved:sources -->` or `<!-- nimbus-reserved:gaps -->`).
1. **Extraction:** Split out the reserved sections and replace them in the prompt template with placeholders.
2. **LLM Instruction:** Explicitly tell the LLM (in `SYNTHESIS_INSTRUCTIONS`) to preserve these placeholder comment tags verbatim and not translate or modify them.
3. **Reassembly:** Replace the placeholders in the LLM's output with the verbatim reserved sections.
4. **Fallback:** If a placeholder is missing or mangled in the LLM output, fall back to appending the reserved section at the end (or falling back to the deterministic brief).

This keeps the layout exact and preserves mid-document flow.

---

## 3. Anchor Specificity for Layer 2

### The Problem
The anchor `not necessarily` for "negotiate unattributable decisions" is extremely generic. An LLM could easily output "this is not necessarily a problem" in a rewritten section while dropping the actual disclosure sentence ("not necessarily inactivity...").

### Suggestion
Choose slightly longer or more specific anchors that are highly unlikely to appear in natural prose unless the disclosure itself is present.
* For `negotiate` unattributable incidents: `not necessarily inactivity`
* For `negotiate` unattributable decisions: `not necessarily complete` or similar specific text from the disclaimer.

---

## 4. Responses to Open Questions

### Q1: Invariant placement (I29)
* **Recommendation:** **Separate this into a new invariant.**
* **Rationale:** I29 is explicitly defined as *egress-ledger completeness*. Adding honesty contract checking for LLM brief generation makes I29 overloaded and harder to verify cleanly. A new invariant (e.g., `I31`) dedicated to "Brief Honesty Contract / Disclosure Integrity" makes it easier to trace, write specific tests for, and document in `docs/SECURITY-INVARIANTS.md`.

### Q2: Glossary list-mode `— authored` suffix
* **Recommendation:** Treat it as a Layer 2 disclosure.
* **Rationale:** Since it is a inline suffix in list mode, it cannot be isolated as a section. Export it as a named constant in `_lib/brief-disclosures.ts` and verify it in `contractViolations` when in list mode.

### Q3: Reserved-block placement at the end
* Preserving the original placement using the placeholder approach suggested in section 2 avoids this problem entirely.

---

## 5. Model Stripping Robustness
When stripping headings that the LLM might have hallucinated anyway, use a case-insensitive regex check that accounts for optional trailing whitespace:
```ts
const headingRegex = new RegExp(`^##\\s+${escapeRegex(headingName)}\\s*$`, 'i');
```
This ensures we don't end up with duplicate rendered titles if the model generates them with slightly different whitespace or casing.
