# Review: True Coverage — Sub-project C2: fast-check property suite on the pure core — Design

**Date:** 2026-06-13  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Review Completed  
**Target Spec:** [`2026-06-13-true-coverage-C2-property-suite-design.md`](./2026-06-13-true-coverage-C2-property-suite-design.md)

---

## 1. Executive Summary

The design for Sub-project C2 is technically solid. Identifying the encoding bug in `constantTimeStringEqual` (where UTF-8 surrogate collapse led to false positives for unequal strings) is an excellent finding, and switching to `utf16le` is the correct, mathematically sound remedy.

We have reviewed the design details and have a few suggestions to reinforce the security properties, verify the behaviour of the hex-decoder, and ensure robust coverage.

---

## 2. Detailed Feedback & Suggestions

### 2.1. UTF-16LE Injectivity and Timing Symmetry (§2a)

- **Observation:** Switching the encoding to `utf16le` guarantees injectivity on JS strings (including lone surrogates). Since JS strings are compared code-unit by code-unit, this perfectly aligns `constantTimeStringEqual` with `===`.
- **Validation:**
  1. The string length matching check: `a.length === b.length` directly maps to `aBuf.length === bBuf.length` under UTF-16LE (since byte length is always exactly `2 * length`). Timing symmetry is thus perfectly preserved.
  2. The dummy compare `timingSafeEqual(aBuf, aBuf)` is still invoked on length mismatch, keeping the execution time profile symmetric.

---

### 2.2. Hex-Decoding Invariant Validation (§2a)

- **Observation:** `sha256HexEqualConstantTime` checks `bufA.length !== 32`. In Node/Bun, `Buffer.from(str, "hex")` stops decoding at the first invalid hex character.
- **Verification:** Since the input string length is capped at exactly 64 characters, any invalid hex character present in the string will cause the decoded buffer length to be strictly less than 32 bytes (at most 31 bytes). Thus, checking `bufA.length !== 32` is a foolproof guard against malformed hex strings.
- **Suggestion:** Add a property test explicitly verifying that any 64-character string containing one or more non-hex characters always returns `false` (validating the decoder's stop-on-invalid behavior).

---

### 2.3. Attribute Escape Verification in Tool Output (§2b)

- **Observation:** The `wrapToolOutput` property checks that service/tool attributes cannot break out of their XML tags.
- **Suggestion:** Verify that double quotes (`"`) inside `service` and `tool` names are properly escaped. The current implementation replaces `"` with `&quot;`, which is correct since attributes are enclosed in double quotes:

  ```html
  <tool_output service="${escapeAttr(ctx.service)}" ...>
  ```

  Ensure the property test explicitly tests service/tool names containing nested double quotes, single quotes, backslashes, and control characters to confirm no breakout is possible.

---

### 2.4. Vault Key Format Total Function (§2c)

- **Observation:** `isWellFormedVaultKey` uses a RegExp and string checks.
- **Suggestion:** Ensure the property test for `Total function` also covers very long strings (greater than 256 characters) and strings containing carriage returns (`\r`), newlines (`\n`), or control characters to verify that the regex or string functions do not throw errors or hang (catastrophic backtracking).

---

## 3. Conclusion

The C2 design is approved. The `utf16le` transition fixes a genuine security primitive correctness bug and is ready for implementation details.
