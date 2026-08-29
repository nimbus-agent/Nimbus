# ChatOps Agent Intent Implementation Plan (PR 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@nimbus agent why file=src/auth.ts line=42` in a bound channel returns the same brief payload as `nimbus why`, with full `k=v` parity across all eleven permitted agents — and it works on a gateway with **no LLM configured**.

**Architecture:** A third intent in `IntentRouter`, ahead of the free-text `read` fallthrough. Params are **coerced, not validated**: `ipc/agents-rpc.ts`'s validators already take `unknown` and own every semantic rule, so the only gap between a `k=v` message and the IPC contract is that `k=v` yields strings. A per-agent field→primitive-kind map plus a surface-neutral parser closes it, and no bounds constant is ever copied. The invoker reaches agents only through `dispatchAgentsRpc`, exactly as the HTTP surface does.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:sqlite`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-29-chatops-agent-intent-design.md`](../specs/2026-08-29-chatops-agent-intent-design.md) §6–§7, §13.

**Depends on:** [PR 1's plan](./2026-08-29-chatops-egress-ledger.md) — **must be merged first.** This PR does *no* egress work; it consumes `posts.agentBrief`, already ledgered at the post.

## Global Constraints

- **No `any`.** `unknown` for external data. TypeScript strict.
- **Never copy a bounds constant.** `MAX_LIMIT`, `MAX_SINCE_MS`, `MAX_FILE_LEN` and friends stay module-private to `agents-rpc.ts`. If you find yourself writing a number that also appears there, stop.
- **Never reach an agent except through `dispatchAgentsRpc`.** Static rule D22(d) forbids importing an `agents/<name>.ts` emitter outside `ipc/agents-rpc.ts`.
- **The eleven permitted agents are DERIVED**, never hand-listed — from `AGENTS_RPC_HANDLERS` minus the exclusion set.
- **A coerced number must be `Number.isFinite`.** See Task 2 — this is load-bearing, not hygiene.
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Verify with `bun run preflight:fast`** after every code change; `bun run preflight` before the PR.
- Work on `dev/asaf/chatops-agent-intent`. Conventional-commit type goes in the **PR title**.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/ipc/agent-param-kinds.ts` | **Create** — per-agent field→kind map. Lives beside the validators it describes |
| `packages/gateway/src/agent-commands/parse-agent-command.ts` | **Create** — grammar + coercion. Surface-neutral; imports nothing from `chatops/` |
| `packages/gateway/src/ipc/agents-rpc.ts` | **Modify** — rename `HTTP_*` → `EXTERNAL_*` |
| `packages/gateway/src/ipc/server/client-kind.ts` | **Modify** — `ClientKind` gains `chatops` (not declarable) |
| `packages/gateway/src/egress/egress-bearing-kinds.ts` | **Modify** — `chatops: null`, with its own reason |
| `packages/gateway/src/agent-runs/agent-chatops-invoke.ts` | **Create** — the invoker; awaits `briefReady` |
| `packages/gateway/src/chatops/brief-truncate.ts` | **Create** — fits a brief to a platform cap, keeping reserved sections |
| `packages/gateway/src/chatops/types.ts` | **Modify** — `ParsedCommand` + `RefusalReason` members |
| `packages/gateway/src/chatops/command-parser.ts` | **Modify** — the `agent` arm |
| `packages/gateway/src/chatops/intent-router.ts` | **Modify** — the agent branch + mapped-identity gate |
| `packages/gateway/src/chatops/chatops-boot.ts` | **Modify** — `bindAgentInvoker` |
| `packages/gateway/src/gateway-main.ts` | **Modify** — wire the invoker |
| `scripts/structure-audit/check-agent-param-kinds.ts` | **Create** — the anti-drift audit (Task 10) |

---

## Task 1: The field→kind map

**Files:**
- Create: `packages/gateway/src/ipc/agent-param-kinds.ts`
- Create: `packages/gateway/src/ipc/agent-param-kinds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ParamKind = "string" | "number" | "boolean" | "stringArray"`, and
  `AGENT_PARAM_KINDS: Readonly<Record<string, Readonly<Record<string, ParamKind>>>>` keyed by agent
  name. Tasks 2 and 10 consume it.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { AGENT_PARAM_KINDS } from "./agent-param-kinds.ts";

describe("agent param kinds", () => {
  test("expert's entire declaration is two fields", () => {
    expect(AGENT_PARAM_KINDS["expert"]).toEqual({ topicOrFile: "string", limit: "number" });
  });

  test("minConfidence is a number — the float that has no isInteger guard upstream", () => {
    expect(AGENT_PARAM_KINDS["decisions"]?.["minConfidence"]).toBe("number");
  });

  test("namespaces is the only array field", () => {
    const arrays = Object.entries(AGENT_PARAM_KINDS).flatMap(([a, fields]) =>
      Object.entries(fields)
        .filter(([, k]) => k === "stringArray")
        .map(([f]) => `${a}.${f}`),
    );
    expect(arrays.every((x) => x.endsWith(".namespaces"))).toBe(true);
  });

  test("no boolean field is declared — repropose belongs to premortem, which is excluded", () => {
    const bools = Object.values(AGENT_PARAM_KINDS).flatMap((f) =>
      Object.values(f).filter((k) => k === "boolean"),
    );
    expect(bools).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ipc/agent-param-kinds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
/**
 * What PRIMITIVE each agent param is, and nothing else.
 *
 * This file exists because a `k=v` chat message yields STRINGS while some params are numbers or
 * arrays. It is a coercion table, NOT a validator: `ipc/agents-rpc.ts` still owns every bound,
 * every required/optional rule, every mutual exclusion (`ownership`'s `path` vs `service`), every
 * alias (`namespaces` beats `namespace`) and every `-32602` message. Nothing here duplicates any of
 * that, and no bounds constant appears in this file.
 *
 * It lives NEXT TO `agents-rpc.ts` on purpose: a param added to a validator is one line away from
 * the map that must learn about it, and `scripts/structure-audit/check-agent-param-kinds.ts` makes
 * a divergence a build failure rather than a review catch.
 *
 * Only the ELEVEN externally-permitted agents appear. `preflight`, `premortem`, `whyPeek` and
 * `negotiate` are excluded from every external surface, so declaring their params here would
 * advertise a grammar nothing serves — and `premortem` owns the only `boolean` field
 * (`repropose`), which is why `"boolean"` is in the type union but unused today.
 */
export type ParamKind = "string" | "number" | "boolean" | "stringArray";

export const AGENT_PARAM_KINDS: Readonly<Record<string, Readonly<Record<string, ParamKind>>>> =
  Object.freeze({
    expert: Object.freeze({ topicOrFile: "string", limit: "number" }),
    impact: Object.freeze({ fileOrPrUrl: "string", depth: "number", service: "string" }),
    catchup: Object.freeze({ sinceMs: "number", service: "string" }),
    ghost: Object.freeze({ file: "string", namespace: "string", namespaces: "stringArray" }),
    conflicts: Object.freeze({ file: "string", namespace: "string", namespaces: "stringArray" }),
    huddle: Object.freeze({ sinceMs: "number", namespace: "string", namespaces: "stringArray" }),
    janitor: Object.freeze({
      resourceRef: "string",
      idleDays: "number",
      cleanupAction: "string",
      allowGaps: "boolean",
    }),
    ownership: Object.freeze({ path: "string", service: "string" }),
    why: Object.freeze({ ref: "string", line: "number", prUrl: "string" }),
    glossary: Object.freeze({ term: "string", limit: "number" }),
    decisions: Object.freeze({
      sinceMs: "number",
      minConfidence: "number",
      service: "string",
      explain: "boolean",
      limit: "number",
    }),
  });
```

> **Implementer note:** verify each entry against the real validator in `agents-rpc.ts` before
> committing — read `requireJanitorParams` and `requireDecisionsParams` in particular, since
> `allowGaps` and `explain` are the two fields most likely to differ from the sketch above. Task 10's
> audit will catch a mismatch, but finding it here is cheaper.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc/agent-param-kinds.test.ts`
Expected: PASS. If the "no boolean" test fails, `janitor`/`decisions` genuinely have boolean fields —
update the test's claim and the file's doc comment together, and say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/agent-param-kinds.ts packages/gateway/src/ipc/agent-param-kinds.test.ts
git commit -m "feat(agents): declare the param primitive kinds for text surfaces"
```

---

## Task 2: The parser and coercion

**Files:**
- Create: `packages/gateway/src/agent-commands/parse-agent-command.ts`
- Create: `packages/gateway/src/agent-commands/parse-agent-command.test.ts`

**Interfaces:**
- Consumes: `AGENT_PARAM_KINDS`, `ParamKind` (Task 1).
- Produces:
  ```ts
  export type AgentCommand =
    | { readonly ok: true; readonly agent: string; readonly params: Record<string, unknown> }
    | { readonly ok: false; readonly detail: string };
  export function parseAgentCommand(
    text: string,
    permitted: ReadonlySet<string>,
  ): AgentCommand | null;   // null = "this is not an agent command"
  ```
  Task 7 consumes it.

**The NaN rule, and why it is load-bearing:** `Number("three")` is `NaN` and `typeof NaN === "number"`.
Four of the five numeric fields survive that because `limit`, `depth`, `sinceMs` and `line` carry
`!Number.isInteger(...)`. **`minConfidence` does not** — correctly, it is a float — so its check
`typeof !== "number" || < 0 || > 1` is entirely `false` for `NaN`, and `NaN` reaches
`DecisionsInput`. Downstream every `confidence >= NaN` is false, so the brief returns **zero
decisions with no error**. Guard with `Number.isFinite`, which also rejects `Infinity`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { parseAgentCommand } from "./parse-agent-command.ts";

const PERMITTED = new Set(["why", "expert", "decisions", "ghost"]);

describe("parseAgentCommand", () => {
  test("returns null for a non-agent message — the read fallthrough must still work", () => {
    expect(parseAgentCommand("why is checkout slow?", PERMITTED)).toBeNull();
    expect(parseAgentCommand("run deployment.rollback service=api", PERMITTED)).toBeNull();
  });

  test("parses agent + k=v and coerces per the declared kind", () => {
    expect(parseAgentCommand("agent why ref=src/auth.ts line=42", PERMITTED)).toEqual({
      ok: true,
      agent: "why",
      params: { ref: "src/auth.ts", line: 42 },
    });
  });

  test("splits a stringArray on commas", () => {
    expect(parseAgentCommand("agent ghost file=a.ts namespaces=team-a,team-b", PERMITTED)).toEqual({
      ok: true,
      agent: "ghost",
      params: { file: "a.ts", namespaces: ["team-a", "team-b"] },
    });
  });

  test("REJECTS a non-finite number — minConfidence would otherwise pass its validator", () => {
    const r = parseAgentCommand("agent decisions minConfidence=high", PERMITTED);
    expect(r).toEqual({ ok: false, detail: expect.stringContaining("minConfidence") });
  });

  test("rejects Infinity too, not just NaN", () => {
    expect(parseAgentCommand("agent decisions minConfidence=Infinity", PERMITTED)).toMatchObject({
      ok: false,
    });
  });

  test("refuses an agent outside the permitted set", () => {
    expect(parseAgentCommand("agent premortem epic=X", PERMITTED)).toEqual({
      ok: false,
      detail: expect.stringContaining("premortem"),
    });
  });

  test("refuses an undeclared param rather than passing it through", () => {
    expect(parseAgentCommand("agent why ref=a.ts bogus=1", PERMITTED)).toMatchObject({ ok: false });
  });

  test("refuses a bare `agent` with no name", () => {
    expect(parseAgentCommand("agent", PERMITTED)).toMatchObject({ ok: false });
  });

  test("strips chat decoration before parsing", () => {
    expect(parseAgentCommand("@nimbus agent why ref=“a.ts”", PERMITTED)).toEqual({
      ok: true,
      agent: "why",
      params: { ref: "a.ts" },
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/agent-commands/parse-agent-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { AGENT_PARAM_KINDS, type ParamKind } from "../ipc/agent-param-kinds.ts";
import { normalizeChatText } from "../chatops/command-parser.ts";

export type AgentCommand =
  | { readonly ok: true; readonly agent: string; readonly params: Record<string, unknown> }
  | { readonly ok: false; readonly detail: string };

const KV_RE = /^([A-Za-z][\w.-]*)=(.+)$/;

function coerce(raw: string, kind: ParamKind, field: string): unknown | { error: string } {
  switch (kind) {
    case "string":
      return raw;
    case "stringArray":
      return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      return { error: `${field} must be true or false` };
    }
    case "number": {
      const n = Number(raw);
      // Number.isFinite, NOT !Number.isNaN. `typeof NaN === "number"`, and `minConfidence`'s
      // validator (`typeof !== "number" || < 0 || > 1`) is entirely false for NaN — so NaN would
      // reach the agent and every `confidence >= NaN` comparison would be false, producing a brief
      // with zero decisions and no error. Infinity is rejected for the same class of reason.
      if (!Number.isFinite(n)) return { error: `${field} must be a finite number` };
      return n;
    }
  }
}

function isError(v: unknown): v is { error: string } {
  return typeof v === "object" && v !== null && "error" in v;
}

/**
 * `agent <name> [k=v ...]` -> the params `dispatchAgentsRpc` validates, or a refusal.
 *
 * `null` means "not an agent command" — the caller falls through to its existing behaviour. That
 * distinction matters: without the `agent` keyword, `@nimbus why is checkout slow?` would stop
 * being a question and become a malformed agent call.
 *
 * This function COERCES and never validates. It does not know a bound, a required field, or that
 * `ownership`'s `path` and `service` are mutually exclusive — `agents-rpc.ts` owns all of that and
 * its own `-32602` text is what the user should see, because it is the real message rather than a
 * mirrored one. Surface-neutral by design: no `chatops/` import beyond the shared text normalizer,
 * so a CLI or browser text surface can reuse it unchanged.
 */
export function parseAgentCommand(
  rawText: string,
  permitted: ReadonlySet<string>,
): AgentCommand | null {
  const text = normalizeChatText(rawText);
  if (!/^agent(\s|$)/i.test(text)) return null;

  const tokens = text.split(" ").slice(1).filter((t) => t.length > 0);
  const agent = tokens.shift();
  if (agent === undefined) return { ok: false, detail: "`agent` needs an agent name." };
  if (!permitted.has(agent)) return { ok: false, detail: `Unknown or unavailable agent '${agent}'.` };

  const kinds = AGENT_PARAM_KINDS[agent] ?? {};
  const params: Record<string, unknown> = {};
  for (const t of tokens) {
    const m = KV_RE.exec(t);
    if (m === null) return { ok: false, detail: `Bad argument '${t}' (use k=v).` };
    const field = m[1] as string;
    const value = (m[2] as string).replace(/^"(.*)"$/, "$1");
    const kind = kinds[field];
    if (kind === undefined) return { ok: false, detail: `'${agent}' has no parameter '${field}'.` };
    const coerced = coerce(value, kind, field);
    if (isError(coerced)) return { ok: false, detail: coerced.error };
    params[field] = coerced;
  }
  return { ok: true, agent, params };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/agent-commands/`
Expected: PASS, all nine.

- [ ] **Step 5: Red-prove the NaN guard against the real validator**

Write a throwaway script that calls `dispatchAgentsRpc("agents.decisions", { minConfidence: NaN }, ctx)`
against an in-memory db and confirm it does **not** throw `-32602`. That is the hole this guard
exists for; seeing it once is worth more than trusting the comment.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/agent-commands/
git commit -m "feat(agents): parse and coerce k=v agent commands for text surfaces"
```

---

## Task 3: Generalize the permitted-set names

**Files:**
- Modify: `packages/gateway/src/ipc/agents-rpc.ts:969-1013`
- Modify: `packages/gateway/src/ipc/http-server.ts:33,855`
- Modify: `packages/gateway/src/agent-runs/agent-http-invoke.ts` (the `resolveHttpAgentMethod` call)

**Interfaces:**
- Consumes: nothing.
- Produces: `EXTERNAL_EXCLUDED_AGENT_METHODS`, `EXTERNAL_AGENT_NAMES`, `resolveExternalAgentMethod(agent): string | null`. Tasks 5 and 7 consume them.

**Why rename rather than add a second list:** the eleven are already *derived* from
`AGENTS_RPC_HANDLERS` at `agents-rpc.ts:983`. A second hand-maintained list of the same names is the
defect shape that cost the most on the MCP work. If the two surfaces ever need different exclusions,
splitting them then is a deliberate act; two lists now is a silent divergence waiting to happen.

- [ ] **Step 1: Write the failing test**

```ts
test("the external agent set is exactly eleven and excludes the four", () => {
  expect(EXTERNAL_AGENT_NAMES.length).toBe(11);
  for (const excluded of ["preflight", "premortem", "whyPeek", "negotiate"]) {
    expect(EXTERNAL_AGENT_NAMES).not.toContain(excluded);
    expect(resolveExternalAgentMethod(excluded)).toBeNull();
  }
});

test("resolveExternalAgentMethod does not resolve prototype keys", () => {
  expect(resolveExternalAgentMethod("constructor")).toBeNull();
  expect(resolveExternalAgentMethod("toString")).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/ipc/agents-rpc.test.ts -t "external agent set"`
Expected: FAIL — the symbols do not exist.

- [ ] **Step 3: Rename**

Pure renames — `HTTP_EXCLUDED_AGENT_METHODS` → `EXTERNAL_EXCLUDED_AGENT_METHODS`,
`HTTP_AGENT_NAMES` → `EXTERNAL_AGENT_NAMES`, `resolveHttpAgentMethod` → `resolveExternalAgentMethod`
— plus call-site updates in `http-server.ts` and `agent-http-invoke.ts`. **Do not change the
derivation or the exclusion set.** Update the doc comments to say "every external surface" rather
than "the HTTP API", and record that ChatOps inherits the exclusions rather than re-deciding them,
because every reason is *stronger* in a shared channel.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc/ packages/gateway/src/agent-runs/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/ packages/gateway/src/agent-runs/agent-http-invoke.ts
git commit -m "refactor(agents): name the permitted-agent set for every external surface"
```

---

## Task 4: `ClientKind` gains `chatops`

**Files:**
- Modify: `packages/gateway/src/ipc/server/client-kind.ts:12`
- Modify: `packages/gateway/src/egress/egress-bearing-kinds.ts`
- Test: `packages/gateway/src/egress/egress-bearing-kinds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ClientKind` includes `"chatops"`; `EGRESS_BEARING_CLIENT_KINDS.chatops === null`. Task 5 passes `kind: "chatops"`.

**Why `null` for a genuinely outbound path — read this before changing it:** every other `null` in
that map means "the owner reading their own index". This one does not. A channel brief **is** egress
— and PR 1 already ledgers it, at the post, where the bytes actually leave. Appending here as well
would write two rows for one outbound event, the double-count that `outcome` was made a marker to
avoid.

- [ ] **Step 1: Write the failing test**

```ts
test("chatops bears no agent-brief row — PR 1 ledgers it at the post instead", () => {
  expect(EGRESS_BEARING_CLIENT_KINDS.chatops).toBeNull();
  expect(egressSourceTypeForClientKind("chatops")).toBeNull();
});

test("chatops is not client-declarable — it is server-constructed like http", () => {
  const store = new ClientKindStore();
  expect(store.declare("c1", "chatops")).toBe("unknown");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/egress/egress-bearing-kinds.test.ts`
Expected: FAIL — `"chatops"` is not assignable to `ClientKind`.

- [ ] **Step 3: Implement**

In `client-kind.ts`:

```ts
export type ClientKind = "cli" | "mcp" | "ui" | "http" | "chatops" | "unknown";
```

Leave `RECOGNISED` **unchanged** — `chatops`, like `http`, is constructed server-side after the
gateway itself decides the caller is the ChatOps subsystem. Extend the `RECOGNISED` doc comment to
say so.

In `egress-bearing-kinds.ts`:

```ts
  // NOT the same `null` as `cli`/`ui`. Those are the owner reading their own index, which is not
  // egress at all. A channel brief IS egress — and it is ledgered at the POST, by
  // `egress/chatops-egress.ts`, where the bytes actually leave the machine. Appending here as well
  // would write TWO rows for ONE outbound event: exactly the double-count `outcome` was made a
  // marker to avoid. If the chatops post appender is ever removed, this must become "chatops".
  chatops: null,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/egress/ packages/gateway/src/ipc/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/server/client-kind.ts packages/gateway/src/egress/egress-bearing-kinds.ts packages/gateway/src/egress/egress-bearing-kinds.test.ts
git commit -m "feat(egress): add the chatops client kind, ledgered at the post not the brief"
```

---

## Task 5: The ChatOps agent invoker

**Files:**
- Create: `packages/gateway/src/agent-runs/agent-chatops-invoke.ts`
- Create: `packages/gateway/src/agent-runs/agent-chatops-invoke.test.ts`

**Interfaces:**
- Consumes: `resolveExternalAgentMethod` (Task 3), `dispatchAgentsRpc`, `AgentsRpcError`, `buildAgentSynthesisRunner`.
- Produces:
  ```ts
  export type ChatopsAgentResult =
    | { readonly ok: true; readonly markdown: string }
    | { readonly ok: false; readonly detail: string };
  export type ChatopsAgentInvoker = (agent: string, params: unknown) => Promise<ChatopsAgentResult>;
  export function buildChatopsAgentInvoker(deps: ChatopsAgentInvokerDeps): ChatopsAgentInvoker;
  ```
  Tasks 8–9 consume it.

**Shape:** a sibling of `agent-http-invoke.ts`, deliberately. The difference: a channel has no
polling client, so `notify` resolves a one-shot promise keyed on `sessionId` instead of writing into
an `AgentRunController`.

- [ ] **Step 1: Write the failing test**

```ts
test("returns the brief markdown from briefReady", async () => {
  const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 });
  const r = await invoke("glossary", { term: "SLO" });
  expect(r).toMatchObject({ ok: true });
  if (r.ok) expect(r.markdown).toContain("## Gaps");
});

test("works with NO llm configured — the criterion that proves the inversion is fixed", async () => {
  // router: undefined is the same as [agents].synthesis = "off". A deterministic brief must still
  // come back. A slice that only works with a model configured has not delivered this row.
  const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 });
  expect((await invoke("glossary", { term: "SLO" })).ok).toBe(true);
});

test("an excluded agent is refused without dispatching", async () => {
  const r = await buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 })(
    "premortem",
    {},
  );
  expect(r).toEqual({ ok: false, detail: expect.stringContaining("premortem") });
});

test("a validator -32602 comes back as its own message", async () => {
  const r = await buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1000 })(
    "expert",
    { topicOrFile: "" },
  );
  expect(r).toMatchObject({ ok: false });
  if (!r.ok) expect(r.detail).toContain("chars after trim");
});

test("times out rather than hanging the channel", async () => {
  const invoke = buildChatopsAgentInvoker({ db, router: undefined, timeoutMs: 1 });
  const r = await invoke("huddle", {});
  if (!r.ok) expect(r.detail).toContain("timed out");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/agent-runs/agent-chatops-invoke.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import type { Database } from "bun:sqlite";
import { buildAgentSynthesisRunner } from "../agents/_lib/agent-synthesis-runner.ts";
import type { SynthesisRouter } from "../agents/_lib/synthesis-llm.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc, resolveExternalAgentMethod } from "../ipc/agents-rpc.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";

/** 60 s, matching the MCP surface rather than the CLI's 30 s: three of the eleven wait on peers. */
export const CHATOPS_AGENT_TIMEOUT_MS = 60_000;

export type ChatopsAgentResult =
  | { readonly ok: true; readonly markdown: string }
  | { readonly ok: false; readonly detail: string };

export type ChatopsAgentInvoker = (agent: string, params: unknown) => Promise<ChatopsAgentResult>;

export type ChatopsAgentInvokerDeps = {
  readonly db: Database;
  readonly index?: LocalIndex;
  readonly configDir?: string;
  readonly selfIdentity?: BoxKeypair;
  /** Required — not optional — so a boot path cannot omit it and go silently inert. Pass
   *  `undefined` explicitly for "no synthesis", same as `[agents].synthesis = "off"`. */
  readonly router: SynthesisRouter | undefined;
  readonly timeoutMs?: number;
};

function readSessionId(v: unknown): string | null {
  if (v === null || typeof v !== "object") return null;
  const s = (v as { sessionId?: unknown }).sessionId;
  return typeof s === "string" && s !== "" ? s : null;
}

function readBrief(p: unknown): string | null {
  if (p === null || typeof p !== "object") return null;
  const b = (p as { brief?: unknown }).brief;
  return typeof b === "string" ? b : null;
}

/**
 * The ChatOps entry point into the agents namespace.
 *
 * Reaches agents THROUGH `dispatchAgentsRpc`, never an `agents/<name>.ts` emitter (D22(d)). Builds
 * its runner with the SAME `buildAgentSynthesisRunner` the socket and HTTP paths use, so a channel
 * brief and a CLI brief are the same answer to the same question under every `[agents].synthesis`
 * mode — by construction, not by both callers happening to omit the field.
 *
 * Unlike the HTTP invoker there is no `AgentRunController`: a channel has no polling client, it has
 * a reply. `notify` resolves a one-shot promise keyed on the dispatch's own `sessionId`.
 *
 * No `egress_ledger` append happens here, and that is deliberate: PR 1's post appender ledgers the
 * brief where it actually leaves the machine. See `egress-bearing-kinds.ts`'s `chatops: null`.
 */
export function buildChatopsAgentInvoker(deps: ChatopsAgentInvokerDeps): ChatopsAgentInvoker {
  const timeoutMs = deps.timeoutMs ?? CHATOPS_AGENT_TIMEOUT_MS;

  return async (agent, params): Promise<ChatopsAgentResult> => {
    const method = resolveExternalAgentMethod(agent);
    if (method === null) return { ok: false, detail: `Unknown or unavailable agent '${agent}'.` };

    let resolveBrief: (m: string) => void = () => {};
    let rejectBrief: (e: Error) => void = () => {};
    const briefPromise = new Promise<string>((res, rej) => {
      resolveBrief = res;
      rejectBrief = rej;
    });
    let expected: string | null = null;

    const runner = buildAgentSynthesisRunner({
      configDir: deps.configDir,
      db: deps.db,
      router: deps.router,
      method,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const out = await dispatchAgentsRpc(method, params, {
        db: deps.db,
        notify: (m, p): void => {
          if (expected !== null && readSessionId(p) !== expected) return;
          if (m.endsWith(".briefReady")) {
            const b = readBrief(p);
            if (b !== null) resolveBrief(b);
          } else if (m.endsWith(".briefError")) {
            rejectBrief(new Error("the agent reported an error"));
          }
        },
        ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
        ...(deps.index === undefined ? {} : { index: deps.index }),
        ...(deps.selfIdentity === undefined ? {} : { selfIdentity: deps.selfIdentity }),
        ...(runner === undefined ? {} : { runner }),
        // Server-derived. `chatops` is not in `RECOGNISED`, so no socket client can claim it.
        caller: { clientId: "chatops", kind: "chatops" },
      });
      expected = out.kind === "hit" ? readSessionId(out.value) : null;

      const markdown = await Promise.race([
        briefPromise,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("timed out")), timeoutMs);
        }),
      ]);
      return { ok: true, markdown };
    } catch (e) {
      if (e instanceof AgentsRpcError) return { ok: false, detail: e.message };
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
```

> **Implementer note — a real ordering hazard.** `notify` can fire *before* `dispatchAgentsRpc`
> returns, so `expected` may still be `null` when the first notification lands. The code above
> therefore only filters once `expected` is set. If you find briefs being dropped, buffer the
> notifications instead of filtering them; do **not** "fix" it by removing the session check, which
> would let a concurrent run's brief resolve this one.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/agent-runs/agent-chatops-invoke.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agent-runs/agent-chatops-invoke.ts packages/gateway/src/agent-runs/agent-chatops-invoke.test.ts
git commit -m "feat(chatops): invoke agents through dispatchAgentsRpc"
```

---

## Task 6: Brief truncation that cannot drop a disclosure

**Files:**
- Create: `packages/gateway/src/chatops/brief-truncate.ts`
- Create: `packages/gateway/src/chatops/brief-truncate.test.ts`

**Interfaces:**
- Consumes: `reservedBlocksFor`, `RESERVED_HEADINGS_BY_KIND` (`agents/_lib/reserved-sections.ts`); `stripSections`, `joinReserved` (`agents/_lib/markdown-sections.ts`).
- Produces: `truncateBrief(markdown: string, kind: string, maxBytes: number): string`. Task 8 consumes it.

**Do not write a `^## ` regex.** I31's guarantee is expressed in terms of *these* functions —
`normalizeSectionText`, the any-heading-level strip, the non-heading `Gaps:` form. A truncator with
its own notion of "a section" disagrees with the invariant exactly at the boundary, and the
disagreement shows up as a dropped disclosure on the one brief whose formatting differs.

- [ ] **Step 1: Write the failing test**

```ts
test("keeps ## Gaps even when it sits past the byte cap", () => {
  const body = `## Findings\n${"x".repeat(5000)}\n`;
  const brief = `# Why\n\n${body}## Gaps\n\n- category: coverage\n`;
  const out = truncateBrief(brief, "why", 500);
  expect(out).toContain("## Gaps");
  expect(out).toContain("category: coverage");
  expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(500 + 200); // + the notice line
});

test("announces the truncation rather than hiding it", () => {
  const brief = `# Why\n\n## A\n${"x".repeat(5000)}\n## Gaps\n\n- none\n`;
  expect(truncateBrief(brief, "why", 400)).toContain("truncated");
});

test("a brief under the cap is returned byte-identical", () => {
  const brief = "# Why\n\n## Gaps\n\n- none\n";
  expect(truncateBrief(brief, "why", 10_000)).toBe(brief);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/chatops/brief-truncate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Take the reserved blocks with `reservedBlocksFor`, strip them from the body with `stripSections`,
drop whole `##` body sections from the **end** until the body plus the reserved blocks plus the
notice fits `maxBytes`, then reassemble with `joinReserved`. Append
``_(truncated — N sections omitted; run `nimbus <agent>` locally for the full brief)_``.

Key rule to encode: **the reserved blocks are never candidates for dropping.** If the reserved
blocks alone exceed `maxBytes`, return them plus the notice rather than truncating inside a
disclosure — a half-printed gap is worse than a stated overflow.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/chatops/brief-truncate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chatops/brief-truncate.ts packages/gateway/src/chatops/brief-truncate.test.ts
git commit -m "feat(chatops): fit a brief to a platform cap without dropping a disclosure"
```

---

## Task 7: The `agent` arm in `parseCommand`

**Files:**
- Modify: `packages/gateway/src/chatops/types.ts:22-36`
- Modify: `packages/gateway/src/chatops/command-parser.ts:27`
- Test: `packages/gateway/src/chatops/command-parser.test.ts`

**Interfaces:**
- Consumes: `parseAgentCommand` (Task 2).
- Produces: `ParsedCommand` gains `{ kind: "agent"; agent: string; params: Record<string, unknown> }`; `RefusalReason` gains `"unknown_agent"` and `"bad_agent_params"`. Task 8 consumes them.

- [ ] **Step 1: Write the failing test**

```ts
test("an agent command parses to the agent kind, ahead of the read fallthrough", () => {
  expect(parseCommand("agent why ref=a.ts", ACTIONS, PERMITTED_AGENTS)).toEqual({
    kind: "agent",
    agent: "why",
    params: { ref: "a.ts" },
  });
});

test("a plain question is still a read", () => {
  expect(parseCommand("why is checkout slow?", ACTIONS, PERMITTED_AGENTS)).toEqual({
    kind: "read",
    query: "why is checkout slow?",
  });
});

test("`run` still wins — the write grammar is unchanged", () => {
  expect(parseCommand("run deployment.rollback service=api", ACTIONS, PERMITTED_AGENTS).kind).toBe(
    "write",
  );
});

test("an unknown agent refuses with unknown_agent", () => {
  expect(parseCommand("agent nope", ACTIONS, PERMITTED_AGENTS)).toMatchObject({
    kind: "refused",
    reason: "unknown_agent",
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/chatops/command-parser.test.ts`
Expected: FAIL — `parseCommand` takes two arguments.

- [ ] **Step 3: Implement**

Add the union member and the two refusal reasons to `types.ts`. In `command-parser.ts`, give
`parseCommand` a third parameter `permittedAgents: ReadonlySet<string>` and call `parseAgentCommand`
**before** the `run` check; a `null` return falls through to today's behaviour unchanged.

Map `ok: false` to `{ kind: "refused", reason, detail }`, choosing `unknown_agent` when the detail
names an unknown agent and `bad_agent_params` otherwise.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/chatops/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chatops/types.ts packages/gateway/src/chatops/command-parser.ts packages/gateway/src/chatops/command-parser.test.ts
git commit -m "feat(chatops): parse the agent intent ahead of the read fallthrough"
```

---

## Task 8: The `IntentRouter` agent branch

**Files:**
- Modify: `packages/gateway/src/chatops/intent-router.ts:26-50`
- Test: `packages/gateway/src/chatops/intent-router.test.ts`

**Interfaces:**
- Consumes: `ChatopsAgentInvoker` (Task 5), `truncateBrief` (Task 6).
- Produces: `IntentRouterDeps` gains `runAgent: ChatopsAgentInvoker` and `permittedAgents: ReadonlySet<string>`. Task 9 wires them.

**The mapped-identity rule:** `binding.unmapped === "public-read"` admits unmapped users to the
`read` intent **only**. The agent intent does not inherit it — fail-closed is the reversible
direction, and three of the eleven fan out to paired peers.

- [ ] **Step 1: Write the failing test**

```ts
test("an unmapped user is refused AND no agent runs", async () => {
  const calls = { n: 0 };
  const r = routerWith({
    identity: "unmapped",
    binding: { unmapped: "public-read" },
    runAgent: async () => {
      calls.n += 1;
      return { ok: true, markdown: "x" };
    },
  });
  await r.handle(msg("agent why ref=a.ts"));
  // Asserting the refusal alone would pass against an implementation that refused AFTER running.
  expect(calls.n).toBe(0);
  expect(replies).toContain("You are not enrolled for this channel.");
});

test("a mapped user gets the brief posted", async () => {
  await routerWith({ identity: "mapped" }).handle(msg("agent why ref=a.ts"));
  expect(replies[0]).toContain("## Gaps");
});

test("an unmapped user can still ask a plain question under public-read", async () => {
  await routerWith({ identity: "unmapped", binding: { unmapped: "public-read" } }).handle(
    msg("why is checkout slow?"),
  );
  expect(replies[0]).toBe("ask-engine-answer");
});

test("an unbound channel stays silent for an agent command too", async () => {
  await routerWith({ binding: undefined }).handle(msg("agent why ref=a.ts"));
  expect(replies).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/chatops/intent-router.test.ts`
Expected: FAIL — `runAgent` is not a dep.

- [ ] **Step 3: Implement**

Add `runAgent` and `permittedAgents` to `IntentRouterDeps`. In `handle`, pass
`this.deps.permittedAgents` to `parseCommand`. In the `idr.kind === "unmapped"` block, keep the
existing `public-read` allowance for `cmd.kind === "read"` **only** — an `agent` command from an
unmapped user falls through to the existing `unmapped_user` refusal with no extra code, which is the
fail-closed default doing the work.

After the `refused` branch and before `read`:

```ts
    if (cmd.kind === "agent") {
      const result = await this.deps.runAgent(cmd.agent, cmd.params);
      if (!result.ok) {
        await this.refuse("bad_agent_params", result.detail, msg.channelId);
        return;
      }
      await this.deps.reply(result.markdown);
      return;
    }
```

Truncation is applied by the **boot wiring** (Task 9), not here, so `IntentRouter` stays free of
platform byte caps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/chatops/intent-router.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chatops/intent-router.ts packages/gateway/src/chatops/intent-router.test.ts
git commit -m "feat(chatops): route an agent intent behind a mapped identity"
```

---

## Task 9: Wire it end to end

**Files:**
- Modify: `packages/gateway/src/chatops/chatops-boot.ts` (`bindAgentInvoker`, `ChatopsBoot`)
- Modify: `packages/gateway/src/gateway-main.ts:170` (alongside `bindAskEngine`)
- Test: `packages/gateway/src/chatops/chatops-flow.integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

**Why an integration test and not two unit tests:** both sides of this seam already have unit tests
that pass. A test per side proves the ends, never the wire — and a late-bound invoker that is never
bound leaves the feature inert while every unit test stays green.

- [ ] **Step 1: Write the failing test**

```ts
test("end to end: a channel message runs an agent, posts a brief, and ledgers ONE row", async () => {
  const boot = await bootForTest({ db });
  boot.bindAgentInvoker(buildChatopsAgentInvoker({ db, router: undefined }));

  await deliverMessage(boot, "@nimbus agent glossary term=SLO");

  expect(postedText()).toContain("## Gaps");
  const rows = listEgress(db, { limit: 10 });
  // ONE row, from PR 1's post appender. NOT two: the invoker deliberately appends nothing.
  expect(rows.length).toBe(1);
  expect(rows[0]?.method).toBe("chatops.agentBrief");
});

test("the brief posts on a gateway with no LLM configured", async () => {
  const boot = await bootForTest({ db, llm: "none" });
  boot.bindAgentInvoker(buildChatopsAgentInvoker({ db, router: undefined }));
  await deliverMessage(boot, "@nimbus agent glossary term=SLO");
  expect(postedText()).toContain("## Gaps");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/chatops/chatops-flow.integration.test.ts`
Expected: FAIL — `bindAgentInvoker` does not exist.

- [ ] **Step 3: Implement**

Add `bindAgentInvoker(fn: ChatopsAgentInvoker): void` to the `ChatopsBoot` interface and a late-bound
holder in `buildChatopsBoot`, mirroring `bindAskEngine`. Pass `permittedAgents: new Set(EXTERNAL_AGENT_NAMES)`
into the `IntentRouter`, and wrap the invoker so the reply goes through
`posts.agentBrief` after `truncateBrief`.

In `gateway-main.ts`, next to the existing `bindAskEngine` call:

```ts
  platform.chatops?.bindAgentInvoker(
    buildChatopsAgentInvoker({
      db: platform.db,
      index: platform.localIndex,
      configDir: platform.paths.configDir,
      router: platform.llmRegistry.llmRouter,
    }),
  );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/chatops/ && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/chatops/ packages/gateway/src/gateway-main.ts
git commit -m "feat(chatops): wire the agent invoker into boot"
```

---

## Task 10: The anti-drift structure audit

**Files:**
- Create: `scripts/structure-audit/check-agent-param-kinds.ts`
- Create: `scripts/structure-audit/check-agent-param-kinds.test.ts`
- Modify: `scripts/lib/preflight-gates.ts` (register the gate)

**Interfaces:**
- Consumes: `AGENT_PARAM_KINDS` (Task 1).
- Produces: a `preflight` gate.

**This is the task with real implementation risk, and it has a stated fallback.** Associating a
`typeof p.<field>` site with its enclosing validator function is the fiddly part. **A guard that
silently matches nothing is worse than no guard.**

- [ ] **Step 1: Write the failing test**

```ts
test("flags a validator field with no entry in the kinds map", () => {
  const v = checkAgentParamKinds({
    "requireExpertParams": { agent: "expert", fields: { topicOrFile: "string", limit: "number", newField: "string" } },
  });
  expect(v.map((x) => x.snippet)).toContain("expert.newField");
});

test("flags a kinds-map field the validator does not have", () => {
  const v = checkAgentParamKinds({
    "requireExpertParams": { agent: "expert", fields: { topicOrFile: "string" } },
  });
  expect(v.map((x) => x.snippet)).toContain("expert.limit");
});

test("THE GUARD IS NOT INERT: a realistic parse of the real file finds fields", () => {
  // The failure mode this test exists for: a parser that matches nothing passes every other
  // assertion in this file.
  const parsed = parseValidatorFields(readFileSync(AGENTS_RPC_PATH, "utf8"));
  expect(Object.keys(parsed).length).toBeGreaterThanOrEqual(10);
  expect(parsed["requireExpertParams"]?.fields).toMatchObject({ topicOrFile: "string" });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test scripts/structure-audit/check-agent-param-kinds.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Parse `agents-rpc.ts` by walking lines, tracking the current `function require<X>Params(` header, and
collecting `typeof p.<field> !== "<kind>"` matches within it. Map validator name → agent via the
handler map's `handle<X>` → `require<X>Params` correspondence; hard-code the three that do not
follow it (`ghost`/`conflicts` both use `requireFileParam`, `why` uses `requireWhyParams`).

- [ ] **Step 4: RED-PROVE IT — do not skip this**

Delete `limit: "number"` from `expert` in `agent-param-kinds.ts`. Run `bun run audit:agent-param-kinds`.
It **must fail**, naming `expert.limit`. Restore and confirm green. A green run alone does not
distinguish a working guard from one whose regex matches nothing.

- [ ] **Step 5: Register the gate**

Add to `scripts/lib/preflight-gates.ts` so the drift test does not fail for a missing CI gate.

- [ ] **Step 6: Run the full gate set**

Run: `bun run preflight`
Expected: PASS.

- [ ] **Step 7: If the parser cannot be made reliable, STOP and take the fallback**

If Step 4 cannot be made to pass and fail on demand within a reasonable effort, **do not ship a
guard that might be inert.** Delete it, and instead:
1. Extend Task 2's round-trip tests to cover every agent × every declared field.
2. Add a comment in `agent-param-kinds.ts` stating that the audit was attempted and why it was
   dropped, so the next person does not silently re-derive the same dead end.
3. Say so in the PR description. A stated gap is a decision; an inert guard is a false claim.

- [ ] **Step 8: Commit**

```bash
git add scripts/
git commit -m "feat(audit): fail the build when the param-kinds map drifts from the validators"
```

---

## Task 11: Docs and the roadmap correction

**Files:**
- Modify: `docs/architecture.md` (ChatOps subsystem)
- Modify: `docs/roadmap.md` (the messaging-surface block)
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Record the four disclosures**

In `docs/architecture.md`, per spec §9: a brief is **not** filtered by channel or namespace; every
post is ledgered; the permitted set is eleven, not fourteen, and why; unmapped users cannot invoke an
agent, and the resulting inconsistency with `ask`.

- [ ] **Step 2: Correct the roadmap's I17 claim**

The block says the channel↔namespace binding and the I17 filter are "load-bearing here". Per spec
§2.1 that is wrong: I17 governs *federated* answering only and is not on this path, and `namespaces`
selects which **peers** to ask rather than filtering local rows. Rewrite the claim; move the row from
*direction* to shipped.

- [ ] **Step 3: Record the chat-triggered peer-query disclosure**

Per spec §13.2: `ghost`/`conflicts`/`huddle` carry the **owner's** federation identity, not the chat
user's, and the peer sees no indication the request came from a channel. Add the test that pins it if
Task 5 did not already.

- [ ] **Step 4: CHANGELOG**

One dated entry. Lead with the dependency inversion being fixed — the deterministic agents were
unreachable on the surface that needs no install.

- [ ] **Step 5: Run the full gate set**

Run: `bun run preflight`
Expected: PASS. `audit:doc-refs` does **not** scan `docs/superpowers/`, so spec/plan cross-links are
not gated — check them by hand.

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs: record the chatops agent intent and correct the roadmap's I17 claim"
```

---

## Self-Review Notes

- **Spec coverage:** §6.1 → Task 7; §6.2 → Tasks 1–2; §6.3 → Tasks 4–5; §6.4 → Task 3; §6.5 → Task 8; §6.6 → Task 6; §7 → Task 10; §8 → Task 9; §9 → Task 11; §13.2 → Task 11 Step 3.
- **Type consistency:** `ChatopsAgentInvoker` (Task 5) is the type Tasks 8 and 9 consume; `ParamKind` and `AGENT_PARAM_KINDS` (Task 1) are what Tasks 2 and 10 consume; `EXTERNAL_AGENT_NAMES` / `resolveExternalAgentMethod` (Task 3) are what Tasks 5 and 9 consume. No symbol is referenced before the task that defines it.
- **Two tasks carry a stated fallback rather than a promise:** Task 10 (the audit may be undeliverable — take the fallback rather than shipping something inert) and Task 5's implementer note (the notify/dispatch ordering hazard, with the wrong fix named explicitly).
- **Three tests assert a CALL COUNT, not just an outcome** (Task 8's unmapped user, PR 1's failed append, Task 9's single ledger row). Each replaces an assertion that would pass against a broken implementation.
