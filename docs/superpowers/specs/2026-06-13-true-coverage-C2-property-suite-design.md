# True Coverage — Sub-project C2: fast-check property suite on the pure core — Design

**Date:** 2026-06-13
**Branch:** `dev/asafgolombek/true-coverage-C2`
**Status:** Design — awaiting review
**Owner:** AsafGolombek
**Parent spec:** [`2026-06-13-true-coverage-C-depth-design.md`](./2026-06-13-true-coverage-C-depth-design.md) §4 (C2 sketch); C1 shipped as PR #596 (squash `f974c02a`).

## 1. Context

Sub-project C (depth: mutation + property-based) ships as three slices. **C1** (the audit-redaction
boundary fix + property lock) merged. **C2** is the rest of the fast-check property suite over the
pure security core; **C3** is the StrykerJS harness (own plan, deferred).

C2 characterizes three pure modules with fast-check property tests. Two are pure characterization
(no source change expected); the third carries **one small source fix** — a functional bug in the
I10 constant-time compare, found during this design (see §2a). `fast-check@4.8.0` is already a
`gateway` devDependency, so C2 adds no dependencies, no Docker, and no coverage-reseed machinery.

## 2. Targets

### 2a. `util/timing-safe-compare.ts` (I10) — SOURCE FIX + properties

The module exposes two pure comparators:

- `sha256HexEqualConstantTime(a, b)` — true iff both are 64-char hex decoding to 32 bytes and the
  bytes are equal; false otherwise.
- `constantTimeStringEqual(a, b)` — true iff the strings are equal; length-mismatch returns false
  (after a dummy `timingSafeEqual` for timing symmetry).

**Bug found during design (reproduced):** `constantTimeStringEqual` encodes both operands with
`Buffer.from(s, "utf8")`. UTF-8 encoding is **not** injective over arbitrary JS strings — distinct
lone surrogates (and any string containing U+FFFD) collapse to the replacement bytes `EF BF BD`. So
`constantTimeStringEqual("\uD800", "\uDC00")` returns **`true`** for two unequal strings. This is a
functional correctness gap in an I10 primitive (used for tokens / MACs / pairing-codes).

**Fix:** encode with `"utf16le"` instead of `"utf8"`. UTF-16LE is a bijection on JS strings (each
code unit → 2 bytes, no replacement), so distinct strings always yield distinct buffers. The
constant-time intent is preserved: `timingSafeEqual` still runs over equal-length buffers, and the
length-mismatch branch still performs its dummy compare and returns false. Equal-code-unit-length
⟺ equal utf16le-byte-length, so the length-mismatch branch fires exactly as before. Existing
callers (ASCII/hex/base64 tokens) are unaffected — utf16le is identical in behavior there.

**Properties (functional oracle only):**

- `constantTimeStringEqual(a, b) === (a === b)` over arbitrary strings, including:
  generated lone surrogates, equal pairs, length-mismatched pairs, and unicode. Fails today on the
  surrogate case; passes after the fix.
- `sha256HexEqualConstantTime(a, b)` oracle: for two generated valid 64-char hex strings (any
  case), result === (the decoded bytes are equal) — i.e. case-insensitive byte equality, **not**
  string equality. For malformed inputs (length ≠ 64, non-hex chars, decoded length ≠ 32), result
  is `false`.

**Documented:** fast-check verifies **functional** equality only; it cannot verify the
constant-time property, which stays a manual/review invariant (parent spec §9 note). The fix does
not weaken it.

### 2b. `engine/tool-output-envelope.ts` (I11) — CHARACTERIZE (no source change expected)

`wrapToolOutput(ctx, result)` JSON-serializes `result`, replaces any literal `</tool_output>` in the
body with `<\/tool_output>`, HTML-escapes the `service`/`tool` attributes, and wraps in
`<tool_output service="…" tool="…">…</tool_output>`.

**Properties:**

- **Body cannot break out of the envelope.** For arbitrary `result` (objects, arrays, and strings
  containing `</tool_output>`, `<tool_output>`, `"`, `<`, `>`, unicode), the output contains
  **exactly one** literal `</tool_output>` (the real closing tag) and begins with the well-formed
  opening tag `<tool_output service="…" tool="…">`.
- **Attributes cannot break out.** For arbitrary `service`/`tool` strings (incl. `"`, `<`, `>`,
  `&`), the rendered attribute values contain no raw `"`, `<`, or `>` (all escaped), so a crafted
  service/tool can't terminate the attribute or the opening tag early.

**Scope decision:** the exact `</tool_output>` token is the contract — the LLM is instructed on that
exact delimiter and no lenient XML parser is in the consumption path. C2 does **not** harden against
whitespace/case variants (`</tool_output >`, `</TOOL_OUTPUT>`); that is out of scope (YAGNI for the
actual threat model). If a future need arises it gets its own slice.

### 2c. `vault/key-format.ts` + `CONNECTOR_VAULT_SECRET_KEYS` — CHARACTERIZE (new test file)

`isWellFormedVaultKey(key)` validates a `service.subkey…` shape via a regex + length/`..`/trailing-dot
guards; `validateVaultKeyOrThrow` wraps it; `compareVaultKeysAlphabetically` is a `localeCompare`.
No test file exists today — C2 creates `vault/key-format.test.ts`.

**Properties / invariants:**

- **Manifest invariant:** every key in `CONNECTOR_VAULT_SECRET_KEYS` (flattened across all services)
  passes `isWellFormedVaultKey`. Catches a malformed/typo'd manifest entry at test time.
- **Total function:** `isWellFormedVaultKey` never throws on an arbitrary string — always returns a
  boolean.
- **Consistency:** `validateVaultKeyOrThrow(k)` throws ⟺ `!isWellFormedVaultKey(k)`, over arbitrary
  strings and over the manifest keys.

These avoid re-implementing the regex (which would just restate it); they pin the contract
(total, consistent, manifest-clean).

## 3. Files

- **Modify (source):** `packages/gateway/src/util/timing-safe-compare.ts` — `utf8` → `utf16le` in
  `constantTimeStringEqual` (two `Buffer.from` calls).
- **Modify (test):** `packages/gateway/src/util/timing-safe-compare.test.ts`,
  `packages/gateway/src/engine/tool-output-envelope.test.ts` — extend existing files with the
  property tests.
- **Create (test):** `packages/gateway/src/vault/key-format.test.ts`.

No migration, no coverage-baseline change.

## 4. Testing & verification

- All property tests run in the standard gateway `bun test` suite (`fast-check@4.8.0`, native).
- Authoritative gate: **PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage**; windows-2025
  cross-platform red is the chronic flake (rerun).
- Re-run `security-invariants.test.ts` + `audit:invariants` to confirm I10/I11 hold (the utf16le
  fix is behavior-preserving except for the surrogate edge; the envelope is untouched).
- Settled-tree `tsc --noEmit`; Biome via `bunx biome check` on changed files (worktree skips Biome
  via `!**/.claude`); markdownlint the new docs from inside the worktree (`--fix`; add `text` to
  bare fences).
- No Docker/coverage-reseed (tests added; source net-coverage holds/rises).

## 5. Sequencing

C2 → merge → C3 (StrykerJS; parent spec §5, runner §11 resolved) → Sub-project D (shrink
`exclusions.ts`). C3 and D each get their own plan.

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| utf16le change weakens or breaks the I10 primitive | Behavior-preserving for well-formed inputs (verified); existing timing-safe tests + the new functional property pin it; constant-time intent preserved (equal-length `timingSafeEqual`) |
| A property re-implements the regex/escaper (tautology) | Properties assert *contracts* (one closing tag, no raw quotes, total/consistent/manifest-clean), not the implementation |
| Envelope property finds a real breakout | Fix-in-slice like C1 (none expected from the reasoning) |
| New `key-format.test.ts` coverage dips a sibling | Pure-additive tests; net coverage holds/rises; no baseline change |

## 7. Open questions

- Whether the envelope or key-format properties surface a real bug (as the surrogate probe did for
  timing-safe) — handled in-slice if so.
