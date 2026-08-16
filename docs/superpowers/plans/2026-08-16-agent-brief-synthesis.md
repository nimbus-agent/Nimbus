# Agent Brief Synthesis (W6-A0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the built-in agents' synthesis path executable in production — under an opt-in
configuration, behind a deterministic honesty guard, with the model egress it can produce ledgered.

**Architecture:** The plumbing already exists end-to-end; `AgentsRpcContext.llm` threads to all
fourteen agents and neither production caller supplies it, so `SYNTHESIS_INSTRUCTIONS` never runs.
This plan supplies it from one factory gated on `[agents].synthesis` (`off` / `local` / `any`),
resolves the provider per invocation rather than trusting `prefersLocal()`, appends a `model` egress
row before any non-local call, and discards any synthesis that drops a contractual disclaimer.

**Tech Stack:** Bun v1.2+, TypeScript strict (no `any`), `bun:test`, `bun:sqlite`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-16-agent-brief-synthesis-design.md`](../specs/2026-08-16-agent-brief-synthesis-design.md)
· Review: [`…-design-review.md`](../specs/2026-08-16-agent-brief-synthesis-design-review.md)
· Response: [`…-design-review-response.md`](../specs/2026-08-16-agent-brief-synthesis-design-review-response.md)

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **No new security invariant, no migration, no Tauri allowlist change.** If a task appears to need
  one, stop and escalate — it means the design was wrong, not that the rule bends.
- **`EGRESS_SOURCE_TYPES` is frozen.** Use the existing `"model"` member. Do **not** add a source
  type. `COVERAGE_CLASSES` order is the wire format (serialized into the boot marker's hashed
  `source_id`) — do not reorder or insert.
- **D22(b):** the identifier `appendEgressEntry` may only appear in `packages/gateway/src/egress/*`.
  New callers import a named recorder from that directory instead.
- **Default is `synthesis = "local"`.** `"any"` is the only value that may reach a remote provider.
- **Timeout default 20000 ms**, configurable. Not 3–5 s — that rejects every synthesis on a cold
  Ollama, which reproduces the inert-feature failure this work exists to fix.
- **Every fallback path emits the deterministic render *with* its footer.** See Task 5 — today
  `synthesize.ts:168` and `:171` return unfootered markdown, which this plan fixes.
- Run `bun run preflight:fast` before the final push. `bun test <path>` for scoped runs.
- Commit on the branch `dev/asafgolombek/agent-brief-synthesis`. Never on `main`.

## File Structure

**Create**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/agents/_lib/brief-contract.ts` | Pure. Derives required (heading, phrase) pairs per brief kind; checks normalized, section-scoped survival. No LLM, no DB. |
| `packages/gateway/src/agents/_lib/brief-contract.test.ts` | Tests for the above. |
| `packages/gateway/src/egress/synthesis-egress.ts` | `recordSynthesisEgress` — the `model`-class appender. |
| `packages/gateway/src/egress/synthesis-egress.test.ts` | Tests for the above. |
| `packages/gateway/src/agents/_lib/synthesis-llm.ts` | Builds a `SynthesisRunner` from config + `LlmRouter`. Owns provider resolution, the egress append, and the timeout. |
| `packages/gateway/src/agents/_lib/synthesis-llm.test.ts` | Tests for the above. |

**Modify**

| File | Change |
| --- | --- |
| `packages/gateway/src/config/nimbus-toml.ts` | New `[agents]` section + parser/loader pair, mirroring `[glossary]` at `:1589-1603`. |
| `packages/gateway/src/agents/_lib/synthesize.ts` | Return a `SynthesisOutcome` instead of a bare string; apply the contract guard; footer every fallback. |
| `packages/gateway/src/agents/_lib/emit-brief.ts` | Carry `synthesis` provenance on the `briefReady` notification. |
| `packages/gateway/src/egress/egress-coverage.ts` | `model: "none"` → `"per-call"`, with the narrowing recorded in the docstring. |
| `packages/cli/src/commands/prove.ts` | `COVERAGE_CLASS_LABELS` gains `model`. Hand-maintained mirror — required, not optional. |
| `packages/gateway/src/ipc/server/dispatchers.ts:133` | Pass `runner` from the shared factory. |
| `packages/gateway/src/agent-runs/agent-http-invoke.ts:98` | Pass `runner` from the same factory. |
| `docs/roadmap.md` | Correct the four Wave 6 rows. |

---

### Task 1: `[agents]` configuration

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts` (follow the `[glossary]` pair at `:1589-1603`)
- Test: `packages/gateway/src/config/nimbus-toml-agents.test.ts` (create)

**Interfaces:**

- Consumes: `forEachSectionEntry`, `parseIntDec`, `loadTomlSection` from the existing TOML
  primitives.
- Produces: `type NimbusAgentsToml = { synthesis: "off" | "local" | "any"; synthesisTimeoutMs: number }`,
  `DEFAULT_NIMBUS_AGENTS_TOML`, `parseNimbusAgentsToml(raw, defaults)`,
  `loadNimbusAgentsFromConfigDir(configDir)`.

> **There is no aggregate `parseNimbusToml`.** Every section owns a parser + loader pair. Mirror
> `[glossary]` at `nimbus-toml.ts:1589-1603` exactly — it is the closest sibling in both shape and
> vintage.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/config/nimbus-toml-agents.test.ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_AGENTS_TOML, parseNimbusAgentsToml } from "./nimbus-toml.ts";

describe("[agents]", () => {
  test("defaults to local synthesis with a 20s timeout", () => {
    expect(DEFAULT_NIMBUS_AGENTS_TOML.synthesis).toBe("local");
    expect(DEFAULT_NIMBUS_AGENTS_TOML.synthesisTimeoutMs).toBe(20000);
  });

  test("parses all three modes", () => {
    for (const mode of ["off", "local", "any"] as const) {
      expect(parseNimbusAgentsToml(`[agents]\nsynthesis = "${mode}"\n`).synthesis).toBe(mode);
    }
  });

  test("an unrecognised mode falls back to the safe default, never to any", () => {
    expect(parseNimbusAgentsToml(`[agents]\nsynthesis = "remote"\n`).synthesis).toBe("local");
  });

  test("an absent section yields the defaults", () => {
    expect(parseNimbusAgentsToml("").synthesis).toBe("local");
  });

  test("parses synthesis_timeout_ms", () => {
    expect(parseNimbusAgentsToml(`[agents]\nsynthesis_timeout_ms = 4500\n`).synthesisTimeoutMs).toBe(4500);
  });

  test("a non-numeric timeout falls back to the default rather than 0", () => {
    expect(parseNimbusAgentsToml(`[agents]\nsynthesis_timeout_ms = "soon"\n`).synthesisTimeoutMs).toBe(20000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml-agents.test.ts`
Expected: FAIL — `DEFAULT_NIMBUS_AGENTS_TOML` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `nimbus-toml.ts`, mirroring the `[glossary]` block's structure:

```ts
// [agents] — built-in agent brief synthesis (Spine S1, W6-A0)
// ---------------------------------------------------------------------------

export type SynthesisMode = "off" | "local" | "any";

export type NimbusAgentsToml = {
  /**
   * Default "local", NOT "any". "any" is the first path by which indexed content
   * can leave the machine without a connector being involved, so it is opt-in.
   */
  synthesis: SynthesisMode;
  /**
   * Deliberately generous. Briefs are fire-and-forget (emit-brief.ts:54 returns
   * before the work), so this does not gate a caller — it exists so a hung
   * provider yields a deterministic brief rather than a briefReady that never
   * arrives. A 3-5s value would reject every synthesis on a cold Ollama.
   */
  synthesisTimeoutMs: number;
};

export const DEFAULT_NIMBUS_AGENTS_TOML: NimbusAgentsToml = {
  synthesis: "local",
  synthesisTimeoutMs: 20000,
};

const SYNTHESIS_MODES: ReadonlySet<string> = new Set(["off", "local", "any"]);

function applyNimbusAgentsKey(out: NimbusAgentsToml, key: string, valRaw: string): void {
  if (key === "synthesis") {
    const v = valRaw.trim().replace(/^"|"$/g, "");
    // Unknown values fall back to the default. Never widen to "any" on a typo.
    if (SYNTHESIS_MODES.has(v)) out.synthesis = v as SynthesisMode;
    return;
  }
  if (key === "synthesis_timeout_ms") {
    const n = parseIntDec(valRaw);
    if (n !== undefined && n > 0) out.synthesisTimeoutMs = n;
  }
}
```

Then the parser + loader pair, mirroring `parseNimbusGlossaryToml` / `loadNimbusGlossaryFromConfigDir`
(`nimbus-toml.ts:1589-1603`) exactly:

```ts
export function parseNimbusAgentsToml(
  raw: string,
  defaults: NimbusAgentsToml = DEFAULT_NIMBUS_AGENTS_TOML,
): NimbusAgentsToml {
  const out: NimbusAgentsToml = { ...defaults };
  forEachSectionEntry(raw, "[agents]", (key, valRaw) => applyNimbusAgentsKey(out, key, valRaw));
  return out;
}

export function loadNimbusAgentsFromConfigDir(configDir: string): NimbusAgentsToml {
  return loadTomlSection(
    join(configDir, "nimbus.toml"),
    DEFAULT_NIMBUS_AGENTS_TOML,
    parseNimbusAgentsToml,
  );
}
```

Note `applyNimbusAgentsKey` mutates a full `NimbusAgentsToml` seeded from defaults, not a
`Partial<>` — so an unrecognised value leaves the default in place rather than writing `undefined`
over it. That is what makes the "falls back, never widens to `any`" test pass.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml-agents.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml-agents.test.ts
git commit -m "feat(config): add [agents] synthesis mode and timeout"
```

---

### Task 2: The contract guard

**Files:**

- Create: `packages/gateway/src/agents/_lib/brief-kinds.ts` (see the extraction step below)
- Create: `packages/gateway/src/agents/_lib/brief-contract.ts`
- Modify: `packages/gateway/src/agents/_lib/synthesize.ts` (import the two moved symbols)
- Test: `packages/gateway/src/agents/_lib/brief-contract.test.ts`

> **Step 0 — break the cycle before writing anything else.** `SynthInput` (`synthesize.ts:54`) and
> `assertNeverBrief` (`:83`) are both module-**private** today. Importing them from `synthesize.ts`
> into `brief-contract.ts` would work — until Task 5 makes `synthesize.ts` import
> `contractViolations` back. `assertNeverBrief` is a RUNTIME function, so that is a real runtime
> cycle, not a type-only one, and CLAUDE.md forbids circular dependencies outright.
>
> So: **move** the `SynthInput` union and `assertNeverBrief` (with its docstring, which records why
> the guard exists) into a new `agents/_lib/brief-kinds.ts`, exported. `synthesize.ts` imports them
> from there; `brief-contract.ts` imports them from there. Neither imports the other. Verify with
> `bun run typecheck` before proceeding.

**Interfaces:**

- Consumes: `SynthInput`, `assertNeverBrief` — from `./brief-kinds.ts`, never from `./synthesize.ts`.
- Produces:
  - `type RequiredPhrase = { readonly heading: string; readonly phrase: string }`
  - `requiredPhrases(brief: SynthInput): readonly RequiredPhrase[]`
  - `contractViolations(brief: SynthInput, markdown: string): string[]` — returns human-readable
    descriptions; empty array means the synthesis is acceptable.

This task is pure — no LLM, no DB, no async. That is deliberate: it is the guard the whole design
leans on, so it must be testable as a plain function.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/agents/_lib/brief-contract.test.ts
import { describe, expect, test } from "bun:test";
import { contractViolations, requiredPhrases } from "./brief-contract.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";

// ALL SEVEN nullable lanes null. NegotiateBrief has seven (negotiate-types.ts:103-109),
// each rendering its own "_could not be computed_" (render.ts:662,690,716,743,764,841,865).
// A fixture covering only two would leave five lanes unguarded with every test green.
function allNullLaneBrief(): NegotiateBrief {
  return {
    kind: "negotiate",
    authoredPrs: null,
    reviewedPrs: null,
    incidents: null,
    tickets: null,
    ownership: null,
    decisions: null,
    writing: null,
  } as unknown as NegotiateBrief;
}

const ALL_SEVEN = [
  "## PRs authored", "## PRs reviewed", "## Incidents", "## Tickets",
  "## Ownership", "## Decisions", "## Writing",
].map((h) => `${h}\n\n_could not be computed_`).join("\n\n");

describe("requiredPhrases", () => {
  // FIXTURE INTEGRITY. The fixture is a hand-written `as unknown as` cast, and this repo has
  // shipped a fixture that ENCODED the bug it was meant to catch. If a field is renamed or a
  // lane is missed, requiredPhrases silently returns fewer pairs, every "accepts" test below
  // passes VACUOUSLY (no requirements = nothing to violate), and the guard protects nothing.
  // This assertion is what makes that failure loud.
  test("derives one requirement per null lane — all seven", () => {
    expect(requiredPhrases(allNullLaneBrief()).length).toBe(7);
  });
});

describe("contractViolations", () => {
  test("accepts markdown that preserves every disclaimer", () => {
    expect(contractViolations(allNullLaneBrief(), ALL_SEVEN)).toEqual([]);
  });

  test("accepts a SUFFIXED heading", () => {
    // render.ts:789 documents headings like "## Ownership — services: checkout". Exact
    // heading equality would report a perfectly good section as missing and reject every
    // negotiate synthesis that has one.
    const md = ALL_SEVEN.replace("## Ownership", "## Ownership — services: checkout");
    expect(contractViolations(allNullLaneBrief(), md)).toEqual([]);
  });

  test("accepts a REFORMATTED disclaimer — this is what keeps the guard usable", () => {
    const md = ALL_SEVEN
      .replace("_could not be computed_", "*could not be computed*")
      .replace("_could not be computed_", "Could Not Be Computed");
    expect(contractViolations(allNullLaneBrief(), md)).toEqual([]);
  });

  test("rejects when ONE of seven identical disclaimers is dropped", () => {
    // The exact failure a document-wide substring check passes: six survive, one does not.
    const md = ALL_SEVEN.replace("## Tickets\n\n_could not be computed_", "## Tickets\n\n- 4 closed");
    const v = contractViolations(allNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Tickets");
  });

  test("rejects a dropped heading rather than skipping the section", () => {
    const md = ALL_SEVEN.replace("## Writing\n\n_could not be computed_", "");
    const v = contractViolations(allNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("Writing");
  });

  test("a non-null lane requires nothing — 0 is a real measurement, not a gap", () => {
    // The inverse defect: guarding a lane that legitimately reports zero would force the
    // disclaimer onto a lane that DID run, which is the "null is not 0" rule backwards.
    const brief = { ...allNullLaneBrief(), tickets: { opened: 0, closed: 0 } } as unknown as NegotiateBrief;
    expect(requiredPhrases(brief).length).toBe(6);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/brief-contract.test.ts`
Expected: FAIL — module `./brief-contract.ts` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway/src/agents/_lib/brief-contract.ts
import type { SynthInput } from "./brief-kinds.ts";
import { assertNeverBrief } from "./brief-kinds.ts";

export type RequiredPhrase = { readonly heading: string; readonly phrase: string };

const NOT_COMPUTED = "could not be computed";

/**
 * Strip markdown emphasis and collapse whitespace so a model that re-formats a
 * phrase is not treated as one that DELETED it. Without this the guard rejects
 * every real synthesis and the feature ships inert.
 */
function normalize(s: string): string {
  return s
    .replace(/[_*`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Body text under `## <heading>`, up to the next heading of any level.
 *
 * Heading match is a normalized PREFIX, not equality: `render.ts:789` documents headings
 * rendered as `## Ownership — services: checkout`, and exact matching would report that
 * section missing and reject an otherwise-correct synthesis.
 */
function sectionBody(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const target = normalize(heading);
  let i = lines.findIndex(
    (l) => l.startsWith("#") && normalize(l.replace(/^#+/, "")).startsWith(target),
  );
  if (i < 0) return undefined;
  const body: string[] = [];
  for (i += 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("#")) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * All SEVEN nullable negotiate lanes (`negotiate-types.ts:103-109`). `null` means the lane
 * could not be computed and MUST say so; a non-null lane reporting zero is a real
 * measurement and requires nothing — guarding it would invert the "null is not 0" rule the
 * whole honesty contract rests on.
 */
const NEGOTIATE_LANES = [
  ["authoredPrs", "PRs authored"],
  ["reviewedPrs", "PRs reviewed"],
  ["incidents", "Incidents"],
  ["tickets", "Tickets"],
  ["ownership", "Ownership"],
  ["decisions", "Decisions"],
  ["writing", "Writing"],
] as const;

export function requiredPhrases(brief: SynthInput): readonly RequiredPhrase[] {
  if (brief.kind === "negotiate") {
    const out: RequiredPhrase[] = [];
    for (const [field, heading] of NEGOTIATE_LANES) {
      if (brief[field] === null) out.push({ heading, phrase: NOT_COMPUTED });
    }
    return out;
  }
  // Every other brief kind returns [] until its contractual strings are added.
  // Listed explicitly so a fifteenth kind is a COMPILE error, not a silent [].
  if (
    brief.kind === "expert" || brief.kind === "impact" || brief.kind === "catchup" ||
    brief.kind === "ghost" || brief.kind === "conflict" || brief.kind === "janitor" ||
    brief.kind === "preflight" || brief.kind === "why" || brief.kind === "glossary" ||
    brief.kind === "decisions" || brief.kind === "ownership" || brief.kind === "huddle" ||
    brief.kind === "premortem"
  ) {
    return [];
  }
  return assertNeverBrief(brief);
}

export function contractViolations(brief: SynthInput, markdown: string): string[] {
  const out: string[] = [];
  for (const { heading, phrase } of requiredPhrases(brief)) {
    const body = sectionBody(markdown, heading);
    if (body === undefined) {
      out.push(`missing required section "${heading}"`);
      continue;
    }
    if (!normalize(body).includes(normalize(phrase))) {
      out.push(`section "${heading}" dropped required phrase "${phrase}"`);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/agents/_lib/brief-contract.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Red-prove the guard by reverting it**

This is **in addition to** the negative test cases above, not a substitute for them, because it
catches a different defect class. A negative test asserts the guard rejects bad markdown *given a
working fixture*. Reverting asserts the **test itself is capable of failing** — the failure mode
where a mis-cast fixture makes `requiredPhrases` return `[]`, every "accepts" assertion pass
vacuously, and the suite go green over a guard that guards nothing. This repo has shipped six
such tests in a single PR.

Two reverts, each with a specific expected failure:

1. Change `sectionBody` to return the whole `markdown` rather than the scoped body.
   Expected: **"rejects when ONE of seven identical disclaimers is dropped"** FAILS (0 violations).
2. Change `normalize` to a no-op returning its input.
   Expected: **"accepts a REFORMATTED disclaimer"** FAILS — proving that test would have caught the
   guard-rejects-everything failure mode rather than passing incidentally.

Restore after each.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/agents/_lib/brief-contract.ts packages/gateway/src/agents/_lib/brief-contract.test.ts
git commit -m "feat(agents): add normalized, section-scoped brief contract guard"
```

---

### Task 3: `model` egress appender and coverage raise

**Files:**

- Create: `packages/gateway/src/egress/synthesis-egress.ts`
- Test: `packages/gateway/src/egress/synthesis-egress.test.ts`
- Modify: `packages/gateway/src/egress/egress-coverage.ts`
- Modify: `packages/cli/src/commands/prove.ts`

**Interfaces:**

- Consumes: `appendEgressEntry` (`egress/egress-ledger.ts`), `redactEgressSummary`
  (`egress/egress-record.ts`) — both already imported this way by `sync-egress.ts`.
- Produces: `recordSynthesisEgress(db: Database, args: { readonly briefKind: string;
  readonly model: string; readonly remote: boolean; readonly now: number }): void`

> `remote` is REQUIRED and the local/remote rule is enforced **inside** the appender — a
> `remote: false` call appends nothing. This follows `sync-egress.ts:51`, which puts its
> `LOCAL_ONLY_SYNC_SERVICES` check inside the appender "so BOTH appenders enforce the rule
> identically instead of each needing its own copy." Task 4 must pass a value **derived from the
> resolved provider**, never a literal — see Task 4's ordering block.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/egress/synthesis-egress.test.ts
import { describe, expect, test } from "bun:test";
import { THIS_BINARY_COVERAGE } from "./egress-coverage.ts";

describe("model coverage", () => {
  test("model is raised to per-call now that brief synthesis appends", () => {
    expect(THIS_BINARY_COVERAGE.model).toBe("per-call");
  });
});
```

Plus a row-shape test following `sync-egress.test.ts`'s existing in-memory-DB pattern (read it and
mirror its `beforeEach`/`afterEach` — it opens a real `bun:sqlite` DB, per the project's
no-mocks-at-the-DB-layer rule), asserting a `recordSynthesisEgress` call writes exactly one row with
`source_type = 'model'` and `result_status = 'authorized'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/egress/synthesis-egress.test.ts`
Expected: FAIL — `model` is `"none"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway/src/egress/synthesis-egress.ts
import type { Database } from "bun:sqlite";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * The `model` class appender. `"model"` was already a FROZEN `EGRESS_SOURCE_TYPES`
 * member reserved for exactly this ("inference + embeddings, local or remote");
 * W6-A0 is the "later phase" its docstring anticipated. Do not add a source type.
 *
 * Called ONLY for a non-local provider. A local generate makes no outbound
 * request, so ledgering it would over-claim egress the same way an unfiltered
 * `LOCAL_ONLY_SYNC_SERVICES` did before it was excluded.
 */
export function recordSynthesisEgress(
  db: Database,
  args: { readonly briefKind: string; readonly model: string; readonly now: number },
): void {
  appendEgressEntry(db, {
    timestamp: args.now,
    sourceType: "model",
    sourceId: args.model,
    destination: "model",
    method: `agents.${args.briefKind}.synthesis`,
    payloadSummary: redactEgressSummary({ briefKind: args.briefKind, model: args.model }),
    hitlStatus: "not_required",
    resultStatus: "authorized",
  });
}
```

In `egress-coverage.ts`, set `model: "per-call"` and extend the `THIS_BINARY_COVERAGE` docstring:

```text
 * `model` is `per-call`, RAISED FROM `none`, and covers LESS than its name — read it as narrowly as
 * `mcp` and `http`. It is per-call over exactly one thing: a built-in agent brief synthesized by a
 * NON-LOCAL provider (`egress/synthesis-egress.ts`, called only from
 * `agents/_lib/synthesis-llm.ts` under `[agents] synthesis = "any"`). It is NOT "all inference".
 * EMBEDDINGS APPEND NOTHING: `PROSE_HEAVY_TYPES` routes to OpenAI's 1536-dim table when a key is
 * set, and that path has no appender — so a zero `model` count does NOT mean no vector left the
 * machine. Under `synthesis = "off"` or `"local"` this class emits nothing BY CONSTRUCTION, not by
 * observation. Raising this entry further requires landing the embedding appender first.
```

In `packages/cli/src/commands/prove.ts`, add to `COVERAGE_CLASS_LABELS` (hand-maintained mirror —
the CLI cannot import the gateway module):

```ts
  // NOT "model calls". Covers remote-provider brief synthesis only; embeddings append nothing,
  // so a zero here is not a claim that no vector left the machine.
  model: "remotely-synthesized agent briefs",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/egress/synthesis-egress.test.ts packages/cli/src/commands/prove-format.test.ts`
Expected: PASS. If `prove-format.test.ts` asserts a label count, update it in this commit.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/egress/synthesis-egress.ts packages/gateway/src/egress/synthesis-egress.test.ts packages/gateway/src/egress/egress-coverage.ts packages/cli/src/commands/prove.ts
git commit -m "feat(egress): land the model-class appender and raise its coverage to per-call"
```

---

### Task 4: Provider resolution, egress ordering, and timeout

**Files:**

- Create: `packages/gateway/src/agents/_lib/synthesis-llm.ts`
- Test: `packages/gateway/src/agents/_lib/synthesis-llm.test.ts`

**Interfaces:**

- Consumes: `NimbusAgentsToml` (Task 1), `recordSynthesisEgress` (Task 3), `LlmRouter`
  (`llm/router.ts`).
- Produces: `buildSynthesisRunner(deps: SynthesisLlmDeps): SynthesisRunner | undefined` —
  `undefined` means "render deterministically", a normal outcome, not an error.

```ts
export type SynthesisAttempt =
  | { ok: true; markdown: string; model: string; remote: boolean }
  | {
      ok: false;
      reason: "no_eligible_provider" | "timeout" | "egress_append_failed" | "provider_error";
      detail?: string;
    };

export type SynthesisRunner = { run: (prompt: string) => Promise<SynthesisAttempt> };
```

> **Why not the existing `SynthesizerLlm`** (`generateMarkdown: (p) => Promise<string | null>`):
> Task 5's `SynthesisProvenance` must distinguish `no_eligible_provider` from `timeout` from
> `egress_append_failed`, and a bare `null` provably cannot carry which. `contract_violation` is
> **not** in this union — that verdict belongs to Task 5, after the markdown exists.
>
> This renames `AgentsRpcContext.llm` → `AgentsRpcContext.runner` and
> `EmitBriefWithSynthesisOpts.llm` → `.runner`, a mechanical change across the ~10 forwarding sites
> in `agents-rpc.ts` (`:294,305,315,330,449,490,559,639,699,842`). It is safe precisely because that
> field is `undefined` at every production call site today — there is no live behaviour to regress.
> Do the rename in Task 5's commit, where the consumer changes too.

```ts
export type SynthesisLlmDeps = {
  readonly config: NimbusAgentsToml;
  readonly router: LlmRouter;
  readonly db: Database;
  readonly briefKind: string;
  readonly now: () => number;
};
```

Dependency injection, not `mock.module` — the combined CLI/gateway runs on CI Linux leak
`mock.module` state between files, and this repo has been bitten by it.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/agents/_lib/synthesis-llm.test.ts
import { describe, expect, test } from "bun:test";
import { buildSynthesisRunner } from "./synthesis-llm.ts";

// Stand-ins; shape only. `resolve` reports what the router would pick.
const localProvider = { providerId: "ollama", modelName: "llama3.2", isLocal: true };
const remoteProvider = { providerId: "remote", modelName: "gpt-4o", isLocal: false };

function fakeRouter(p: typeof localProvider | undefined, gen = async () => "out") {
  return { resolveForSynthesis: async () => p, generateMarkdown: gen };
}

describe("buildSynthesisRunner", () => {
  test("off yields undefined regardless of provider", () => {
    const runner = buildSynthesisRunner({
      config: { synthesis: "off", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider), db: fakeDb(), briefKind: "why", now: () => 1,
    });
    expect(runner).toBeUndefined();
  });

  test("local REFUSES a remote provider — prefersLocal() is only a preference", async () => {
    const rows = fakeDb();
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider), db: rows, briefKind: "why", now: () => 1,
    });
    expect((await runner?.run("p"))?.ok).toBe(false);
    expect(rows.count()).toBe(0); // refused, and nothing ledgered
  });

  test("any appends exactly one model row BEFORE generating", async () => {
    const order: string[] = [];
    const rows = fakeDb(() => order.push("append"));
    const runner = buildSynthesisRunner({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => { order.push("generate"); return "out"; }),
      db: rows, briefKind: "why", now: () => 1,
    });
    await runner?.run("p");
    expect(order).toEqual(["append", "generate"]);
    expect(rows.count()).toBe(1);
  });

  test("a LOCAL provider under any appends nothing", async () => {
    const rows = fakeDb();
    const runner = buildSynthesisRunner({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider), db: rows, briefKind: "why", now: () => 1,
    });
    await runner?.run("p");
    expect(rows.count()).toBe(0);
  });

  test("an append failure prevents the generate call entirely", async () => {
    let generated = false;
    const rows = fakeDb(() => { throw new Error("ledger down"); });
    const runner = buildSynthesisRunner({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => { generated = true; return "out"; }),
      db: rows, briefKind: "why", now: () => 1,
    });
    expect((await runner?.run("p"))?.ok).toBe(false);
    expect(generated).toBe(false);
  });

  test("a hung provider resolves null at the timeout instead of hanging", async () => {
    const runner = buildSynthesisRunner({
      config: { synthesis: "local", synthesisTimeoutMs: 20 },
      router: fakeRouter(localProvider, () => new Promise<string>(() => {})),
      db: fakeDb(), briefKind: "why", now: () => 1,
    });
    expect((await runner?.run("p"))?.ok).toBe(false);
  });
});
```

Write `fakeDb()` in the test file as a tiny counter object implementing only what
`recordSynthesisEgress` touches, with an optional hook to throw.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/synthesis-llm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Order inside `run(prompt)` is load-bearing and must be exactly:

1. Resolve the provider (**per call — never cache**; the router already probes availability every
   `selectProvider`, `llm/router.ts:103`). Derive `remote` from the resolved provider here.
2. No provider → `{ ok: false, reason: "no_eligible_provider" }`.
3. `remote === true` **and** mode is `"local"` → `{ ok: false, reason: "no_eligible_provider" }`.
   A refusal, not an error: this is the normal path on a machine with no local model.
4. Mode is `"any"` → **call `recordSynthesisEgress` UNCONDITIONALLY**, passing the derived
   `remote`. If it throws → `{ ok: false, reason: "egress_append_failed", detail }` **without
   generating** — fail-closed.
5. Race the provider call against `synthesisTimeoutMs`; on timeout →
   `{ ok: false, reason: "timeout" }`.
6. Otherwise → `{ ok: true, markdown, model, remote }`.

> **Step 4 says UNCONDITIONALLY for a reason — do not "optimise" it into the non-local branch.**
> `recordSynthesisEgress` enforces the local/remote rule internally and appends nothing when
> `remote` is `false` (Task 3). Calling it only inside a non-local branch, or passing a literal
> `remote: true`, makes that internal guard **inert** and silently returns enforcement to the call
> site — which is exactly the weakness Task 3's review closed. Pass the derived value and let the
> appender decide. A test must pin this: under `"any"` with a LOCAL provider resolved, the runner
> still succeeds and the ledger still gains zero rows.

**On the append and database locking:** use the plain `recordSynthesisEgress` call. Do **not** add a
bespoke retry or wrap it in a transaction — it must behave exactly as the three existing appenders
(`agent-brief-egress.ts`, `sync-egress.ts`, and the executor's) do under contention, and a
divergent busy-handling policy in one appender is a worse outcome than the shared one. No
transaction is open at this point: `buildBrief()` has already resolved before `synthesize` is
called (`emit-brief.ts:58-59`), so the brief's own reads are complete. A `SQLITE_BUSY` from a
concurrent writer therefore surfaces as `reason: "egress_append_failed"` with `detail`, which is
the observable outcome the plan wants.

Add a `resolveForSynthesis()` method to `LlmRouter` that returns the selected provider plus an
`isLocal` flag derived from the existing `LOCAL_PROVIDER_IDS`, rather than duplicating the priority
walk here. If an air-gap no-remote-fallback path already exists (`llm/router.ts:148`), reuse it
instead of adding a parallel mechanism.

**Known limitation, deliberately deferred — a timed-out generation is NOT cancelled.** Verified:
`LlmGenerateOptions` (`llm/types.ts:14-22`) has no `signal` field. The only `AbortSignal` in the
provider interface is on the optional `pullModel` (`:46`), not `generate` (`:43`). So the race here
abandons the promise; the underlying request keeps running to completion — local Ollama CPU/GPU
under `"local"`, and **billable tokens** under `"any"`.

Deferred rather than fixed because closing it means widening a shared type consumed by every
provider implementation and by the `nimbus ask` path, which is outside A0's blast radius and would
make this task the largest in the plan. Record it as a follow-up. Two things bound the cost
meanwhile: the default mode is `"local"`, where the waste is local compute only; and an abandoned
remote call still has its egress row, appended before the call, so **the ledger stays honest either
way** — the ledger's claim is that the request was authorized and sent, which remains true.

Do **not** paper over this by shortening the timeout. A short timeout increases the number of
abandoned-but-still-running generations rather than reducing it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/agents/_lib/synthesis-llm.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/synthesis-llm.ts packages/gateway/src/agents/_lib/synthesis-llm.test.ts packages/gateway/src/llm/router.ts
git commit -m "feat(agents): resolve synthesis providers per call, ledger remote ones, bound the wait"
```

---

### Task 5: Outcome plumbing, contract enforcement, footers

**Files:**

- Modify: `packages/gateway/src/agents/_lib/synthesize.ts:151-173`
- Modify: `packages/gateway/src/agents/_lib/emit-brief.ts:35-71`
- Test: `packages/gateway/src/agents/_lib/synthesize.test.ts` (extend)

**Interfaces:**

- Consumes: `contractViolations` (Task 2).
- Produces:

```ts
export type SynthesisProvenance =
  | { attempted: false; reason: "disabled" | "no_eligible_provider" }
  | { attempted: true; used: true; model: string; remote: boolean }
  | {
      attempted: true; used: false;
      reason:
        | "timeout"
        | "contract_violation"
        | "egress_append_failed"
        | "provider_error";
      missingPhrases?: string[];
      /**
       * Error text for `egress_append_failed`, so a transient SQLite busy/locked condition is
       * distinguishable from a model failure without a debug build. The three `reason` values
       * already separate ledger / model / contract failures; this adds the WHY for the ledger arm.
       * Redact before populating — it is emitted on a notification.
       */
      detail?: string;
    };

export type SynthesisOutcome = { markdown: string; provenance: SynthesisProvenance };
export async function synthesize(brief: SynthInput, opts?: SynthesizeOpts): Promise<SynthesisOutcome>;
```

`synthesize` returning an object instead of a string is a breaking signature change with exactly one
production caller (`emit-brief.ts:59`) plus tests. Update them in this commit.

- [ ] **Step 1: Write the failing test**

```ts
test("a contract-violating synthesis is discarded for the deterministic render", async () => {
  const brief = twoNullLaneBrief();
  const out = await synthesize(brief, {
    llm: { generateMarkdown: async () => "## PRs authored\n\n- 4 PRs\n\n## PRs reviewed\n\n- 2" },
  });
  expect(out.markdown).toContain("could not be computed");
  expect(out.provenance).toMatchObject({ attempted: true, used: false, reason: "contract_violation" });
});

test("EVERY fallback path carries the deterministic footer", async () => {
  // synthesize.ts:168 and :171 previously returned unfootered markdown while :153 did not.
  for (const llm of [
    { generateMarkdown: async () => null },
    { generateMarkdown: async () => { throw new Error("boom"); } },
  ]) {
    const out = await synthesize(twoNullLaneBrief(), { llm });
    expect(out.markdown).toContain("Rendered deterministically");
  }
});

test("briefReady carries the synthesis provenance", async () => {
  const seen: Array<{ method: string; params: unknown }> = [];
  await emitBriefWithSynthesis({
    sessionId: "s1", briefReadyMethod: "why.briefReady", briefErrorMethod: "why.briefError",
    notify: (method, params) => seen.push({ method, params }),
    buildBrief: async () => twoNullLaneBrief(),
  });
  await Bun.sleep(10); // fire-and-forget
  expect((seen[0]?.params as { synthesis?: unknown }).synthesis).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/synthesize.test.ts`
Expected: FAIL — `out.markdown` undefined (`synthesize` still returns a string).

- [ ] **Step 3: Write minimal implementation**

Rewrite `synthesize`'s tail so that: an LLM-absent path returns
`{ markdown: withDeterministicFooter(deterministic), provenance: { attempted: false, reason: "disabled" } }`;
a `null`/empty/throwing result returns the **footered** deterministic render; and a non-empty result
is passed through `contractViolations(brief, out)` — non-empty violations discard it with
`reason: "contract_violation"` and `missingPhrases`. A used synthesis gets the §2.5 provenance footer
naming model and locality, not `DETERMINISTIC_FOOTER`.

In `emit-brief.ts`, destructure the outcome and add `synthesis` to the `briefReady` payload:

```ts
const { markdown, provenance } = await synthesize(brief, opts.llm === undefined ? {} : { llm: opts.llm });
opts.notify(opts.briefReadyMethod, {
  sessionId: opts.sessionId,
  brief: markdown,
  findings: brief,
  synthesis: provenance,
});
```

- [ ] **Step 4: Run the whole agents suite**

Run: `bun test packages/gateway/src/agents/`
Expected: PASS. Existing tests asserting `synthesize` returns a string must be updated here.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/synthesize.ts packages/gateway/src/agents/_lib/emit-brief.ts packages/gateway/src/agents/_lib/synthesize.test.ts
git commit -m "feat(agents): enforce the brief contract and report synthesis provenance"
```

---

### Task 6: Production wiring at both call sites

**Files:**

- Modify: `packages/gateway/src/ipc/server/dispatchers.ts:133`
- Modify: `packages/gateway/src/agent-runs/agent-http-invoke.ts:98`
- Test: `packages/gateway/src/agent-runs/agent-http-invoke.test.ts` (extend)

This is the task that makes everything above execute. Until it lands, the work is inert — which is
the precise defect this sub-project exists to correct, so do not skip its test.

**Interfaces:**

- Consumes: `buildSynthesisRunner` (Task 4).
- Produces: nothing new; both callers gain an `llm` field on the `dispatchAgentsRpc` context.

- [ ] **Step 1: Write the failing test**

```ts
test("HTTP and socket briefs remain identical under every synthesis mode", async () => {
  for (const mode of ["off", "local", "any"] as const) {
    const viaHttp = await briefViaHttp("agents.why", { ref: "x" }, mode);
    const viaSocket = await briefViaSocket("agents.why", { ref: "x" }, mode);
    expect(viaHttp).toEqual(viaSocket);
  }
});

test("a synthesis-eligible context is actually supplied — not omitted as before", async () => {
  const ctx = await capturedAgentsRpcContext({ synthesis: "local" });
  expect(ctx.llm).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agent-runs/agent-http-invoke.test.ts`
Expected: FAIL — `ctx.llm` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

Both sites build the context field from the **same** factory so the documented HTTP ≡ socket
equivalence holds by construction rather than by comment:

```ts
...(buildSynthesisRunner({
  config: cfg.agents, router, db, briefKind: briefKindFor(method), now: () => Date.now(),
}) is undefined ? {} : { llm: <that value> }),
```

Delete the now-false comment at `agent-http-invoke.ts:75` ("omitting `llm`, which that path also
omits") and replace it with one stating both paths build it from the same factory.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/agent-runs/ packages/gateway/src/ipc/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/agent-runs/agent-http-invoke.ts packages/gateway/src/agent-runs/agent-http-invoke.test.ts
git commit -m "feat(agents): supply the synthesis LLM at both production dispatchers"
```

---

### Task 7: Correct the claims this work falsifies

**Files:**

- Modify: `docs/roadmap.md` (the four Wave 6 rows, per spec §1)
- Modify: any file asserting briefs never use an LLM — find them, do not assume the list

- [ ] **Step 1: Find every affected claim**

**This task falsifies claims in TWO independent vocabularies, and one grep cannot find both.** Run
both sweeps.

Sweep A — the "briefs never use an LLM" claim:

```bash
grep -rn "do not use an LLM\|does not use an LLM\|no LLM" --include=*.ts --include=*.md . | grep -v node_modules
```

Each hit is either still true (the deterministic path) or now false (an unconditional claim). Fix
the false ones. `synthesize.ts`'s `DETERMINISTIC_FOOTER` text stays — it now describes one path
rather than all of them, which is what Task 5 made true.

Known stale sites already identified by the Task 3 reviews — verify each was corrected, and treat
this list as a floor rather than the whole set:

- `docs/SECURITY-INVARIANTS.md` — the I29 section, **the whole section**, not just the lines named.
  Two separate review rounds each found one stale enumeration in it.
- `docs/architecture.md:1663` · `packages/gateway/src/egress/egress-source-type.ts:19`
  ("`sync`, `model`, `peer` arrive in later phases" — false for two of the three)
- `.claude/commands/nimbus-egress.md:37` (three raises out of date)
- `CLAUDE.md`'s I29 entry — enumerates `sync` in detail but never the full vector; incomplete
  rather than contradictory, so match the precedent set for `sync` instead of rewriting it.
- `docs/CHANGELOG.md` — needs an entry; the raise changes `nimbus prove`'s printed scope line,
  which is user-visible.

Sweep B — the egress **coverage-class** claim, which Sweep A cannot match because it shares no
wording with it:

```bash
grep -rn "non-\`none\`\|still \`none\`\|FOUR non\|session\`, \`model\`, \`peer\`" --include=*.md docs/
grep -rn "model" --include=*.md docs/SECURITY-INVARIANTS.md docs/architecture.md | grep -i "none\|coverage"
```

> **Why this sweep exists.** The Task 3 review found `docs/SECURITY-INVARIANTS.md:610`
> ("records exactly FOUR non-`none` classes … with `session`, `model` and `peer` still `none`") and
> `docs/architecture.md:1663` ("every other class (`session`, `model`, `peer`) is `none`") both
> asserting the opposite of what Task 3 shipped. **Sweep A matches neither.** Task 3's fix round
> corrected those two lines, so verify they are right rather than assuming they are wrong — but run
> the sweep anyway: it is the only thing standing between this PR and a shipped false claim about
> what the ledger covers, and the count of non-`none` classes is asserted in prose in more than one
> place. Any hit still describing four classes, or still listing `model` as `none`, is false.

- [ ] **Step 2: Correct the four Wave 6 roadmap rows**

Per spec §1: the devil's-advocate "five-line prompt change" (two prompt sites, not one); the
`[profile.<name>.persona]` shape (profiles are whole-file swaps); `tool_caution` affecting HITL
(prohibited by Non-Negotiable #2 / I2); and "the structured index already handles negation natively"
(true only of raw SQL — there is no predicate language). Add the A0/A1/A2/W6-B decomposition.

- [ ] **Step 3: Update the S1 "Remaining" row**

`docs/roadmap.md:920` lists answer-quality surfaces as the last open S1 item. Record that A0 has
shipped and A1/A2/W6-B remain, following the "built narrower than this row described" convention the
`pre-mortem` and `negotiate` entries established.

- [ ] **Step 4: Run the docs gates**

Run: `bun run preflight:fast`
Expected: PASS, including `audit:doc-refs` and the CHANGELOG/roadmap drift checks.

- [ ] **Step 5: Add the CHANGELOG entry and commit**

```bash
git add docs/roadmap.md docs/CHANGELOG.md
git commit -m "docs: correct the four Wave 6 rows and the briefs-never-use-an-LLM claim"
```

---

### Task 8: Full preflight and PR

- [ ] **Step 1: Install and run the full gate set**

The worktree has not had `bun install` run in it yet.

```bash
bun install
bun run preflight
```

- [ ] **Step 2: Docker-verify the Linux-authoritative gates**

`audit:coverage-floor` is CI-Linux-authoritative and six new source files land here.

```bash
bun run verify:docker
```

- [ ] **Step 3: Open the PR**

The PR **title** carries the conventional-commit type — it is what release-please parses and what
becomes the squash commit. Suggested: `feat(agents): make built-in brief synthesis executable`.
Put the reasoning in the **description**; local commit messages are discarded on merge. Check the
body for unbalanced parentheses — an unbalanced `(` in a PR body drops the commit from the
generated changelog, twice already in this repo.

---

## Self-Review

**Spec coverage:** §2.1 → Task 1. §2.2 → Task 4. §2.3/2.3.1/2.3.2/2.3.3 → Task 3. §2.4 → Task 2
(guard) + Task 5 (enforcement). §2.5 → Task 5 (footers). §2.6 → Task 1 (config) + Task 4 (timeout).
§2.7 → Task 5 (provenance on the notification). §3 out-of-scope items are absent from every task.
§4's test table is distributed across Tasks 2–6. §5's risks are addressed by Task 5's provenance and
Task 2's red-prove step.

**Known gap, deliberate:** `requiredPhrases` returns `[]` for thirteen of fourteen brief kinds in
Task 2. All seven of `negotiate`'s lane disclaimers are enforced; the confidence ceilings and
truncation counts named in spec §2.4 for `glossary` / `decisions` / `premortem` need their exact
strings read out of `render.ts` before they can be pinned, and inventing them here would be the
placeholder this plan format forbids. **Task 2 Step 3's `assertNeverBrief` arm makes this
visible rather than silent**, and widening it is a follow-up commit, not a hidden omission.

**Known limitation, deliberate:** a timed-out generation is abandoned, not cancelled —
`LlmGenerateOptions` carries no `AbortSignal`. Recorded in full at Task 4 Step 3.

**Type consistency:** `SynthesisProvenance` / `SynthesisOutcome` (Task 5) are consumed only by
`emit-brief.ts` in the same task. `buildSynthesisRunner` (Task 4) returns `SynthesisRunner | undefined`,
matching the renamed `EmitBriefWithSynthesisOpts.runner?` (Task 4's rename note). `recordSynthesisEgress` (Task 3) is
called only from Task 4. `contractViolations` (Task 2) is called only from Task 5.
