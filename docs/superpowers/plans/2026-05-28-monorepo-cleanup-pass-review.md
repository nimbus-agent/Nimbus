# Review: Monorepo Cleanup Pass Implementation Plan

The implementation plan is incredibly detailed and structured perfectly for execution by an agent. The step-by-step nature, with explicit verification checks (expected output) after every command, is excellent.

Here are some open questions, suggestions, and improvements to consider before executing the plan:

## 1. Robustness of Pass 1 (Survey) Scripts

* **Regex for AST Tasks (Task 1.6):** The `survey-oc.ts` script uses regex (`IF_LITERAL_RE`, `CASE_LITERAL_RE`) to find `if` and `switch` blocks. Regex parsing of source code is notoriously brittle (it can easily trip on commented-out code, strings, or multi-line statements). Since we already use the `typescript` compiler API in Pass 3 (`strip-comments.ts`), consider using the TS AST to find Open/Closed violations. It will be significantly more accurate and resilient.

## 2. Robustness of Pass 3 (Comment Strip)

* **Rust Raw String Literals (Task 3.1):** The `stripRustSource` function uses a basic manual state machine to ignore strings (`"` and `'`). However, Rust frequently uses raw string literals (e.g., `r#"..."#` or `r##"..."##`). If any of the `.rs` files contain raw string literals with `//` or `/*` inside them, this basic state machine will incorrectly parse them and potentially corrupt the file. Please verify if Tauri Rust code uses raw strings, and if so, either refine the parser or fall back to a proper Rust formatting/stripping tool like `rustfmt` if possible.
* **Internal JSDoc:** I want to reiterate the concern from the design review: stripping all internal JSDoc outside of `sdk` and `client` will hurt internal DX (loss of IDE tooltips for complex engine types).

## 3. Connector Sync Dedupe (Pass 4)

* **`runConnectorSync` Fake Response (Task 4.6):** The implementation constructs a `fakeResp` to pass to the pagination strategy:

  ```typescript
  const fakeResp = {
    headers: responseLike.headers ?? new Headers(),
    body: responseLike.body ?? page,
  };
  ```

  If `fetchPage` returns a raw array (which many APIs do), `responseLike.body` will be undefined, and `fakeResp.body` becomes the array itself. Make sure the Pagination strategies (like `CursorPagination`) are designed to handle both full HTTP response objects and raw body payloads robustly.
* **Scope of Task 4.7:** Iterating through 30+ connectors and manually adapting them to the new template will be a very long process. While the plan wisely suggests one commit per connector, be prepared for this specific task to take the majority of the agent's time.

## 4. PR Size / Delivery

* **Mega PR (Task 6.7):** The PR generation template confirms this will be one single massive PR. As mentioned in the design review, a PR containing a monorepo-wide comment deletion *and* massive core architectural refactoring will be extremely difficult for a human to review. Splitting this into two PRs (Docs/Strip vs. Dedupe/SOLID) is highly recommended.

## Conclusion

The plan is highly actionable. If you are confident that Rust raw strings are not an issue (or easily fixed) and the single Mega PR approach is firmly decided upon, the plan is ready for execution.
