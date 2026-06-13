# True Coverage C1 — Audit-redaction boundary fix + property lock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the credential-redaction blind spot in `audit/format-audit-payload.ts` (tokens adjacent to / containing `_`, and fine-grained `github_pat_` tokens, escape the `\b`-anchored scrubber) and lock it with fast-check property tests, including a structural guard against generator drift.

**Architecture:** Replace each pattern's fragile `\b` anchors with an explicit leading `(?<![A-Za-z0-9])` and a trailing negative-lookahead **aligned to that pattern's own body charset**; split the GitHub family into two patterns (classic excludes `_`, fine-grained includes it) so a shared lookahead can't re-open the escape; export the patterns as a labeled `{name → RegExp}` map so a property test can prove 1:1 generator coverage. Pure regex + test change — no API/signature change, redaction only ever redacts *more*.

**Tech Stack:** Bun 1.3.14 · TypeScript 6.x strict · `bun:test` · `fast-check@4.8.0` (already a `gateway` devDependency).

**Spec:** [`docs/superpowers/specs/2026-06-13-true-coverage-C-depth-design.md`](../specs/2026-06-13-true-coverage-C-depth-design.md) §3 (+ §10 review dispositions).

**Worktree:** `C:\gitrep\Nimbus\.claude\worktrees\tc-C` · branch `dev/asafgolombek/true-coverage-C`. All paths below are repo-relative to that worktree.

---

## File structure

- **Modify:** `packages/gateway/src/audit/format-audit-payload.ts` — convert the module-private
  `SENSITIVE_VALUE_PATTERNS: ReadonlyArray<RegExp>` into an **exported** labeled
  `ReadonlyMap<string, RegExp>` with the boundary-fixed regexes; iterate `.values()` in the scrubber.
  (One file, ~50 lines; no caller changes — `redactAuditPayload`/`formatAuditPayload` signatures are
  untouched.)
- **Modify:** `packages/gateway/src/audit/format-audit-payload.test.ts` — keep the 7 existing tests;
  add a `GENERATORS` map, a per-family positive property, a negative prose-preservation property
  (Task 1), and the structural 1:1 drift guard (Task 2).

No other files change. No migration, no coverage-baseline change (tests + a tightened regex; net
source coverage only holds or rises).

---

## Task 1: Fix the boundary bug, locked by behavioral property tests

**Files:**

- Modify: `packages/gateway/src/audit/format-audit-payload.ts:1-49`
- Test: `packages/gateway/src/audit/format-audit-payload.test.ts`

- [ ] **Step 0: Confirm no security-invariant test pins these regex literals**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
grep -rn "SENSITIVE_VALUE_PATTERNS\|gh\[pousr\]\|redactAuditPayload" packages/gateway/src/security-invariants.test.ts || echo "NONE — safe"
```

Expected: `NONE — safe` (the audit scrubber is a sibling of I11, not an invariant wiring site). If
any hit appears, stop and reconcile with the spec §3.4 before proceeding.

- [ ] **Step 1: Write the failing property tests (behavioral, via the public API)**

Append to `packages/gateway/src/audit/format-audit-payload.test.ts`. Add the `fc` import at the top
(next to the existing imports):

```typescript
import fc from "fast-check";
```

Then append this block at the end of the file (after the closing `});` of the existing
`describe("redactAuditPayload (S2-F2)", …)`):

```typescript
// --- C1: property-based redaction lock (fast-check) ---

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALNUM_US = `${ALNUM}_`; // alnum + underscore (fine-grained PAT body)
const ALNUM_USD = `${ALNUM}_-`; // alnum + underscore + dash (sk- bodies)
const ALNUM_D = `${ALNUM}-`; // alnum + dash (slack body)
const ALNUM_UD = `${ALNUM}_-`; // alnum + underscore + dash (jwt segments)
const UPPERNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; // aws body
const BEARER_BODY = `${ALNUM}_.+/-`; // bearer body charset

/** A random string of `chars`, length in [min, max]. */
function charsetArb(chars: string, min: number, max = min + 24): fc.Arbitrary<string> {
  return fc
    .array(fc.constantFrom(...chars.split("")), { minLength: min, maxLength: max })
    .map((a) => a.join(""));
}

/**
 * One generator per production SENSITIVE_VALUE_PATTERN family. Each yields a
 * structurally valid token (correct prefix + random body of the correct charset
 * and >= the minimum length). Keys MUST match the production map's keys — the
 * structural guard in Task 2 enforces that 1:1.
 */
const GENERATORS: ReadonlyMap<string, fc.Arbitrary<string>> = new Map([
  [
    "github_classic",
    fc
      .tuple(fc.constantFrom("p", "o", "u", "s", "r"), charsetArb(ALNUM, 20))
      .map(([c, b]) => `gh${c}_${b}`),
  ],
  ["github_fine_grained", charsetArb(ALNUM_US, 20).map((b) => `github_pat_${b}`)],
  [
    "openai",
    fc.tuple(fc.boolean(), charsetArb(ALNUM_USD, 20)).map(([proj, b]) => `sk-${proj ? "proj-" : ""}${b}`),
  ],
  ["anthropic", charsetArb(ALNUM_USD, 20).map((b) => `sk-ant-${b}`)],
  [
    "slack",
    fc
      .tuple(fc.constantFrom("b", "o", "a", "p", "r"), fc.boolean(), charsetArb(ALNUM_D, 10))
      .map(([c, s, b]) => `xox${c}${s ? "s" : ""}-${b}`),
  ],
  [
    "bearer",
    fc.tuple(charsetArb(BEARER_BODY, 16), fc.constantFrom("", "=", "==")).map(([b, eq]) => `Bearer ${b}${eq}`),
  ],
  [
    "jwt",
    fc
      .tuple(charsetArb(ALNUM_UD, 3), charsetArb(ALNUM_UD, 3), charsetArb(ALNUM_UD, 3))
      .map(([a, b, c]) => `eyJ${a}.${b}.${c}`),
  ],
  ["aws", fc.tuple(fc.constantFrom("AKIA", "ASIA"), charsetArb(UPPERNUM, 16, 16)).map(([p, b]) => `${p}${b}`)],
]);

// Non-empty, non-alphanumeric separators — guarantee a token boundary on each
// side. Includes "_" specifically to prove the underscore-adjacency fix.
const SEP = fc.constantFrom(" ", "_", ":", "=", ",", "(", "[", "/", '"', "'", "\n", ".");
// Clearly non-secret prose: lowercase letters + spaces only (cannot match any
// pattern — every pattern needs a digit/dash/underscore/uppercase or a fixed prefix).
const LOWORD = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), { minLength: 1, maxLength: 8 })
  .map((a) => a.join(""));
const PROSE = fc.array(LOWORD, { minLength: 1, maxLength: 6 }).map((a) => a.join(" "));
const PROSE_OR_EMPTY = fc.oneof(fc.constant(""), PROSE);

describe("redactAuditPayload — property: every token family is scrubbed anywhere", () => {
  for (const [name, gen] of GENERATORS) {
    test(`scrubs ${name} tokens regardless of surrounding noise`, () => {
      fc.assert(
        fc.property(
          gen,
          PROSE_OR_EMPTY,
          SEP,
          SEP,
          PROSE_OR_EMPTY,
          fc.boolean(),
          (token, lead, s1, s2, trail, nest) => {
            const embedded = `${lead}${s1}${token}${s2}${trail}`;
            // Test both a bare-string payload and a value nested under a generic
            // (non-sensitive) key — redaction must reach both.
            const payload = nest ? { note: embedded } : embedded;
            const out = redactAuditPayload(payload);
            // The token (the secret material) must not survive...
            expect(out.includes(token)).toBe(false);
            // ...and a redaction marker must be present.
            expect(out.includes("[REDACTED]")).toBe(true);
          },
        ),
        { numRuns: 300 },
      );
    });
  }
});

describe("redactAuditPayload — property: ordinary prose is preserved", () => {
  test("never redacts lowercase-letter prose", () => {
    fc.assert(
      fc.property(PROSE, (prose) => {
        const out = redactAuditPayload({ note: prose });
        expect(out.includes(prose)).toBe(true);
        expect(out.includes("[REDACTED]")).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
});
```

- [ ] **Step 2: Run the new property tests against the LIVE (unfixed) module — verify they FAIL**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
bun test packages/gateway/src/audit/format-audit-payload.test.ts -t "property" 2>&1 | tail -25
```

Expected: **FAIL.** fast-check finds and shrinks counterexamples — at minimum the `github_fine_grained`
family (prefix never matched) and the `github_classic`/others with an `_` separator on a side
(boundary escape). This proves the §3.1 blind spot on the real module before the fix.

- [ ] **Step 3: Apply the boundary fix in the source module**

Replace the top of `packages/gateway/src/audit/format-audit-payload.ts` (lines 1-21, the
`DEFAULT_MAX_BYTES`/`SENSITIVE_KEY`/`SENSITIVE_VALUE_PATTERNS`/`redactSensitiveValueString` block)
with:

```typescript
const DEFAULT_MAX_BYTES = 4096;

const SENSITIVE_KEY = /(token|key|secret|password|credential|bearer|auth|^pat$)/i;

/**
 * Credential-shaped value patterns, keyed by a stable family name.
 *
 * Boundary design: JavaScript `\b` treats `_` as a word character, so a token
 * adjacent to — or containing — `_` sits between two "word" chars, produces no
 * boundary, and silently escapes redaction. Each pattern instead uses an
 * explicit leading `(?<![A-Za-z0-9])` and a trailing negative lookahead aligned
 * to that pattern's OWN body charset.
 *
 * The two GitHub prefixes are kept as separate patterns because their bodies
 * differ (classic `gh[pousr]_` excludes `_`; fine-grained `github_pat_` includes
 * it). A single shared trailing lookahead over a union would have to pick one
 * charset, and an `_`-inclusive lookahead re-opens the `ghp_…_x` escape this
 * scrubber fixes.
 *
 * Exported so the redaction property test can assert 1:1 generator coverage.
 */
export const SENSITIVE_VALUE_PATTERNS: ReadonlyMap<string, RegExp> = new Map([
  ["github_classic", /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?![A-Za-z0-9])/g],
  ["github_fine_grained", /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?![A-Za-z0-9_])/g],
  ["openai", /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g],
  ["anthropic", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])/g],
  ["slack", /(?<![A-Za-z0-9])xox[boapr]s?-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g],
  // Trailing lookahead EXCLUDES `=` on purpose: a token with 3+ trailing `=`
  // (e.g. `Bearer <body>===`) would otherwise backtrack-fail and LEAK the whole
  // credential. Excluding `=` lets `={0,2}` consume the padding and redact.
  // (verified during plan review §2.3). Hyphen escaped for lint/consistency.
  ["bearer", /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9_.\-+/]{16,}={0,2}(?![A-Za-z0-9_./+\-])/g],
  ["jwt", /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g],
  ["aws", /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g],
]);

function redactSensitiveValueString(s: string): string {
  let out = s;
  for (const pat of SENSITIVE_VALUE_PATTERNS.values()) {
    out = out.replace(pat, "[REDACTED]");
  }
  return out;
}
```

Leave the rest of the file (`redact`, `formatAuditPayload`, `redactAuditPayload`) unchanged.

- [ ] **Step 4: Run the full audit test file — verify ALL pass (new properties + existing 7)**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
bun test packages/gateway/src/audit/format-audit-payload.test.ts 2>&1 | tail -15
```

Expected: **PASS** — all property tests green and the 7 pre-existing tests still green (the change
only ever redacts more; the `"sketch a plan"` guard and the key-based redactions are unaffected).

- [ ] **Step 5: Typecheck the changed package**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C/packages/gateway && bun run typecheck 2>&1 | tail -15
```

Expected: no errors in `audit/format-audit-payload.ts` or its test. (If `@nimbus-dev/client`
false-fails, run `cd packages/client && bun run build` once, per the worktree gotcha.)

- [ ] **Step 6: Commit**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
git add packages/gateway/src/audit/format-audit-payload.ts packages/gateway/src/audit/format-audit-payload.test.ts
git commit -m "fix(audit): close credential-redaction boundary escapes (underscore-adjacent + github_pat_)

The \\b-anchored scrubber treated _ as a word char, so gh/sk-/AKIA/JWT tokens
adjacent to or containing _ — and all fine-grained github_pat_ tokens — escaped
audit redaction. Replace \\b with explicit (?<![A-Za-z0-9]) + body-aligned
trailing lookaheads; split the gh family into classic + fine-grained patterns.
Locked with fast-check property tests over every token family embedded in
adversarial noise (incl. underscore adjacency) + a prose-preservation property.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Structural 1:1 generator-drift guard

Prevents a future pattern being added to the production scrubber (or a generator) without its
counterpart — the property suite would otherwise silently stop covering it.

**Files:**

- Test: `packages/gateway/src/audit/format-audit-payload.test.ts`

- [ ] **Step 1: Import the exported pattern map**

Edit the top import of the test file to also pull in the patterns map:

```typescript
import { formatAuditPayload, redactAuditPayload, SENSITIVE_VALUE_PATTERNS } from "./format-audit-payload.ts";
```

- [ ] **Step 2: Add the structural guard test**

Append at the end of `packages/gateway/src/audit/format-audit-payload.test.ts`:

```typescript
describe("redactAuditPayload — structural: every pattern has a generator", () => {
  test("GENERATORS keys are 1:1 with SENSITIVE_VALUE_PATTERNS keys", () => {
    const patternKeys = [...SENSITIVE_VALUE_PATTERNS.keys()].sort();
    const generatorKeys = [...GENERATORS.keys()].sort();
    // If this fails, a token family was added/removed in the production scrubber
    // without updating GENERATORS (or vice-versa) — the property suite would stop
    // fuzzing it. Fix by adding the matching generator/pattern.
    expect(generatorKeys).toEqual(patternKeys);
  });
});
```

- [ ] **Step 3: Run the file — verify the guard passes**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
bun test packages/gateway/src/audit/format-audit-payload.test.ts 2>&1 | tail -12
```

Expected: **PASS** — the 8 production keys match the 8 generator keys.

- [ ] **Step 4: Prove the guard actually catches drift (temporary, do NOT commit)**

Temporarily delete one generator entry (e.g. the `aws` line in `GENERATORS`) and re-run:

```bash
bun test packages/gateway/src/audit/format-audit-payload.test.ts -t "1:1" 2>&1 | tail -8
```

Expected: **FAIL** on the keyset mismatch. Then restore the deleted line and re-run to confirm
green again. (This is a manual sanity check — leave the file restored.)

- [ ] **Step 5: Commit**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
git add packages/gateway/src/audit/format-audit-payload.test.ts
git commit -m "test(audit): structural 1:1 guard — every scrub pattern has a fast-check generator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Validate, push, open PR

**Files:** none (validation + git).

- [ ] **Step 1: Confirm I11 / audit invariants still hold**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
bun test packages/gateway/src/security-invariants.test.ts 2>&1 | tail -8
bun run audit:invariants 2>&1 | tail -8
```

Expected: both **PASS** (no invariant references the scrubber regexes; this change is behavior-only).

- [ ] **Step 2: Run the cheap static pre-flight + the audit subtree**

Run:

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
bun run preflight:fast 2>&1 | tail -20
bun test packages/gateway/src/audit 2>&1 | tail -10
```

Expected: pre-flight static gates green; the whole `audit/` subtree green. (Biome may be skipped in
the worktree via `!**/.claude` — if `preflight:fast` reports 0 lint files, validate with
`bunx biome check packages/gateway/src/audit/format-audit-payload.ts packages/gateway/src/audit/format-audit-payload.test.ts`.)

- [ ] **Step 3: Push the branch**

```bash
cd C:/gitrep/Nimbus/.claude/worktrees/tc-C
git push -u origin dev/asafgolombek/true-coverage-C
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --base main --head dev/asafgolombek/true-coverage-C \
  --title "fix(audit): close credential-redaction boundary escapes + property lock (True Coverage C1)" \
  --body "$(cat <<'BODY'
## What

Sub-project **C1** of the True Coverage program (depth: property-based testing).

Fixes an audit-redaction blind spot found by a fast-check spike: the `\b`-anchored
credential scrubber in `audit/format-audit-payload.ts` treats `_` as a word char,
so tokens **adjacent to or containing `_`** — and **all fine-grained `github_pat_`**
tokens — escaped redaction (validated on the live module). The same latent class
existed in the `sk-`/`xox`/`Bearer`/JWT/`AKIA` patterns.

## How

- Replace each pattern's `\b` anchors with explicit `(?<![A-Za-z0-9])` + a trailing
  negative lookahead **aligned to that pattern's own body charset**.
- Split the GitHub family into `github_classic` + `github_fine_grained` (different
  body charsets; a shared union lookahead would re-open the escape — verified).
- Export the patterns as a labeled `{name → RegExp}` map.

## Tests

- fast-check **positive** property: every token family, embedded in adversarial
  noise (incl. `_` adjacency, nested under a generic key), is always scrubbed.
- fast-check **negative** property: lowercase prose is never redacted.
- **Structural 1:1 guard**: every production pattern has a generator (drift-proof).
- The 7 pre-existing unit tests stay green; I11 / audit invariants unchanged.

Spec: `docs/superpowers/specs/2026-06-13-true-coverage-C-depth-design.md` §3.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 5: Watch CI to green**

Authoritative gate: **PR quality — TS/Bun (ubuntu-24.04) / Unit + Coverage**. The windows-2025
cross-platform leg is the chronic flake — rerun, don't chase. Fix and resolve every CodeRabbit +
Sonar thread.

---

## Review dispositions (2026-06-13)

Addressing [the plan review](./2026-06-13-true-coverage-C1-redaction-fix-review.md):

1. **§2.1 Bearer generator padding — ACCEPTED.** The `bearer` generator now emits 0/1/2 trailing
   `=` (`fc.constantFrom("", "=", "==")`), exercising the production regex's `={0,2}` suffix.
   Verified all padding lengths redact, including when an `=` separator follows.
2. **§2.2 Escape the hyphen in the Bearer lookahead — ACCEPTED.** Changed `(?![A-Za-z0-9_./+-])`
   → `(?![A-Za-z0-9_./+\-])`. Confirmed byte-identical behavior (trailing `-` was already literal);
   the escape is for lint-safety + consistency with the body class `[A-Za-z0-9_.\-+/]`.
3. **§2.3 `=` excluded from the Bearer lookahead — ACKNOWLEDGED, no change; now empirically
   confirmed + documented in code.** Tested the rejected alternative (`=` *in* the lookahead): a
   `Bearer <body>===` input **leaks the entire credential** (backtrack-fail), whereas the accepted
   design redacts it. Added an inline comment at the pattern so a future editor doesn't "tidy" `=`
   into the lookahead and silently re-open the leak.

## Self-review notes (author)

- **Spec coverage:** §3.2 fix (Task 1 Step 3) ✓ · §3.3 positive/negative properties (Task 1 Step 1) ✓
  · §3.3 structural 1:1 guard + labeled-map export (Task 1 Step 3 export + Task 2) ✓ · §3.4 invariant
  confirm (Task 1 Step 0 + Task 3 Step 1) ✓ · §6 validation/push (Task 3) ✓.
- **Type consistency:** `SENSITIVE_VALUE_PATTERNS` is a `ReadonlyMap<string, RegExp>` in source and
  imported with that type in the test; `GENERATORS` is `ReadonlyMap<string, fc.Arbitrary<string>>`;
  keys match (asserted by Task 2). `charsetArb(chars, min, max=min+24)` signature is used with 2 args
  everywhere except `aws` (3 args, fixed length 16).
- **No placeholders:** every code/command step is concrete and runnable.
