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
| `packages/gateway/src/agents/_lib/synthesis-llm.ts` | Builds a `SynthesizerLlm` from config + `LlmRouter`. Owns provider resolution, the egress append, and the timeout. |
| `packages/gateway/src/agents/_lib/synthesis-llm.test.ts` | Tests for the above. |

**Modify**

| File | Change |
| --- | --- |
| `packages/gateway/src/config/nimbus-toml.ts` | New `[agents]` section, mirroring `[ownership]` at `:1710`. |
| `packages/gateway/src/agents/_lib/synthesize.ts` | Return a `SynthesisOutcome` instead of a bare string; apply the contract guard; footer every fallback. |
| `packages/gateway/src/agents/_lib/emit-brief.ts` | Carry `synthesis` provenance on the `briefReady` notification. |
| `packages/gateway/src/egress/egress-coverage.ts` | `model: "none"` → `"per-call"`, with the narrowing recorded in the docstring. |
| `packages/cli/src/commands/prove.ts` | `COVERAGE_CLASS_LABELS` gains `model`. Hand-maintained mirror — required, not optional. |
| `packages/gateway/src/ipc/server/dispatchers.ts:133` | Pass `llm` from the shared factory. |
| `packages/gateway/src/agent-runs/agent-http-invoke.ts:98` | Pass `llm` from the same factory. |
| `docs/roadmap.md` | Correct the four Wave 6 rows. |

---

### Task 1: `[agents]` configuration

**Files:**
- Modify: `packages/gateway/src/config/nimbus-toml.ts` (follow the `[ownership]` block at `:1710`)
- Test: `packages/gateway/src/config/nimbus-toml-agents.test.ts` (create)

**Interfaces:**
- Consumes: `forEachSectionEntry`, `parseIntDec` from the existing TOML primitives.
- Produces: `type NimbusAgentsToml = { synthesis: "off" | "local" | "any"; synthesisTimeoutMs: number }`,
  `DEFAULT_NIMBUS_AGENTS_TOML`, and an `agents` field on the parsed config object.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/config/nimbus-toml-agents.test.ts
import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_AGENTS_TOML, parseNimbusToml } from "./nimbus-toml.ts";

describe("[agents]", () => {
  test("defaults to local synthesis with a 20s timeout", () => {
    expect(DEFAULT_NIMBUS_AGENTS_TOML.synthesis).toBe("local");
    expect(DEFAULT_NIMBUS_AGENTS_TOML.synthesisTimeoutMs).toBe(20000);
  });

  test("parses all three modes", () => {
    for (const mode of ["off", "local", "any"] as const) {
      const cfg = parseNimbusToml(`[agents]\nsynthesis = "${mode}"\n`);
      expect(cfg.agents.synthesis).toBe(mode);
    }
  });

  test("an unrecognised mode falls back to the safe default, never to any", () => {
    const cfg = parseNimbusToml(`[agents]\nsynthesis = "remote"\n`);
    expect(cfg.agents.synthesis).toBe("local");
  });

  test("parses synthesis_timeout_ms", () => {
    const cfg = parseNimbusToml(`[agents]\nsynthesis_timeout_ms = 4500\n`);
    expect(cfg.agents.synthesisTimeoutMs).toBe(4500);
  });

  test("a non-numeric timeout falls back to the default rather than 0", () => {
    const cfg = parseNimbusToml(`[agents]\nsynthesis_timeout_ms = "soon"\n`);
    expect(cfg.agents.synthesisTimeoutMs).toBe(20000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml-agents.test.ts`
Expected: FAIL — `DEFAULT_NIMBUS_AGENTS_TOML` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `nimbus-toml.ts`, mirroring the `[ownership]` block's structure:

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

Register it alongside the other sections:

```ts
forEachSectionEntry(raw, "[agents]", (key, valRaw) => applyNimbusAgentsKey(out.agents, key, valRaw));
```

and add `agents: { ...DEFAULT_NIMBUS_AGENTS_TOML }` to the parsed-config initializer.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/config/nimbus-toml-agents.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml-agents.test.ts
git commit -m "feat(config): add [agents] synthesis mode and timeout"
```

---

### Task 2: The contract guard

**Files:**
- Create: `packages/gateway/src/agents/_lib/brief-contract.ts`
- Test: `packages/gateway/src/agents/_lib/brief-contract.test.ts`

**Interfaces:**
- Consumes: the `SynthInput` union and `assertNeverBrief` from `synthesize.ts` (export
  `assertNeverBrief` if it is currently module-private).
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
import { contractViolations } from "./brief-contract.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";

// Two null lanes: both must keep their disclaimer.
function twoNullLaneBrief(): NegotiateBrief {
  return {
    kind: "negotiate",
    authoredPrs: null,
    reviewedPrs: null,
  } as unknown as NegotiateBrief;
}

describe("contractViolations", () => {
  test("accepts markdown that preserves every disclaimer", () => {
    const md = "## PRs authored\n\n_could not be computed_\n\n## PRs reviewed\n\n_could not be computed_";
    expect(contractViolations(twoNullLaneBrief(), md)).toEqual([]);
  });

  test("accepts a REFORMATTED disclaimer — this is what keeps the guard usable", () => {
    const md = "## PRs authored\n\n*could not be computed*\n\n## PRs reviewed\n\nCould Not Be Computed";
    expect(contractViolations(twoNullLaneBrief(), md)).toEqual([]);
  });

  test("rejects when ONE of two identical disclaimers is dropped", () => {
    // The exact failure a document-wide substring check passes.
    const md = "## PRs authored\n\n_could not be computed_\n\n## PRs reviewed\n\n- 12 review(s)";
    const v = contractViolations(twoNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("PRs reviewed");
  });

  test("rejects a dropped heading rather than skipping the section", () => {
    const md = "## PRs authored\n\n_could not be computed_";
    const v = contractViolations(twoNullLaneBrief(), md);
    expect(v.length).toBe(1);
    expect(v[0]).toContain("PRs reviewed");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/brief-contract.test.ts`
Expected: FAIL — module `./brief-contract.ts` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway/src/agents/_lib/brief-contract.ts
import type { SynthInput } from "./synthesize.ts";
import { assertNeverBrief } from "./synthesize.ts";

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

/** Body text under `## <heading>`, up to the next heading of any level. */
function sectionBody(markdown: string, heading: string): string | undefined {
  const lines = markdown.split("\n");
  const target = normalize(heading);
  let i = lines.findIndex((l) => l.startsWith("#") && normalize(l.replace(/^#+/, "")) === target);
  if (i < 0) return undefined;
  const body: string[] = [];
  for (i += 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("#")) break;
    body.push(line);
  }
  return body.join("\n");
}

export function requiredPhrases(brief: SynthInput): readonly RequiredPhrase[] {
  if (brief.kind === "negotiate") {
    const out: RequiredPhrase[] = [];
    if (brief.authoredPrs === null) out.push({ heading: "PRs authored", phrase: NOT_COMPUTED });
    if (brief.reviewedPrs === null) out.push({ heading: "PRs reviewed", phrase: NOT_COMPUTED });
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
Expected: PASS (4 tests)

- [ ] **Step 5: Red-prove the guard by reverting it**

Temporarily change `sectionBody` to return the whole `markdown` instead of the scoped body. Re-run.
Expected: the "rejects when ONE of two identical disclaimers is dropped" test FAILS. Restore the
code. A guard that has never been observed failing is not known to work — this repo has shipped
tests that could not fail.

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
  readonly model: string; readonly now: number }): void`

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

```
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
  (`llm/router.ts`), `SynthesizerLlm` (`synthesize.ts`).
- Produces: `buildSynthesisLlm(deps: SynthesisLlmDeps): SynthesizerLlm | undefined` — `undefined`
  means "render deterministically", which is a normal outcome, not an error.

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
import { buildSynthesisLlm } from "./synthesis-llm.ts";

// Stand-ins; shape only. `resolve` reports what the router would pick.
const localProvider = { providerId: "ollama", modelName: "llama3.2", isLocal: true };
const remoteProvider = { providerId: "remote", modelName: "gpt-4o", isLocal: false };

function fakeRouter(p: typeof localProvider | undefined, gen = async () => "out") {
  return { resolveForSynthesis: async () => p, generateMarkdown: gen };
}

describe("buildSynthesisLlm", () => {
  test("off yields undefined regardless of provider", () => {
    const llm = buildSynthesisLlm({
      config: { synthesis: "off", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider), db: fakeDb(), briefKind: "why", now: () => 1,
    });
    expect(llm).toBeUndefined();
  });

  test("local REFUSES a remote provider — prefersLocal() is only a preference", async () => {
    const rows = fakeDb();
    const llm = buildSynthesisLlm({
      config: { synthesis: "local", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider), db: rows, briefKind: "why", now: () => 1,
    });
    expect(await llm?.generateMarkdown("p")).toBeNull();
    expect(rows.count()).toBe(0); // refused, and nothing ledgered
  });

  test("any appends exactly one model row BEFORE generating", async () => {
    const order: string[] = [];
    const rows = fakeDb(() => order.push("append"));
    const llm = buildSynthesisLlm({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => { order.push("generate"); return "out"; }),
      db: rows, briefKind: "why", now: () => 1,
    });
    await llm?.generateMarkdown("p");
    expect(order).toEqual(["append", "generate"]);
    expect(rows.count()).toBe(1);
  });

  test("a LOCAL provider under any appends nothing", async () => {
    const rows = fakeDb();
    const llm = buildSynthesisLlm({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
      router: fakeRouter(localProvider), db: rows, briefKind: "why", now: () => 1,
    });
    await llm?.generateMarkdown("p");
    expect(rows.count()).toBe(0);
  });

  test("an append failure prevents the generate call entirely", async () => {
    let generated = false;
    const rows = fakeDb(() => { throw new Error("ledger down"); });
    const llm = buildSynthesisLlm({
      config: { synthesis: "any", synthesisTimeoutMs: 20000 },
      router: fakeRouter(remoteProvider, async () => { generated = true; return "out"; }),
      db: rows, briefKind: "why", now: () => 1,
    });
    expect(await llm?.generateMarkdown("p")).toBeNull();
    expect(generated).toBe(false);
  });

  test("a hung provider resolves null at the timeout instead of hanging", async () => {
    const llm = buildSynthesisLlm({
      config: { synthesis: "local", synthesisTimeoutMs: 20 },
      router: fakeRouter(localProvider, () => new Promise<string>(() => {})),
      db: fakeDb(), briefKind: "why", now: () => 1,
    });
    expect(await llm?.generateMarkdown("p")).toBeNull();
  });
});
```

Write `fakeDb()` in the test file as a tiny counter object implementing only what
`recordSynthesisEgress` touches, with an optional hook to throw.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/synthesis-llm.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Order inside `generateMarkdown` is load-bearing and must be exactly:

1. Resolve the provider (**per call — never cache**; the router already probes availability every
   `selectProvider`, `llm/router.ts:103`).
2. No provider → return `null`.
3. Provider is non-local **and** mode is `"local"` → return `null`. Refusal, not an error.
4. Provider is non-local and mode is `"any"` → `recordSynthesisEgress(...)`. **If it throws, return
   `null` without generating** — fail-closed.
5. Race `generateMarkdown` against `synthesisTimeoutMs`; on timeout return `null`.

Returning `null` is already the "no synthesis" signal `synthesize.ts:168` understands.

Add a `resolveForSynthesis()` method to `LlmRouter` that returns the selected provider plus an
`isLocal` flag derived from the existing `LOCAL_PROVIDER_IDS`, rather than duplicating the priority
walk here. If an air-gap no-remote-fallback path already exists (`llm/router.ts:148`), reuse it
instead of adding a parallel mechanism.

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
      reason: "timeout" | "contract_violation" | "egress_append_failed";
      missingPhrases?: string[];
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
- Consumes: `buildSynthesisLlm` (Task 4).
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
...(buildSynthesisLlm({
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

```bash
grep -rn "do not use an LLM\|does not use an LLM\|no LLM" --include=*.ts --include=*.md . | grep -v node_modules
```

Each hit is either still true (the deterministic path) or now false (an unconditional claim). Fix
the false ones. `synthesize.ts`'s `DETERMINISTIC_FOOTER` text stays — it now describes one path
rather than all of them, which is what Task 5 made true.

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
Task 2. Only `negotiate`'s lane disclaimers are enforced initially. The confidence ceilings and
truncation counts named in spec §2.4 for `glossary` / `decisions` / `premortem` need their exact
strings read out of `render.ts` before they can be pinned, and inventing them here would be the
placeholder this plan format forbids. **Task 2 Step 3's `assertNeverBrief` arm makes this
visible rather than silent**, and widening it is a follow-up commit, not a hidden omission.

**Type consistency:** `SynthesisProvenance` / `SynthesisOutcome` (Task 5) are consumed only by
`emit-brief.ts` in the same task. `buildSynthesisLlm` (Task 4) returns `SynthesizerLlm | undefined`,
matching `EmitBriefWithSynthesisOpts.llm?` at `emit-brief.ts:40`. `recordSynthesisEgress` (Task 3) is
called only from Task 4. `contractViolations` (Task 2) is called only from Task 5.
