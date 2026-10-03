# On-call Pushed Brief PR 2 (ChatOps sink) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the on-call push stores a brief, post a short, escaped, ledgered headline to the ChatOps notify channels of a configured namespace, and record every outcome in `delivery_json.chatops`.

**Architecture:** A new `chatops` sink in `oncall-push/push-sinks.ts` renders a three-line headline (`oncall-push/push-headline.ts`) and calls a poster that `platform/assemble.ts` binds once ChatOps has booted. The poster is `ChatopsBoot.postPushedBrief`, a third `ReplyDispatcher` over a new `posts.pushedBrief` kind of the existing `buildLedgeredChatPosts` factory, so every post is I23-routed and I29-ledgered with no new appender. A one-shot gate in the push runtime holds runs until the poster is settled, which closes the boot race. A new `BootPolicy.chatops` flag makes "no ChatOps in a demo gateway" structural (I41).

**Tech Stack:** Bun 1.3, TypeScript strict (no `any`), `bun:sqlite`, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-10-02-oncall-push-chatops-design.md` (read it with this plan, including § 8, "Review dispositions"). The review it answers is `docs/superpowers/specs/2026-10-02-oncall-push-chatops-review.md`.

## Global Constraints

- Branch: `dev/asaf/oncall-push-chatops`, worktree `C:/gitrep/Nimbus/.claude/worktrees/oncall-push-chatops`. Run `git rev-parse --abbrev-ref HEAD` before EVERY commit, because another session can move HEAD.
- Run every command from the worktree root. Test paths are repo-relative, e.g. `bun test packages/gateway/src/oncall-push/push-sinks.test.ts`.
- No `any`. Use `unknown` plus narrowing for parsed JSON.
- No new invariant, no static rule, no egress class, no IPC method, no migration. The one invariant WIRING change is I41's `BootPolicy.chatops` (Task 7). It follows the triple rule: wiring, docs and test land in the same commit.
- The ChatOps call to action is `@nimbus agent oncall incidentId=<id>`. The parameter is `incidentId`, never `incident` (see `packages/gateway/src/ipc/agent-param-kinds.ts`).
- Outcome reason strings, verbatim: `no [oncall.push] chatops_namespace`, `ChatOps not running`, `namespace <ns> has no notify channels`, `<error message> (delivery may be partial)`, `summary post failed: <reason>`.
- Headline line 2 for a failed row, verbatim: `Brief could not be assembled; rerun the agent below to retry`.
- `PUSH_NOTIFY_CAP` stays 3. `SUMMARY_ID_CAP` = 10. `FIELD_MAX_CODEPOINTS` = 200.
- Fixtures for brief content come from the real writers (`seedDemoCorpus` + `fireDemoPage`, or `syncPagerdutyIncidentItems` + the real runtime), never hand-written brief JSON. `push-sinks.test.ts`'s existing `item()` helper (with `briefJson: "{}"`) is fine there, because the sink tests assert outcomes and post counts, not brief content.
- D22(d): no non-test file may import an `agents/<name>.ts` emitter. `agents/_lib/*` is fine.
- Commit messages go through `git commit -F <file>` (backticks in `-m` get eaten), and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every new test is red-proved: revert the fix, see it fail, restore. Say which line you reverted in the task report.
- Close the DB before asserting anything that a cleanup error could mask. Every test here uses `:memory:` or `createMemoryIndexDb()`, closed in `afterEach`.
- Test data lives only under `os.tmpdir()` temp dirs that the test creates and removes. Never touch the real Nimbus data dir.

## Review Focus

Inputs the spec implies but does not spell out, most likely to bite first. Each one has a test in the task that owns the code.

1. **A title that is empty or only whitespace after normalisation** (PagerDuty allows it): line 1 must read `… — (untitled)`, never `… — ` with nothing after it. Task 3.
2. **A very long title** (a pasted stack trace): each field is capped at 200 code points with a trailing `…`, so the headline stays three short lines. The cut must not split a surrogate pair. Task 3.
3. **Bidi overrides or zero-width characters in a title** (Trojan Source): these are removed, so the rendered line reads the same as its bytes. Task 3.
4. **An incident id containing a Slack control character**: it renders escaped (`&amp;`) and inert. A normal id round-trips through the real `parseAgentCommand`. Task 3.
5. **A run whose overflow rows are all `failed`**: the summary reads `0 briefs ready` (plural) and still lists the ids. Task 3.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/gateway/src/chatops/escape-outbound.ts` (new) | `escapeSlackText`: Slack's three control characters. Shared, so the follow-up for `@nimbus agent` replies can reuse it. |
| `packages/gateway/src/oncall-push/push-headline.ts` (new) | Pure rendering: `oneLine`, `parseHeadlineBrief`, `pushAgentCommand`, `renderPushHeadline`, `renderPushSummary`. |
| `packages/gateway/src/egress/chatops-egress.ts` | Fourth `ChatPostKind`: `pushedBrief` → `chatops.pushedBrief`. |
| `packages/gateway/src/chatops/reply-dispatcher.ts` | `send` resolves to the count of channels posted to. |
| `packages/gateway/src/chatops/chatops-boot.ts` | `pushedBriefDispatcher` + `ChatopsBoot.postPushedBrief`. |
| `packages/gateway/src/oncall-push/push-sinks.ts` | The `chatops` sink, `ChatopsPoster`, `ChatopsSinkDeps`, `warn`. |
| `packages/gateway/src/oncall-push/push-runtime.ts` | Settle gate, `settleChatopsPoster`, `chatopsSinkState`, wiring the sink. |
| `packages/gateway/src/platform/assemble.ts` | `settleOncallPushChatops` helper and call, `oncallPush` on `PlatformServices`, the ChatOps boot-policy guard. |
| `packages/gateway/src/platform/types.ts` | `PlatformServices.oncallPush`. |
| `packages/gateway/src/platform/demo-boot.ts` | `BootPolicy.chatops`. |
| `packages/gateway/src/config/oncall-push-toml.ts` | Header comment only. |
| `packages/gateway/src/oncall-push/push-chatops.integration.test.ts` (new) | Real DB + real seed/fire + real ledgered posts, two channels. |

---

### Task 1: `escapeSlackText`

**Files:**
- Create: `packages/gateway/src/chatops/escape-outbound.ts`
- Test: `packages/gateway/src/chatops/escape-outbound.test.ts`

**Interfaces:**
- Produces: `export function escapeSlackText(s: string): string`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { escapeSlackText } from "./escape-outbound.ts";

describe("escapeSlackText", () => {
  test("escapes Slack's three control characters", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("escapes & FIRST, so an already-escaped entity is not decoded back into a control char", () => {
    expect(escapeSlackText("&lt;!channel&gt;")).toBe("&amp;lt;!channel&amp;gt;");
  });

  test("mentions and disguised links are inert: no < or > survives", () => {
    for (const hostile of ["<!channel>", "<!here>", "<@U123>", "<https://evil.example|Rollback docs>"]) {
      const out = escapeSlackText(hostile);
      expect(out).not.toContain("<");
      expect(out).not.toContain(">");
    }
    expect(escapeSlackText("DB down <!channel> <https://evil|Rollback docs> & more")).toBe(
      "DB down &lt;!channel&gt; &lt;https://evil|Rollback docs&gt; &amp; more",
    );
  });

  test("plain text is unchanged", () => {
    expect(escapeSlackText("payment-service: 5xx rate above 5% on /v1/charges")).toBe(
      "payment-service: 5xx rate above 5% on /v1/charges",
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `bun test packages/gateway/src/chatops/escape-outbound.test.ts`
Expected: FAIL, `Cannot find module './escape-outbound.ts'`.

- [ ] **Step 3: Implement**

```ts
/**
 * Slack's control-character escape for text a bot posts: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`,
 * in that order. `&` goes first, or the `&` of a `&lt;` this function just wrote would be escaped
 * again. With all three escaped, nothing a caller passes can form a `<!channel>` mention, a `<@U…>`
 * user mention or a `<url|label>` link whose label hides its target. Slack renders the entities as
 * the literal characters, so readers see the original text.
 *
 * Slack-only by design: `ReplyDispatcher` posts every `namespaceNotify` message as `"slack"`
 * (spec § 7), and Teams has a different markup.
 */
export function escapeSlackText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `bun test packages/gateway/src/chatops/escape-outbound.test.ts`
Expected: 4 pass.

- [ ] **Step 5: Red-prove.** Swap the order to escape `<` before `&`. The "escapes & FIRST" test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print dev/asaf/oncall-push-chatops
git add packages/gateway/src/chatops/escape-outbound.ts packages/gateway/src/chatops/escape-outbound.test.ts
git commit -F msg.txt   # "feat(chatops): escapeSlackText for outbound bot text"
```

---

### Task 2: The push runtime's settle gate

This lands before the sink so later tasks can use `settleImmediately`. Until Task 6, `assemble.ts` settles with `undefined` right after ChatOps boots, so every intermediate commit still runs pushes.

**Files:**
- Modify: `packages/gateway/src/oncall-push/push-sinks.ts` (add the `ChatopsPoster` type only)
- Modify: `packages/gateway/src/oncall-push/push-runtime.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (temporary settle call)
- Modify: test call sites. `packages/gateway/src/oncall-push/push-runtime.test.ts` (the `boot` helper plus the two direct `assembleOncallPushRuntime` calls near lines 143 and 186), `packages/gateway/src/demo/seed.test.ts` (three calls), `packages/gateway/src/ipc/demo-rpc.test.ts` (one call) and `packages/gateway/src/ipc/oncall-push-rpc.test.ts` (the `runtime()` fake).
- Test: `packages/gateway/src/oncall-push/push-runtime.test.ts`

**Interfaces:**
- Produces, in `push-sinks.ts`: `export type ChatopsPoster = (text: string) => Promise<number>;`
- Produces, on `OncallPushRuntime`:
  - `settleChatopsPoster(post: ChatopsPoster | undefined): void`, which throws if already settled.
  - `chatopsSinkState(): "pending" | "bound" | "none"`
- Produces, on `OncallPushBootDeps`:
  - `readonly settleImmediately?: boolean`
  - `logger: { error(obj: Record<string, unknown>, msg: string): void; warn?(obj: Record<string, unknown>, msg: string): void }`
- `run`, `trigger` and `retry` all await the gate.

- [ ] **Step 1: Write the failing tests** (append to `push-runtime.test.ts`; `seedP1`, `T0`, `LocalIndex` and `configDir` already exist there)

```ts
test("a run before settleChatopsPoster waits for it, then runs once (spec § 4 boot race)", async () => {
  const meId = seedP1("PGATE");
  writeFileSync(
    join(configDir, "nimbus.toml"),
    `[user]\nme_person_id = "${meId}"\n\n[oncall.push]\nenabled = true\n`,
  );
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    localIndex: new LocalIndex(db),
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => T0 - 1000,
  });
  expect(rt.chatopsSinkState()).toBe("pending");
  const p = rt.run("pagerduty");
  // An ungated run finishes well inside this window, so with the gate's `await` deleted this race
  // resolves "ran". That is the red-proof. With the gate it can only be "held".
  const first = await Promise.race([
    p.then(() => "ran" as const),
    Bun.sleep(1500).then(() => "held" as const),
  ]);
  expect(first).toBe("held");
  expect(rt.store.get("pagerduty:PGATE")).toBeNull();
  rt.settleChatopsPoster(undefined);
  expect(rt.chatopsSinkState()).toBe("none");
  expect(await p).toEqual({ selected: 1, ok: 1, failed: 0 });
  expect(rt.store.get("pagerduty:PGATE")?.status).toBe("ok");
});

test("retry waits for the gate too", async () => {
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
  });
  const r = rt.retry("pagerduty:NONE");
  const first = await Promise.race([
    r.then(
      () => "ran" as const,
      () => "ran" as const,
    ),
    Bun.sleep(200).then(() => "held" as const),
  ]);
  expect(first).toBe("held");
  rt.settleChatopsPoster(undefined);
  await expect(r).rejects.toMatchObject({ code: "ERR_ONCALL_PUSH_NOT_FOUND" });
});

test("settling records bound vs none, and a second settle throws", () => {
  const a = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
  });
  a.settleChatopsPoster(async () => 1);
  expect(a.chatopsSinkState()).toBe("bound");
  expect(() => a.settleChatopsPoster(undefined)).toThrow(/already settled/);
});

test("settleImmediately starts settled with no poster", () => {
  expect(boot().chatopsSinkState()).toBe("none");
  expect(() => boot().settleChatopsPoster(undefined)).toThrow(/already settled/);
});
```

Then update the existing call sites so they do not hang:

- `push-runtime.test.ts`: in the `boot` helper's `assembleOncallPushRuntime({ ... })` literal, add `settleImmediately: true,`. Add the same line to the two direct calls in the tests "run() drives the real pipeline end to end…" and "a notification service that does not deliver…".
- `demo/seed.test.ts`: add `settleImmediately: true,` to all three `assembleOncallPushRuntime({ ... })` literals.
- `ipc/demo-rpc.test.ts`: add `settleImmediately: true,` to its one call.
- `ipc/oncall-push-rpc.test.ts`: in the `runtime()` fake's object literal, add `settleChatopsPoster: () => {},` and `chatopsSinkState: () => "none",`.

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/oncall-push/push-runtime.test.ts`
Expected: FAIL with type and runtime errors (`settleImmediately` and `chatopsSinkState` do not exist).

- [ ] **Step 3: Implement**

In `push-sinks.ts`, after the imports:

```ts
/** Posts one headline to the configured namespace; resolves to the number of channels posted to. */
export type ChatopsPoster = (text: string) => Promise<number>;
```

In `push-runtime.ts`, change the import to `import { type ChatopsPoster, createPushDeliverer } from "./push-sinks.ts";`, then:

```ts
export interface OncallPushRuntime {
  readonly config: NimbusOncallPushToml;
  readonly store: PushStore;
  run(serviceId: string): Promise<PushRunSummary>;
  /** Fire-and-forget for the sync hook; never throws. */
  trigger(serviceId: string): void;
  retry(incidentId: string): Promise<PushedBriefRow>;
  identityResolved(): Promise<boolean>;
  /**
   * Spec § 4 (boot race): bind the ChatOps poster, or record that there is none, and release every
   * run held since boot. `platform/assemble.ts` calls it exactly once, right after ChatOps boots, on
   * the enabled AND the disabled branch. A second call throws.
   */
  settleChatopsPoster(post: ChatopsPoster | undefined): void;
  /** `pending` until settled, then `bound` (a poster) or `none`. */
  chatopsSinkState(): "pending" | "bound" | "none";
}
```

In `OncallPushBootDeps`, replace the `logger` line and add `settleImmediately`:

```ts
  /** `warn` is optional so test loggers need not supply it; production passes the pino logger. */
  readonly logger: {
    error(obj: Record<string, unknown>, msg: string): void;
    warn?(obj: Record<string, unknown>, msg: string): void;
  };
  /**
   * Start settled with no poster. For tests and any caller with no ChatOps phase. Production
   * leaves it unset so no run starts before `assemble.ts` has decided whether ChatOps exists.
   */
  readonly settleImmediately?: boolean;
```

In `assembleOncallPushRuntime`, before `const runner = …`:

```ts
  // Spec § 4: the sync scheduler can complete a PagerDuty sync before ChatOps has booted. A run
  // that delivered then would record "ChatOps not running", and dedup would never reselect it.
  // So nothing starts until the poster is settled; early runs wait rather than drop.
  let settled = deps.settleImmediately === true;
  let chatopsPoster: ChatopsPoster | undefined;
  let release: () => void = () => {};
  const gate: Promise<void> = settled
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        release = resolve;
      });
  const run = async (serviceId: string): Promise<PushRunSummary> => {
    await gate;
    return runner.run(serviceId);
  };
```

Replace the returned object's `run`, `trigger` and `retry`, and add the two new members:

```ts
    run,
    trigger(serviceId) {
      run(serviceId).catch((err: unknown) => {
        deps.logger.error(
          { err: err instanceof Error ? err.message : String(err) },
          "[oncall.push] run failed",
        );
      });
    },
    retry: async (incidentId) => {
      await gate;
      return runner.retry(incidentId);
    },
    identityResolved: async () => (await resolveSelf()) !== null,
    settleChatopsPoster(post) {
      if (settled) throw new Error("[oncall.push] settleChatopsPoster: already settled");
      settled = true;
      chatopsPoster = post;
      release();
    },
    chatopsSinkState() {
      if (!settled) return "pending";
      return chatopsPoster === undefined ? "none" : "bound";
    },
```

`run` is declared before `runner` is assigned. That is fine: it only reads `runner` when called, and that cannot happen before `assembleOncallPushRuntime` returns.

In `platform/assemble.ts`, directly after the `chatopsBoot = await bootChatopsIntoAssembly({ … });` statement, add the temporary call. Task 6 replaces it.

```ts
  // TEMPORARY (oncall-push PR 2, Task 2): release held runs; Task 6 binds the real poster here.
  oncallPush.settleChatopsPoster(undefined);
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `bun test packages/gateway/src/oncall-push packages/gateway/src/demo/seed.test.ts packages/gateway/src/ipc/demo-rpc.test.ts packages/gateway/src/ipc/oncall-push-rpc.test.ts packages/gateway/src/ipc/server/dispatchers-oncall-push.test.ts`
Expected: all pass. Then run `bun run typecheck`, expecting exit 0. If another file constructs an `OncallPushRuntime` literal and fails typecheck, add the two members there the same way.

Typecheck cannot catch the other failure mode. A test that builds a real runtime without `settleImmediately: true` and never settles it compiles fine, then HANGS on `run`/`retry`. So enumerate every real construction:

```bash
grep -rn "assembleOncallPushRuntime(" packages/gateway/src packages/gateway/test --include=*.ts
```

At planning time, the non-definition hits were `demo/seed.test.ts` (3), `ipc/demo-rpc.test.ts` (1), `oncall-push/push-runtime.test.ts` (5, of which the two new gate tests settle explicitly) and `platform/assemble.ts` (1, settled by the Task 2 temporary call). Every other test hit must carry `settleImmediately: true` or call `settleChatopsPoster`. A new hit not on this list gets the same treatment.

- [ ] **Step 5: Red-prove.** Delete `await gate;` from `run`. The boot-race test must fail on `expect(first).toBe("held")`. Restore. Then delete it from `retry`. The retry test must fail. Restore.

- [ ] **Step 6: Commit** (`feat(oncall): hold push runs until the ChatOps poster is settled`)

---

### Task 3: Headline and summary rendering

**Files:**
- Create: `packages/gateway/src/oncall-push/push-headline.ts`
- Test: `packages/gateway/src/oncall-push/push-headline.test.ts`

**Interfaces:**
- Consumes: `escapeSlackText` (Task 1), `PushDelivery` from `./push-runner.ts`.
- Produces:
  - `export const SUMMARY_ID_CAP = 10`
  - `export const FIELD_MAX_CODEPOINTS = 200`
  - `export function oneLine(s: string): string`
  - `export type HeadlineBrief = { readonly nimbusServiceId: string | null; readonly deployment: { readonly title: string; readonly startedAtMs: number; readonly finishedAtMs: number | null } | null }`
  - `export function parseHeadlineBrief(json: string | null): HeadlineBrief | null`
  - `export function pushAgentCommand(incidentId: string): string`
  - `export function renderPushHeadline(d: PushDelivery): string`
  - `export function renderPushSummary(all: readonly PushDelivery[], rest: readonly PushDelivery[]): string`

- [ ] **Step 1: Write the failing tests**

The real fixture is the demo story: the seed plus a fired page give a real `ok` row whose `briefJson` the real `agents.oncall` wrote. Variants are derived by changing fields on that parsed real JSON, never by writing JSON from scratch.

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAgentCommand } from "../agent-commands/parse-agent-command.ts";
import { selectIncidentById } from "../agents/_lib/oncall-queries.ts";
import { fireDemoPage, seedDemoCorpus } from "../demo/seed.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { EXTERNAL_AGENT_NAMES } from "../ipc/agents-rpc.ts";
import {
  FIELD_MAX_CODEPOINTS,
  oneLine,
  parseHeadlineBrief,
  pushAgentCommand,
  renderPushHeadline,
  renderPushSummary,
  SUMMARY_ID_CAP,
} from "./push-headline.ts";
import type { PushDelivery } from "./push-runner.ts";
import { assembleOncallPushRuntime } from "./push-runtime.ts";

let dbs: Database[] = [];
let roots: string[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

/** A REAL pushed row: the demo seed, then the same run a PagerDuty sync triggers. */
async function realDelivery(): Promise<PushDelivery> {
  const root = mkdtempSync(join(tmpdir(), "nimbus-push-headline-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  const nowMs = Date.now();
  await seedDemoCorpus(db, { configDir, dataDir, nowMs });
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
    settleImmediately: true,
  });
  const fired = await fireDemoPage(db, rt, nowMs);
  const row = rt.store.get(fired.incidentId);
  const incident = selectIncidentById(db, fired.incidentId);
  if (row === null || incident === null) throw new Error("fixture: no pushed row");
  if (row.status !== "ok") throw new Error(`fixture: expected ok, got ${row.failureCode}`);
  return { row, incident };
}

/** The real brief JSON with one top-level key replaced. */
function withBrief(d: PushDelivery, patch: Record<string, unknown>): PushDelivery {
  const base = JSON.parse(d.row.briefJson ?? "null") as Record<string, unknown>;
  return { ...d, row: { ...d.row, briefJson: JSON.stringify({ ...base, ...patch }) } };
}
function lines(s: string): string[] {
  return s.split("\n");
}

describe("parseHeadlineBrief over the REAL stored brief", () => {
  test("reads the binding and the story deployment", async () => {
    const d = await realDelivery();
    const b = parseHeadlineBrief(d.row.briefJson);
    expect(b).not.toBeNull();
    expect(b?.nimbusServiceId).toBe("payment-service");
    expect(typeof b?.deployment?.title).toBe("string");
  });
  test("null, malformed and wrong-shape JSON all mean no brief", () => {
    expect(parseHeadlineBrief(null)).toBeNull();
    expect(parseHeadlineBrief("{not json")).toBeNull();
    expect(parseHeadlineBrief("{}")).toBeNull();
    expect(parseHeadlineBrief("[]")).toBeNull();
    expect(parseHeadlineBrief('{"binding":{"nimbusServiceId":3},"deployment":null}')).toBeNull();
    expect(parseHeadlineBrief('{"binding":{"nimbusServiceId":null}}')).toBeNull(); // deployment key absent
    expect(
      parseHeadlineBrief('{"binding":{},"deployment":{"title":"D","startedAtMs":1,"finishedAtMs":"x"}}'),
    ).toBeNull(); // a nullable field with the WRONG TYPE still rejects
  });
  test("a MISSING nullable key reads as null rather than rejecting a real brief", () => {
    expect(
      parseHeadlineBrief('{"binding":{},"deployment":{"title":"D","startedAtMs":5}}'),
    ).toEqual({ nimbusServiceId: null, deployment: { title: "D", startedAtMs: 5, finishedAtMs: null } });
  });
});

describe("renderPushHeadline", () => {
  test("ok with a deployment: three lines, minutes before, the timing disclosure", async () => {
    const d = await realDelivery();
    const out = lines(renderPushHeadline(d));
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("P1 · payment-service — payment-service: 5xx rate above 5% on /v1/charges");
    expect(out[1]).toStartWith("Last deployment before the alert: ");
    // The seeded story deploy finishes ~8 minutes before the page (demo/corpus/acme.ts).
    expect(out[1]).toContain("(8 min before) — timing only, not a proven cause");
    expect(out[2]).toBe(
      "@nimbus agent oncall incidentId=pagerduty:PDEMO412  ·  locally: nimbus oncall pushed pagerduty:PDEMO412",
    );
  });

  test("the call to action parses through the REAL ChatOps agent grammar", async () => {
    const d = await realDelivery();
    const cmd = pushAgentCommand(d.row.incidentId);
    expect(renderPushHeadline(d)).toContain(cmd);
    expect(parseAgentCommand(cmd, new Set(EXTERNAL_AGENT_NAMES))).toEqual({
      ok: true,
      agent: "oncall",
      params: { incidentId: "pagerduty:PDEMO412" },
    });
  });

  test("finishedAtMs null falls back to startedAtMs; a deploy after the alert floors at 0", async () => {
    const d = await realDelivery();
    const opened = d.incident.openedAtMs ?? 0;
    const startedOnly = withBrief(d, {
      deployment: { title: "Deploy", startedAtMs: opened - 30 * 60_000, finishedAtMs: null },
    });
    expect(lines(renderPushHeadline(startedOnly))[1]).toContain("(30 min before)");
    const after = withBrief(d, {
      deployment: { title: "Deploy", startedAtMs: opened + 60_000, finishedAtMs: opened + 120_000 },
    });
    expect(lines(renderPushHeadline(after))[1]).toContain("(0 min before)");
  });

  test("openedAtMs null omits the minutes clause", async () => {
    const d = await realDelivery();
    const noOpen: PushDelivery = { ...d, incident: { ...d.incident, openedAtMs: null } };
    const l = lines(renderPushHeadline(noOpen))[1] ?? "";
    expect(l).not.toContain("min before");
    expect(l).toEndWith(" — timing only, not a proven cause");
  });

  test("no deployment", async () => {
    const d = withBrief(await realDelivery(), { deployment: null });
    expect(lines(renderPushHeadline(d))[1]).toBe("No deployment found before the alert");
  });

  test("a failed row and unusable JSON: could-not-be-assembled, with no second agent command", async () => {
    const d = await realDelivery();
    const failed: PushDelivery = {
      ...d,
      row: { ...d.row, status: "failed", briefJson: null, failureCode: "timeout: x" },
    };
    const malformed: PushDelivery = { ...d, row: { ...d.row, briefJson: "{oops" } };
    for (const x of [failed, malformed]) {
      const out = lines(renderPushHeadline(x));
      expect(out[1]).toBe("Brief could not be assembled; rerun the agent below to retry");
      expect(out[1]).not.toContain("@nimbus");
      expect(out[2]).toContain(pushAgentCommand(x.row.incidentId));
    }
  });

  test("service fallbacks: null AND empty fall through; then unknown service", async () => {
    const d = await realDelivery();
    const pd = d.incident.pagerdutyServiceId;
    for (const sid of [null, "", "   "]) {
      const x = withBrief(d, { binding: { nimbusServiceId: sid, pagerdutyServiceId: pd } });
      expect(lines(renderPushHeadline(x))[0]).toStartWith(`P1 · ${pd} — `);
    }
    const none: PushDelivery = {
      ...withBrief(d, { binding: { nimbusServiceId: null, pagerdutyServiceId: null } }),
      incident: { ...d.incident, pagerdutyServiceId: null },
    };
    expect(lines(renderPushHeadline(none))[0]).toStartWith("P1 · unknown service — ");
  });

  test("severity falls back to P1 when null or blank", async () => {
    const d = await realDelivery();
    for (const severity of [null, " "]) {
      const x: PushDelivery = { ...d, incident: { ...d.incident, severity } };
      expect(lines(renderPushHeadline(x))[0]).toStartWith("P1 · ");
    }
    const sev2: PushDelivery = { ...d, incident: { ...d.incident, severity: "SEV2" } };
    expect(lines(renderPushHeadline(sev2))[0]).toStartWith("SEV2 · ");
  });

  test("a hostile title renders inert", async () => {
    const d = await realDelivery();
    const x: PushDelivery = {
      ...d,
      incident: { ...d.incident, title: "DB down <!channel> <https://evil|Rollback docs> & more" },
    };
    const first = lines(renderPushHeadline(x))[0] ?? "";
    expect(first).not.toContain("<");
    expect(first).toContain("DB down &lt;!channel&gt; &lt;https://evil|Rollback docs&gt; &amp; more");
  });

  test("line breaks in either title cannot forge a line: still exactly three lines", async () => {
    const d = await realDelivery();
    const x: PushDelivery = {
      ...withBrief(d, {
        deployment: { title: "Deploy\r\nNo deployment found before the alert", startedAtMs: 1, finishedAtMs: 2 },
      }),
      incident: { ...d.incident, title: "a\nb\u2028c\td\u0085e" },
    };
    const out = lines(renderPushHeadline(x));
    expect(out).toHaveLength(3);
    expect(out[0]).toEndWith("— a b c d e");
    expect(out[1]).toContain("Deploy No deployment found before the alert");
    expect(out[1]).toEndWith(" — timing only, not a proven cause");
  });

  // Review Focus 1
  test("an empty or whitespace-only title renders (untitled)", async () => {
    const d = await realDelivery();
    for (const title of ["", " \n\t "]) {
      const x: PushDelivery = { ...d, incident: { ...d.incident, title } };
      expect(lines(renderPushHeadline(x))[0]).toEndWith("— (untitled)");
    }
  });

  // Review Focus 4
  test("an id with a control character renders escaped", async () => {
    const d = await realDelivery();
    const x: PushDelivery = { ...d, row: { ...d.row, incidentId: "pagerduty:P<&>" } };
    const third = lines(renderPushHeadline(x))[2] ?? "";
    expect(third).not.toContain("<");
    expect(third).toContain("incidentId=pagerduty:P&lt;&amp;&gt;");
  });
});

describe("oneLine", () => {
  // Review Focus 3
  test("removes bidi overrides, isolates, zero-width characters and the BOM", () => {
    expect(oneLine("abc\u202Edef\u2066g\u200Bh\uFEFF")).toBe("abcdefgh");
  });
  // Review Focus 2
  test("caps at FIELD_MAX_CODEPOINTS with an ellipsis, never splitting a surrogate pair", () => {
    const long = "😀".repeat(FIELD_MAX_CODEPOINTS + 5);
    const out = oneLine(long);
    expect(Array.from(out)).toHaveLength(FIELD_MAX_CODEPOINTS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no lone high surrogate
    expect(oneLine("short")).toBe("short");
  });
});

describe("renderPushSummary", () => {
  function fake(id: string, status: "ok" | "failed", base: PushDelivery): PushDelivery {
    return { ...base, row: { ...base.row, incidentId: id, status } };
  }
  test("N and M count ALL rows like the toast; the id list is the coalesced rest", async () => {
    const d = await realDelivery();
    const all = [
      fake("pagerduty:A", "ok", d),
      fake("pagerduty:B", "failed", d),
      fake("pagerduty:C", "ok", d),
      fake("pagerduty:D", "ok", d),
      fake("pagerduty:E", "failed", d),
    ];
    const rest = all.slice(3);
    expect(renderPushSummary(all, rest)).toBe(
      "5 P1 incidents paged (3 briefs ready). Not posted individually: pagerduty:D, pagerduty:E — @nimbus agent oncall incidentId=&lt;id&gt; for any of them",
    );
  });
  test("singular brief", async () => {
    const d = await realDelivery();
    const all = [fake("pagerduty:A", "ok", d), fake("pagerduty:B", "failed", d)];
    expect(renderPushSummary(all, all.slice(1))).toContain("(1 brief ready)");
  });
  // Review Focus 5
  test("all failed: 0 briefs ready, ids still listed", async () => {
    const d = await realDelivery();
    const all = [fake("pagerduty:A", "failed", d), fake("pagerduty:B", "failed", d)];
    const out = renderPushSummary(all, all);
    expect(out).toContain("(0 briefs ready)");
    expect(out).toContain("pagerduty:A, pagerduty:B");
  });
  test(`an incident storm lists ${SUMMARY_ID_CAP} ids, then names the local command`, async () => {
    const d = await realDelivery();
    const rest = Array.from({ length: 47 }, (_, i) => fake(`pagerduty:S${i}`, "ok", d));
    const out = renderPushSummary(rest, rest);
    expect(out).toContain("pagerduty:S9 … and 37 more (locally: nimbus oncall pushed list)");
    expect(out).not.toContain("pagerduty:S10,");
    expect(out).not.toContain("<");
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/oncall-push/push-headline.test.ts`
Expected: FAIL, `Cannot find module './push-headline.ts'`.

- [ ] **Step 3: Implement** `push-headline.ts`

```ts
import { escapeSlackText } from "../chatops/escape-outbound.ts";
import type { PushDelivery } from "./push-runner.ts";

/** Coalesced ids the summary post lists; the rest stay reachable locally (spec § 3). */
export const SUMMARY_ID_CAP = 10;
/** Per inserted field, in code points (spec § 3). */
export const FIELD_MAX_CODEPOINTS = 200;
const MINUTE_MS = 60_000;

// Format characters (bidi overrides/isolates, zero-width, BOM): removed, so the rendered line reads
// the same as its bytes. Controls (incl. \t \r \n U+0085) and line/paragraph separators: collapsed
// to one space, so a title cannot forge the headline's next line.
const FORMAT_RE = /\p{Cf}/gu;
const BREAK_RE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/** One display line of at most FIELD_MAX_CODEPOINTS code points. Escaping is a separate step. */
export function oneLine(s: string): string {
  const flat = s.replace(FORMAT_RE, "").replace(BREAK_RE, " ").trim();
  const cps = Array.from(flat);
  return cps.length <= FIELD_MAX_CODEPOINTS
    ? flat
    : `${cps.slice(0, FIELD_MAX_CODEPOINTS - 1).join("")}…`;
}

/** Every inserted value goes through here: normalise, cap, THEN escape (so a cut never splits an entity). */
function field(s: string): string {
  return escapeSlackText(oneLine(s));
}

function nonEmpty(s: string | null | undefined): string | undefined {
  if (s === null || s === undefined) return undefined;
  return oneLine(s) === "" ? undefined : s;
}

export type HeadlineBrief = {
  readonly nimbusServiceId: string | null;
  readonly deployment: {
    readonly title: string;
    readonly startedAtMs: number;
    readonly finishedAtMs: number | null;
  } | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The two fields the headline needs from a stored `OncallBrief` (the `briefReady` `findings`). There
 * is no decoder for the stored brief, so this narrows on its own. `null`, malformed JSON or the wrong
 * shape all mean "no brief". `deployment` must be PRESENT (null or an object); an absent key is the
 * wrong shape, not "no deployment".
 */
export function parseHeadlineBrief(json: string | null): HeadlineBrief | null {
  if (json === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(v) || !("deployment" in v)) return null;
  const binding = v["binding"];
  if (!isRecord(binding)) return null;
  // The two NULLABLE fields also accept a missing key, read as null. Today's writer always emits
  // both (`finished_at_ms` comes back from SQLite as null, never absent), but rejecting the whole
  // brief over a missing nullable field would print "could not be assembled" for a brief that
  // exists. Treating it as null lands on the spec's own fallbacks instead. A WRONG TYPE still
  // rejects.
  const sid = binding["nimbusServiceId"] ?? null;
  if (sid !== null && typeof sid !== "string") return null;
  const dep = v["deployment"];
  if (dep === null) return { nimbusServiceId: sid, deployment: null };
  if (!isRecord(dep)) return null;
  const title = dep["title"];
  const startedAtMs = dep["startedAtMs"];
  const finishedAtMs = dep["finishedAtMs"] ?? null;
  if (typeof title !== "string" || typeof startedAtMs !== "number") return null;
  if (finishedAtMs !== null && typeof finishedAtMs !== "number") return null;
  return { nimbusServiceId: sid, deployment: { title, startedAtMs, finishedAtMs } };
}

/** The ChatOps agent intent for one incident. The parameter is `incidentId` (ipc/agent-param-kinds.ts). */
export function pushAgentCommand(incidentId: string): string {
  return `@nimbus agent oncall incidentId=${field(incidentId)}`;
}

function deploymentLine(brief: HeadlineBrief | null, openedAtMs: number | null): string {
  if (brief === null) return "Brief could not be assembled; rerun the agent below to retry";
  const dep = brief.deployment;
  if (dep === null) return "No deployment found before the alert";
  const deployAt = dep.finishedAtMs ?? dep.startedAtMs;
  const when =
    openedAtMs === null
      ? ""
      : ` (${Math.max(0, Math.round((openedAtMs - deployAt) / MINUTE_MS))} min before)`;
  return `Last deployment before the alert: ${field(nonEmpty(dep.title) ?? "(untitled)")}${when} — timing only, not a proven cause`;
}

/** Spec § 3: at most three lines. Every inserted value is single-lined, capped and escaped. */
export function renderPushHeadline(d: PushDelivery): string {
  const brief = d.row.status === "ok" ? parseHeadlineBrief(d.row.briefJson) : null;
  const severity = nonEmpty(d.incident.severity) ?? "P1";
  const service =
    nonEmpty(brief?.nimbusServiceId) ?? nonEmpty(d.incident.pagerdutyServiceId) ?? "unknown service";
  const title = nonEmpty(d.incident.title) ?? "(untitled)";
  const id = d.row.incidentId;
  return [
    `${field(severity)} · ${field(service)} — ${field(title)}`,
    deploymentLine(brief, d.incident.openedAtMs),
    `${pushAgentCommand(id)}  ·  locally: nimbus oncall pushed ${field(id)}`,
  ].join("\n");
}

/**
 * The one post for rows past the cap. `N`/`M` count ALL rows, exactly as the toast summary does
 * (push-sinks.ts); the listed ids are `rest`, the rows that got no headline of their own.
 */
export function renderPushSummary(
  all: readonly PushDelivery[],
  rest: readonly PushDelivery[],
): string {
  const ready = all.filter((d) => d.row.status === "ok").length;
  const shown = rest.slice(0, SUMMARY_ID_CAP).map((d) => field(d.row.incidentId));
  const more = rest.length - shown.length;
  const list =
    more > 0
      ? `${shown.join(", ")} … and ${more} more (locally: nimbus oncall pushed list)`
      : shown.join(", ");
  // `<id>` is template text, but `<` would still start a Slack token, so it is escaped too.
  return `${all.length} P1 incidents paged (${ready} brief${ready === 1 ? "" : "s"} ready). Not posted individually: ${list} — ${escapeSlackText("@nimbus agent oncall incidentId=<id>")} for any of them`;
}
```

If the first fixture test fails because the real `briefJson` has no `binding`/`deployment` at the top level (that is, `findings` is not the `OncallBrief`), STOP and report. Do not change the parser to match a guess.

- [ ] **Step 4: Run them and confirm they pass**

Run: `bun test packages/gateway/src/oncall-push/push-headline.test.ts`
Expected: all pass. Then run `bun run typecheck && bun run lint`.

- [ ] **Step 5: Red-prove.** (a) Change `incidentId=` to `incident=` in `pushAgentCommand`: the parse round-trip test fails. (b) Remove `.replace(BREAK_RE, " ")`: the three-lines test fails. (c) Remove `field()` around the title in line 1: the hostile-title test fails. (d) Remove `?? null` from `finishedAtMs`: the missing-key test fails. Restore each.

- [ ] **Step 6: Commit** (`feat(oncall): render the pushed-brief ChatOps headline and summary`)

---

### Task 4: The ledgered post path (`pushedBrief` kind, dispatcher count, `postPushedBrief`)

**Files:**
- Modify: `packages/gateway/src/egress/chatops-egress.ts`
- Modify: `packages/gateway/src/chatops/reply-dispatcher.ts`
- Modify: `packages/gateway/src/chatops/chatops-boot.ts`
- Test: `packages/gateway/src/egress/chatops-egress.test.ts`, `packages/gateway/src/chatops/reply-dispatcher.test.ts`, `packages/gateway/src/chatops/chatops-boot.test.ts`

**Interfaces:**
- Produces: `ChatPostKind` = `"reply" | "approvalCard" | "agentBrief" | "pushedBrief"`, and `buildLedgeredChatPosts(...)` now returns `{ reply, approvalCard, agentBrief, pushedBrief }`.
- Produces: `ReplyDispatcher.send(target, text): Promise<number>`
- Produces: `ChatopsBoot.postPushedBrief(namespace: string, text: string): Promise<number>`

- [ ] **Step 1: Write the failing tests**

In `chatops-egress.test.ts`, extend the first test. Add `await posts.pushedBrief("slack", "C123", "P1 · svc — t");` after the `agentBrief` line, append `"chatops.pushedBrief"` to the expected methods and `"slack"` to the expected destinations. Then add:

```ts
  test("pushedBrief stores the byte count, never the headline text", async () => {
    const s = spy();
    await buildLedgeredChatPosts(db, s.fn, SALT).pushedBrief("slack", "C1", "SECRET-HEADLINE-TEXT");
    const rows = listEgress(db, { limit: 10 });
    expect(rows.map((r) => r.method)).toEqual(["chatops.pushedBrief"]);
    expect(JSON.stringify(rows)).not.toContain("SECRET-HEADLINE-TEXT");
    expect(s.calls).toHaveLength(1);
  });
```

In `reply-dispatcher.test.ts`, add:

```ts
  test("send resolves to the number of channels posted to: 1, N and 0", async () => {
    const posted: string[] = [];
    const d = new ReplyDispatcher({
      post: async (_p, channelId) => {
        posted.push(channelId);
      },
      notifyChannelsFor: (ns) => (ns === "two" ? ["C_A", "C_B"] : []),
    });
    expect(await d.send({ kind: "originating", platform: "slack", channelId: "C_O" }, "x")).toBe(1);
    expect(await d.send({ kind: "namespaceNotify", namespace: "two" }, "x")).toBe(2);
    expect(await d.send({ kind: "namespaceNotify", namespace: "none" }, "x")).toBe(0);
    expect(posted).toEqual(["C_O", "C_A", "C_B"]);
  });
```

In `chatops-boot.test.ts`, inside `describe("buildChatopsBoot — full production graph", …)`. The harness policy maps `C0` to namespace `project:pay` with `notify: ["C_ALERT"]`.

```ts
  test("postPushedBrief posts to the namespace's notify channels and ledgers chatops.pushedBrief", async () => {
    const h = await buildHarness();
    expect(await h.boot.postPushedBrief("project:pay", "P1 · svc — title")).toBe(1);
    expect(h.posts.map((p) => p.channel)).toEqual(["C_ALERT"]);
    const rows = listEgress(db, { limit: 10 });
    expect(rows.map((r) => r.method)).toEqual(["chatops.pushedBrief"]);
  });

  test("postPushedBrief to a namespace with no notify channels posts nothing, ledgers nothing, resolves 0", async () => {
    const h = await buildHarness();
    expect(await h.boot.postPushedBrief("project:none", "x")).toBe(0);
    expect(h.posts).toHaveLength(0);
    expect(listEgress(db, { limit: 10 })).toHaveLength(0);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/egress/chatops-egress.test.ts packages/gateway/src/chatops/reply-dispatcher.test.ts packages/gateway/src/chatops/chatops-boot.test.ts`
Expected: FAIL (`pushedBrief` / `postPushedBrief` undefined; `send` resolves `undefined`).

- [ ] **Step 3: Implement**

`chatops-egress.ts`:

```ts
export type ChatPostKind = "reply" | "approvalCard" | "agentBrief" | "pushedBrief";
```

Add `pushedBrief: "chatops.pushedBrief",` to `METHOD_FOR`, and add `pushedBrief: wrap("pushedBrief"),` to the returned frozen object.

`reply-dispatcher.ts`, replacing `send`:

```ts
  /**
   * Resolves to the number of channels posted to: 1 for `originating`, N for `namespaceNotify` (0
   * when the namespace has no notify channels). Channels are posted in turn and a throw stops the
   * rest, so a caller seeing a rejection must treat delivery as possibly partial.
   */
  async send(target: ReplyTarget, text: string): Promise<number> {
    if (target.kind === "originating") {
      await this.deps.post(target.platform, target.channelId, text);
      return 1;
    }
    let posted = 0;
    for (const channelId of this.deps.notifyChannelsFor(target.namespace)) {
      await this.deps.post("slack", channelId, text);
      posted += 1;
    }
    return posted;
  }
```

`chatops-boot.ts`. In `interface ChatopsBoot`, after `replyTo`:

```ts
  /**
   * The on-call pushed brief's headline (oncall-push PR 2). Posts to every policy `notify` channel
   * of `namespace` through `posts.pushedBrief` (ledgered `chatops.pushedBrief`, I29) and resolves to
   * the number of channels posted to, 0 when the namespace has none. The destination is
   * server-derived (I23): the caller names a namespace from its own config, never a channel.
   */
  postPushedBrief(namespace: string, text: string): Promise<number>;
```

After `const agentBriefDispatcher = …`:

```ts
  // I23: the pushed-brief counterpart. Same dispatcher shape, ledgered as `chatops.pushedBrief`.
  const pushedBriefDispatcher = new ReplyDispatcher({ post: posts.pushedBrief, notifyChannelsFor });
```

In the returned object, replace the `replyTo` line and add `postPushedBrief`:

```ts
    replyTo: async (target, text) => {
      await replyDispatcher.send(target, text);
    },
    postPushedBrief: (namespace, text) =>
      pushedBriefDispatcher.send({ kind: "namespaceNotify", namespace }, text),
```

- [ ] **Step 4: Run them and confirm they pass**

Run the three test files from Step 2, then `bun test packages/gateway/src/chatops packages/gateway/src/egress` and `bun run typecheck`. Expected: all pass. A typecheck failure in a file building a full `ChatopsBoot` literal gets `postPushedBrief: async () => 0`.

- [ ] **Step 5: Static check.** Run `bun run audit:invariants`. Expected: clean. D17 must still see exactly one `buildLedgeredChatPosts(…buildConnectorPost(…)…)` and no new `buildConnectorPost`.

- [ ] **Step 6: Red-prove.** Swap `posts.pushedBrief` for `posts.reply` in `pushedBriefDispatcher`. The boot test fails on the method name. Restore.

- [ ] **Step 7: Commit** (`feat(chatops): ledgered pushedBrief post kind and ChatopsBoot.postPushedBrief`)

---

### Task 5: The `chatops` sink, wired into the runtime

**Files:**
- Modify: `packages/gateway/src/oncall-push/push-sinks.ts`
- Modify: `packages/gateway/src/oncall-push/push-runtime.ts`
- Test: `packages/gateway/src/oncall-push/push-sinks.test.ts`, `packages/gateway/src/oncall-push/push-runtime.test.ts`

**Interfaces:**
- Consumes: `renderPushHeadline` and `renderPushSummary` (Task 3), `ChatopsPoster` (Task 2).
- Produces, in `push-sinks.ts`:
  - `export const NO_NAMESPACE_REASON = "no [oncall.push] chatops_namespace"`
  - `export const CHATOPS_NOT_RUNNING_REASON = "ChatOps not running"`
  - `export interface ChatopsSinkDeps { readonly namespace: string; readonly post: () => ChatopsPoster | undefined }`
  - `PushSinkDeps` gains `readonly chatops?: ChatopsSinkDeps` and `readonly warn?: (msg: string, fields: Record<string, string>) => void`.

- [ ] **Step 1: Write the failing tests** (append to `push-sinks.test.ts`; `item()` exists there)

```ts
import { renderPushHeadline, renderPushSummary } from "./push-headline.ts";
import { CHATOPS_NOT_RUNNING_REASON, NO_NAMESPACE_REASON } from "./push-sinks.ts";
// (merge into the existing import lines)

const NS = "project:pay";
function chatDeliverer(
  post: ((text: string) => Promise<number>) | undefined,
  over: { namespace?: string; notifyDelivers?: boolean; notify?: () => void; warn?: (m: string, f: Record<string, string>) => void } = {},
) {
  return createPushDeliverer({
    store,
    notify: over.notify ?? (() => {}),
    ...(over.notifyDelivers === undefined ? {} : { notifyDelivers: over.notifyDelivers }),
    emit: () => {},
    now: () => 7,
    chatops: { namespace: over.namespace ?? NS, post: () => post },
    ...(over.warn === undefined ? {} : { warn: over.warn }),
  });
}

test("chatops: an empty namespace skips every row and never posts", async () => {
  let calls = 0;
  await chatDeliverer(async () => (calls += 1), { namespace: "" })([item("pagerduty:A", "ok", 1)]);
  expect(calls).toBe(0);
  expect(store.get("pagerduty:A")?.delivery["chatops"]).toEqual({
    outcome: "skipped",
    reason: NO_NAMESPACE_REASON,
    at: 7,
  });
});

test("chatops: an unbound poster skips every row", async () => {
  await chatDeliverer(undefined)([item("pagerduty:A", "ok", 1), item("pagerduty:B", "ok", 2)]);
  for (const id of ["pagerduty:A", "pagerduty:B"]) {
    expect(store.get(id)?.delivery["chatops"]).toMatchObject({
      outcome: "skipped",
      reason: CHATOPS_NOT_RUNNING_REASON,
    });
  }
});

test("chatops: 0 channels → skipped with the namespace named; N → delivered with the real headline", async () => {
  const a = item("pagerduty:A", "ok", 1);
  await chatDeliverer(async () => 0)([a]);
  expect(store.get("pagerduty:A")?.delivery["chatops"]).toMatchObject({
    outcome: "skipped",
    reason: `namespace ${NS} has no notify channels`,
  });
  const texts: string[] = [];
  const b = item("pagerduty:B", "ok", 1);
  await chatDeliverer(async (t) => {
    texts.push(t);
    return 2;
  })([b]);
  expect(texts).toEqual([renderPushHeadline(b)]);
  expect(store.get("pagerduty:B")?.delivery["chatops"]).toEqual({ outcome: "delivered", at: 7 });
});

test("chatops: a throwing post is failed, says partial, is warned once, and the toast still runs", async () => {
  const warns: [string, Record<string, string>][] = [];
  const toasts: number[] = [];
  await chatDeliverer(
    async () => {
      throw new Error("boom");
    },
    { notify: () => void toasts.push(1), warn: (m, f) => void warns.push([m, f]) },
  )([item("pagerduty:A", "ok", 1)]);
  expect(store.get("pagerduty:A")?.delivery["chatops"]).toMatchObject({
    outcome: "failed",
    reason: "boom (delivery may be partial)",
  });
  expect(warns).toEqual([
    ["[oncall.push] chatops post failed", { incidentId: "pagerduty:A", reason: "boom (delivery may be partial)" }],
  ]);
  expect(toasts).toHaveLength(1);
});

test("chatops: a throwing toast does not stop the chat post", async () => {
  let posted = 0;
  await chatDeliverer(async () => (posted += 1), {
    notify: () => {
      throw new Error("toast down");
    },
  })([item("pagerduty:A", "ok", 1)]);
  expect(posted).toBe(1);
  expect(store.get("pagerduty:A")?.delivery["toast"]?.outcome).toBe("failed");
});

test("chatops: posts even when notifyDelivers is false", async () => {
  let posted = 0;
  await chatDeliverer(async () => (posted += 1), { notifyDelivers: false })([
    item("pagerduty:A", "ok", 1),
  ]);
  expect(posted).toBe(1);
  expect(store.get("pagerduty:A")?.delivery["toast"]?.outcome).toBe("skipped");
  expect(store.get("pagerduty:A")?.delivery["chatops"]?.outcome).toBe("delivered");
});

test(`chatops: past ${PUSH_NOTIFY_CAP}, newest-first headlines then ONE summary; rest coalesced`, async () => {
  const items = [1, 5, 3, 4, 2].map((n) => item(`pagerduty:${n}`, "ok", n));
  const texts: string[] = [];
  await chatDeliverer(async (t) => {
    texts.push(t);
    return 1;
  })(items);
  const byId = (id: string) => items.find((d) => d.row.incidentId === id) as (typeof items)[number];
  expect(texts).toEqual([
    renderPushHeadline(byId("pagerduty:5")),
    renderPushHeadline(byId("pagerduty:4")),
    renderPushHeadline(byId("pagerduty:3")),
    renderPushSummary(items, [byId("pagerduty:2"), byId("pagerduty:1")]),
  ]);
  for (const id of ["pagerduty:2", "pagerduty:1"]) {
    expect(store.get(id)?.delivery["chatops"]).toEqual({ outcome: "coalesced", at: 7 });
  }
});

test("chatops: a summary that reaches 0 channels marks the rest skipped, not coalesced", async () => {
  const items = [1, 2, 3, 4].map((n) => item(`pagerduty:${n}`, "ok", n));
  await chatDeliverer(async () => 0)(items);
  expect(store.get("pagerduty:1")?.delivery["chatops"]).toMatchObject({
    outcome: "skipped",
    reason: `namespace ${NS} has no notify channels`,
  });
});

test("chatops: a failed summary post marks the rest coalesced with the reason, and warns per row", async () => {
  const items = [1, 2, 3, 4, 5].map((n) => item(`pagerduty:${n}`, "ok", n));
  let n = 0;
  const warns: string[] = [];
  await chatDeliverer(
    async () => {
      n += 1;
      if (n === 4) throw new Error("rate limited");
      return 1;
    },
    { warn: (_m, f) => void warns.push(f["incidentId"] ?? "") },
  )(items);
  for (const id of ["pagerduty:2", "pagerduty:1"]) {
    expect(store.get(id)?.delivery["chatops"]).toMatchObject({
      outcome: "coalesced",
      reason: "summary post failed: rate limited (delivery may be partial)",
    });
  }
  expect(warns).toEqual(["pagerduty:2", "pagerduty:1"]);
});

test("chatops: the poster is read at delivery time, so a later binding is seen", async () => {
  let bound: ((t: string) => Promise<number>) | undefined;
  const deliver = createPushDeliverer({
    store,
    notify: () => {},
    emit: () => {},
    now: () => 7,
    chatops: { namespace: NS, post: () => bound },
  });
  let posted = 0;
  bound = async () => (posted += 1);
  await deliver([item("pagerduty:A", "ok", 1)]);
  expect(posted).toBe(1);
});
```

Append to `push-runtime.test.ts`:

```ts
test("a run settled with a poster posts the headline through it and records delivered", async () => {
  const meId = seedP1("PCHAT");
  writeFileSync(
    join(configDir, "nimbus.toml"),
    `[user]\nme_person_id = "${meId}"\n\n[oncall.push]\nenabled = true\nchatops_namespace = "project:pay"\n`,
  );
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    localIndex: new LocalIndex(db),
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => T0 - 1000,
  });
  const texts: string[] = [];
  rt.settleChatopsPoster(async (t) => {
    texts.push(t);
    return 1;
  });
  await rt.run("pagerduty");
  expect(texts).toHaveLength(1);
  // Real writer: PSVC is unmapped to a Nimbus service, so the PagerDuty id is the service label.
  expect(texts[0]?.split("\n")[0]).toBe("P1 · PSVC — inc PCHAT");
  expect(rt.store.get("pagerduty:PCHAT")?.delivery["chatops"]?.outcome).toBe("delivered");
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/oncall-push/push-sinks.test.ts packages/gateway/src/oncall-push/push-runtime.test.ts`
Expected: FAIL (no `chatops` dep, no exported reasons).

- [ ] **Step 3: Implement**

In `push-sinks.ts`, add `import { renderPushHeadline, renderPushSummary } from "./push-headline.ts";`, then:

```ts
export const NO_NAMESPACE_REASON = "no [oncall.push] chatops_namespace";
export const CHATOPS_NOT_RUNNING_REASON = "ChatOps not running";
const noChannelsReason = (ns: string): string => `namespace ${ns} has no notify channels`;

export interface ChatopsSinkDeps {
  /** `[oncall.push] chatops_namespace`; `""` means not configured. */
  readonly namespace: string;
  /**
   * Read at DELIVERY time, never at construction: the runtime builds the deliverer before ChatOps
   * boots and binds the poster later (spec § 2.1). `undefined` means ChatOps is not running.
   */
  readonly post: () => ChatopsPoster | undefined;
}
```

Add to `PushSinkDeps`:

```ts
  /** Absent: no chatops sink and no `chatops` delivery record (PR 1 callers). */
  readonly chatops?: ChatopsSinkDeps;
  /** Spec § 4: a `failed` chat outcome is also logged. Fields never carry the headline text. */
  readonly warn?: (msg: string, fields: Record<string, string>) => void;
```

Add a chat attempt next to `attempt`:

```ts
/** Like `attempt`, but a post that reached 0 channels is `skipped`, and any throw may be partial. */
async function chatAttempt(post: ChatopsPoster, text: string, ns: string): Promise<Attempt> {
  try {
    const sent = await post(text);
    return sent === 0 ? { outcome: "skipped", reason: noChannelsReason(ns) } : { outcome: "delivered" };
  } catch (e) {
    return { outcome: "failed", reason: `${errText(e)} (delivery may be partial)` };
  }
}
```

In `createPushDeliverer`, after the `record` helper:

```ts
  const warnFailed = (incidentId: string, reason: string | undefined): void => {
    try {
      deps.warn?.("[oncall.push] chatops post failed", { incidentId, reason: reason ?? "" });
    } catch {
      // A logger that throws must not stop the remaining sinks.
    }
  };

  const chatSink = async (
    c: ChatopsSinkDeps,
    items: readonly PushDelivery[],
    newestFirst: readonly PushDelivery[],
  ): Promise<void> => {
    const skipAll = (reason: string): void => {
      for (const d of items) record(d.row.incidentId, "chatops", { outcome: "skipped", reason });
    };
    if (c.namespace === "") return skipAll(NO_NAMESPACE_REASON);
    const post = c.post();
    if (post === undefined) return skipAll(CHATOPS_NOT_RUNNING_REASON);
    for (const d of newestFirst.slice(0, PUSH_NOTIFY_CAP)) {
      const o = await chatAttempt(post, renderPushHeadline(d), c.namespace);
      record(d.row.incidentId, "chatops", o);
      if (o.outcome === "failed") warnFailed(d.row.incidentId, o.reason);
    }
    const rest = newestFirst.slice(PUSH_NOTIFY_CAP);
    if (rest.length === 0) return;
    const s = await chatAttempt(post, renderPushSummary(items, rest), c.namespace);
    const o: Attempt =
      s.outcome === "delivered"
        ? { outcome: "coalesced" }
        : s.outcome === "skipped"
          ? s
          : { outcome: "coalesced", reason: `summary post failed: ${s.reason ?? ""}` };
    for (const d of rest) {
      record(d.row.incidentId, "chatops", o);
      if (s.outcome === "failed") warnFailed(d.row.incidentId, o.reason);
    }
  };
```

In the returned async function, compute `newestFirst` ONCE, before the `notifyDelivers` early return, and run the chat sink between the event loop and that return:

```ts
    const newestFirst = [...items].sort(
      (a, b) => (b.incident.openedAtMs ?? 0) - (a.incident.openedAtMs ?? 0),
    );
    // Spec § 2.2: BEFORE the toast's "no notifier" early return, so chat does not depend on it.
    if (deps.chatops !== undefined) await chatSink(deps.chatops, items, newestFirst);
    if (deps.notifyDelivers === false) {
```

Delete the later `const newestFirst = …` declaration so the toast code uses the shared one.

In `push-runtime.ts`, add to the `createPushDeliverer({ … })` literal:

```ts
      chatops: { namespace: config.chatopsNamespace, post: () => chatopsPoster },
      warn: (msg, fields) => deps.logger.warn?.(fields, msg),
```

`chatopsPoster` is now declared before `runner`. Move the Task 2 gate block above `const runner = …` if it is not there already. Keep `deps.logger.warn?.(…)` as a method call. Destructuring `warn` would lose pino's `this`.

Update the header comment of `config/oncall-push-toml.ts`. Replace "`chatops_namespace` is parsed here so PR 1's config surface is complete, but it has no consumer until the ChatOps sink lands (PR 2)." with: "`chatops_namespace` names the namespace whose policy `notify` channels receive the pushed headline (the ChatOps sink, `oncall-push/push-sinks.ts`); `""` posts nothing."

- [ ] **Step 4: Run them and confirm they pass**

Run: `bun test packages/gateway/src/oncall-push`, then `bun run typecheck && bun run lint`.
Expected: all pass, including PR 1's existing sink tests unchanged (no `chatops` dep means no `chatops` key).

- [ ] **Step 5: Red-prove.** (a) Move the `chatSink` call below the `notifyDelivers === false` return: the "posts even when notifyDelivers is false" test fails. (b) Read `c.post` at construction instead of in `chatSink`: the lazy-binding test fails. (c) Map a 0-channel summary to `coalesced`: the 0-channel summary test fails. Restore each.

- [ ] **Step 6: Commit** (`feat(oncall): post the pushed brief's headline to the ChatOps notify channels`)

---

### Task 6: Bind the poster in assembly

**Files:**
- Modify: `packages/gateway/src/platform/assemble.ts`
- Modify: `packages/gateway/src/platform/types.ts`
- Test: `packages/gateway/src/platform/assemble.test.ts`

**Interfaces:**
- Produces: `export function settleOncallPushChatops(oncallPush: Pick<OncallPushRuntime, "settleChatopsPoster" | "config">, chatopsBoot: Pick<ChatopsBoot, "postPushedBrief"> | undefined): void`
- Produces: `PlatformServices.oncallPush: OncallPushRuntime`

- [ ] **Step 1: Write the failing tests**

In `assemble.test.ts`, import `settleOncallPushChatops` alongside the file's existing `./assemble.ts` imports. Import `DEFAULT_ONCALL_PUSH_CONFIG` from `../config/oncall-push-toml.ts` and `type ChatopsPoster` from `../oncall-push/push-sinks.ts`. Then add:

```ts
describe("settleOncallPushChatops (spec § 4 boot race)", () => {
  it("binds a poster that posts to the CONFIGURED namespace when ChatOps booted", async () => {
    const settled: Array<ChatopsPoster | undefined> = [];
    const calls: Array<[string, string]> = [];
    settleOncallPushChatops(
      {
        config: { ...DEFAULT_ONCALL_PUSH_CONFIG, chatopsNamespace: "project:pay" },
        settleChatopsPoster: (p) => void settled.push(p),
      },
      {
        postPushedBrief: async (ns, text) => {
          calls.push([ns, text]);
          return 1;
        },
      },
    );
    expect(settled).toHaveLength(1);
    expect(await settled[0]?.("hi")).toBe(1);
    expect(calls).toEqual([["project:pay", "hi"]]);
  });

  it("settles with undefined when ChatOps did not boot, so held runs are released", () => {
    const settled: Array<ChatopsPoster | undefined> = [];
    settleOncallPushChatops(
      { config: DEFAULT_ONCALL_PUSH_CONFIG, settleChatopsPoster: (p) => void settled.push(p) },
      undefined,
    );
    expect(settled).toEqual([undefined]);
  });
});
```

In the in-process block, add `expect(services.oncallPush.chatopsSinkState()).toBe("bound");` to "boots the ChatOps graph when [chatops].enabled…" and `expect(services.oncallPush.chatopsSinkState()).toBe("none");` to "does not boot ChatOps when [chatops] is absent".

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/platform/assemble.test.ts`
Expected: FAIL (`settleOncallPushChatops` is not exported; `services.oncallPush` is undefined).

- [ ] **Step 3: Implement**

In `assemble.ts`, near `bootChatopsAgentInvoker`:

```ts
/**
 * Spec § 4 (boot race): the ONE place the on-call push learns whether ChatOps exists. Called right
 * after `bootChatopsIntoAssembly` on BOTH branches. Until it runs, the push runtime holds every
 * run, so a PagerDuty sync that completes during boot is delivered after this, never dropped.
 */
export function settleOncallPushChatops(
  oncallPush: Pick<OncallPushRuntime, "settleChatopsPoster" | "config">,
  chatopsBoot: Pick<ChatopsBoot, "postPushedBrief"> | undefined,
): void {
  if (chatopsBoot === undefined) {
    oncallPush.settleChatopsPoster(undefined);
    return;
  }
  const namespace = oncallPush.config.chatopsNamespace;
  oncallPush.settleChatopsPoster((text) => chatopsBoot.postPushedBrief(namespace, text));
}
```

Replace Task 2's temporary two lines (comment plus call) with:

```ts
  settleOncallPushChatops(oncallPush, chatopsBoot);
```

Add `oncallPush,` to the returned `PlatformServices` object, next to `askExplainRecorder`.

In `platform/types.ts`, add `import type { OncallPushRuntime } from "../oncall-push/push-runtime.ts";` and the field:

```ts
  /**
   * The on-call pushed brief runtime. Exposed so the assembly test can assert the ChatOps poster
   * was settled (`chatopsSinkState()`); the IPC surface reaches it through `oncallPushRpcCtx`.
   */
  oncallPush: OncallPushRuntime;
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `bun test packages/gateway/src/platform/assemble.test.ts packages/gateway/src/platform/chatops-agent-invoker-boot.test.ts`, then `bun run typecheck`.
Expected: pass.

- [ ] **Step 5: Red-prove.** Comment out the `settleOncallPushChatops(oncallPush, chatopsBoot);` call. Both in-process assertions read `"pending"`. Restore.

- [ ] **Step 6: Commit** (`feat(oncall): settle the push runtime's ChatOps poster at assembly`)

---

### Task 7: I41: no ChatOps in a demo gateway

The triple rule applies: wiring, docs and the invariant test change in ONE commit.

**Files:**
- Modify: `packages/gateway/src/platform/demo-boot.ts`, `packages/gateway/src/platform/assemble.ts`
- Modify (tests): `packages/gateway/src/platform/demo-boot.test.ts`, `packages/gateway/src/security-invariants.test.ts`, `packages/gateway/src/platform/assemble.test.ts`
- Modify (docs): `docs/SECURITY-INVARIANTS.md` (I41 statement, clause 6), `CLAUDE.md` and `GEMINI.md` (I41 bullet)

**Interfaces:**
- Produces: `BootPolicy.chatops: boolean` (`!demo`)
- `bootChatopsIntoAssembly` deps gain `chatopsAllowedByBootPolicy: boolean`.

- [ ] **Step 1: Write the failing tests**

In `security-invariants.test.ts`, I41 "clause 4" test: add `chatops: true,` to the `real` expected object and `chatops: false,` to the `demo` one. Add after "clause 6 wiring: assemble.ts gates the updater…":

```ts
  test("clause 6 wiring: ChatOps boots only when the boot policy allows it", async () => {
    const src = await read("packages/gateway/src/platform/assemble.ts");
    // One call (plus the definition), handed the policy flag; the guard returns before building anything.
    expect(src.match(/(?<!function )bootChatopsIntoAssembly\(/g)?.length).toBe(1);
    expect(src).toContain("chatopsAllowedByBootPolicy: bootPolicy.chatops,");
    expect(src).toMatch(/if \(!chatopsCfg\.enabled \|\| !chatopsAllowedByBootPolicy\) return undefined;/);
  });
```

In `demo-boot.test.ts`, add `chatops: true` and `chatops: false` to its two expected objects (around lines 19 and 31).

In `assemble.test.ts`'s in-process block:

```ts
  it("a demo-rooted assembly does not boot ChatOps even with [chatops] enabled (I41)", async () => {
    const paths: PlatformPaths = { ...makePaths(), demo: true };
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(
      join(paths.configDir, "nimbus.toml"),
      ["[chatops]", "enabled = true", "slack_enabled = true", 'bot_vault_entry = "test-bot"'].join("\n"),
    );
    services = await assemblePlatformServices(paths, makeInMemoryVault());
    expect(services.chatops).toBeUndefined();
    expect(services.oncallPush.chatopsSinkState()).toBe("none");
  }, 30000);
```

If an in-process demo assembly fails for a reason unrelated to ChatOps (another demo guard), do not work around it. Drop this one test, keep the static pin, and say so in the task report.

- [ ] **Step 2: Run them and confirm they fail**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I41" && bun test packages/gateway/src/platform/demo-boot.test.ts packages/gateway/src/platform/assemble.test.ts`
Expected: FAIL (no `chatops` key; ChatOps boots in demo).

- [ ] **Step 3: Implement**

`demo-boot.ts`: add `readonly chatops: boolean;` to `BootPolicy` and `chatops: !demo,` to `bootPolicyFor`. Add a bullet to the doc comment's list:

```
 * - `chatops`: a `[chatops]` bot opens an outbound Slack/Teams socket and posts. A demo config has
 *   no `[chatops]` section, but that is config, not construction — and the on-call push would
 *   post a demo page's headline through it.
```

`assemble.ts`: in `bootChatopsIntoAssembly`'s deps type, add `chatopsAllowedByBootPolicy: boolean;`. Destructure it, then replace `if (!chatopsCfg.enabled) return undefined;` with:

```ts
  // I41: a demo gateway never boots ChatOps, whatever its config says (BootPolicy.chatops).
  if (!chatopsCfg.enabled || !chatopsAllowedByBootPolicy) return undefined;
```

At the call site, add `chatopsAllowedByBootPolicy: bootPolicy.chatops,` to the argument object. `bootPolicy` is the `const bootPolicy = bootPolicyFor(paths);` already in scope.

Docs:
- `docs/SECURITY-INVARIANTS.md`, I41 statement clause (6): after "and the extension auto-update daemon", insert ", and ChatOps (`bootChatopsIntoAssembly` returns before building the bot, even with `[chatops] enabled`)".
- `CLAUDE.md` and `GEMINI.md`, I41 bullet: "it skips the updater startup check, the telemetry flush, the embedding runtime and the extension auto-update daemon;" becomes "it skips the updater startup check, the telemetry flush, the embedding runtime, the extension auto-update daemon and ChatOps;". In the same bullet's "guarded call sites (reap, sidecars, sync-scheduler start, updater, telemetry, extensions auto-update)", add ", ChatOps" before the closing parenthesis. Make both files byte-identical in that bullet (`diff <(grep "I41" CLAUDE.md) <(grep "I41" GEMINI.md)` shows no I41 difference).

- [ ] **Step 4: Run them and confirm they pass**

Run the Step 2 commands, then `bun run typecheck && bun run audit:doc-refs && bun run audit:status-drift`.
Expected: pass.

- [ ] **Step 5: Red-prove.** Set `chatops: true` unconditionally in `bootPolicyFor`. The clause-4 test and the demo assembly test fail. Restore.

- [ ] **Step 6: Commit** (`fix(demo): never boot ChatOps in a demo gateway (I41)`). Code, tests and docs go in this ONE commit.

---

### Task 8: Integration test: real DB, real seed, real ledger, two channels

**Files:**
- Create: `packages/gateway/src/oncall-push/push-chatops.integration.test.ts`
- Modify: `packages/gateway/src/demo/seed.test.ts` (one assertion)

**Interfaces:**
- Consumes everything above. Produces tests only.

- [ ] **Step 1: Write the tests**

```ts
// The whole outbound path with no fake in the middle: the real demo seed and page, the real
// runtime and sink, a real `ReplyDispatcher` over the real `buildLedgeredChatPosts` appender on a
// real migrated DB. Only the connector post at the far end is a recorder.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ReplyDispatcher } from "../chatops/reply-dispatcher.ts";
import type { ChatPlatform } from "../chatops/types.ts";
import { fireDemoPage, seedDemoCorpus } from "../demo/seed.ts";
import { buildLedgeredChatPosts } from "../egress/chatops-egress.ts";
import { listEgress } from "../egress/egress-verify.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { assembleOncallPushRuntime } from "./push-runtime.ts";

const SALT = Buffer.alloc(32, 9).toString("base64");
const NS = "project:pay";
let dbs: Database[] = [];
let roots: string[] = [];
afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

async function seeded(): Promise<{ db: Database; configDir: string; nowMs: number }> {
  const root = mkdtempSync(join(tmpdir(), "nimbus-push-chatops-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  const nowMs = Date.now();
  await seedDemoCorpus(db, { configDir, dataDir, nowMs });
  // The demo config enables push with no namespace; name one, as an owner would.
  const toml = join(configDir, "nimbus.toml");
  writeFileSync(toml, `${readFileSync(toml, "utf8")}chatops_namespace = "${NS}"\n`);
  return { db, configDir, nowMs };
}

test("a pushed headline to a namespace with two notify channels appends two rows, each BEFORE its post", async () => {
  const { db, configDir, nowMs } = await seeded();
  const rowsAtPost: number[] = [];
  const raw = async (_p: ChatPlatform, _c: string, _t: string): Promise<void> => {
    rowsAtPost.push(listEgress(db, { limit: 50 }).filter((r) => r.sourceType === "chatops").length);
  };
  const dispatcher = new ReplyDispatcher({
    post: buildLedgeredChatPosts(db, raw, SALT).pushedBrief,
    notifyChannelsFor: (ns) => (ns === NS ? ["C_A", "C_B"] : []),
  });
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
  });
  rt.settleChatopsPoster((text) => dispatcher.send({ kind: "namespaceNotify", namespace: NS }, text));
  const fired = await fireDemoPage(db, rt, nowMs);

  expect(rowsAtPost).toEqual([1, 2]); // the row for each post existed before that post ran
  const chat = listEgress(db, { limit: 50 }).filter((r) => r.sourceType === "chatops");
  expect(chat.map((r) => r.method)).toEqual(["chatops.pushedBrief", "chatops.pushedBrief"]);
  expect(rt.store.get(fired.incidentId)?.delivery["chatops"]?.outcome).toBe("delivered");
});

test("an append failure posts NOTHING and records failed", async () => {
  const { db, configDir, nowMs } = await seeded();
  const ledger = new Database(":memory:");
  ledger.close(); // every append fails
  let posts = 0;
  const dispatcher = new ReplyDispatcher({
    post: buildLedgeredChatPosts(
      ledger,
      async () => {
        posts += 1;
      },
      SALT,
    ).pushedBrief,
    notifyChannelsFor: () => ["C_A", "C_B"],
  });
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
  });
  rt.settleChatopsPoster((text) => dispatcher.send({ kind: "namespaceNotify", namespace: NS }, text));
  const fired = await fireDemoPage(db, rt, nowMs);
  expect(posts).toBe(0);
  const o = rt.store.get(fired.incidentId)?.delivery["chatops"];
  expect(o?.outcome).toBe("failed");
  expect(o?.reason).toEndWith("(delivery may be partial)");
});
```

In `demo/seed.test.ts`, in "with the PRODUCTION notifier (delivers: false)…", after the toast assertion:

```ts
    // The demo config names no ChatOps namespace, so the chat sink posts nothing (I41).
    expect(rt.store.get("pagerduty:PDEMO412")?.delivery["chatops"]).toMatchObject({
      outcome: "skipped",
      reason: "no [oncall.push] chatops_namespace",
    });
```

- [ ] **Step 2: Run them**

Run: `bun test packages/gateway/src/oncall-push/push-chatops.integration.test.ts packages/gateway/src/demo/seed.test.ts`
Expected: pass. They exercise code from Tasks 2–5. If one fails, the defect is in that code. Fix it there and say which task it belonged to.

- [ ] **Step 3: Red-prove.** In `chatops-egress.ts`, move `await raw(…)` above the append. `rowsAtPost` becomes `[0, 1]` and the append-failure test sees posts. Restore.

- [ ] **Step 4: Commit** (`test(oncall): integration proof of the ledgered ChatOps headline path`)

---

### Task 9: Documentation

**Files:**
- Modify: `docs/architecture.md` (the oncall-push section, around line 1754: the "**Not shipped:** ChatOps delivery (PR 2 …" sentence)
- Modify: `docs/cli-reference.md` (around line 1093, the `chatops_namespace` config line, plus one sentence in the `nimbus oncall pushed` intro)
- Modify: `docs/SECURITY-INVARIANTS.md` (lines ~621, 623, 668, 720: the chatops-class paragraphs)
- Modify: `CLAUDE.md`, `GEMINI.md` (I29 bullet: "one call returns three functions (`reply`/`approvalCard`/`agentBrief`)"; the Status paragraph)
- Modify: `docs/CHANGELOG.md` (new top entry under "Post-Phase-6 deliveries"), `docs/roadmap.md` (line ~2402, the "Pushed incident brief" row)

- [ ] **Step 1: Find every restatement.**

```bash
grep -rn "three functions\|reply\`/\`approvalCard\`/\`agentBrief\|{ reply, approvalCard, agentBrief }\|chatops_namespace\|ChatOps delivery (PR 2" CLAUDE.md GEMINI.md docs .claude/commands --include=*.md | grep -v "docs/superpowers/"
```

Edit every hit except historical CHANGELOG entries (dated entries describe what was true then and stay as written).

- [ ] **Step 2: Make the edits.**
- I29 wording, in CLAUDE.md, GEMINI.md and SECURITY-INVARIANTS.md: "three functions (`reply`/`approvalCard`/`agentBrief`)" becomes "four functions (`reply`/`approvalCard`/`agentBrief`/`pushedBrief`)". The `METHOD_FOR` list gains `chatops.pushedBrief`. In SECURITY-INVARIANTS.md line ~621's consumer list, add "the on-call pushed brief's headline via `postPushedBrief`'s `pushedBriefDispatcher` (`posts.pushedBrief`)". Line ~668 becomes `{ reply, approvalCard, agentBrief, pushedBrief }`. Line ~720's "one of `buildLedgeredChatPosts`'s three functions" becomes four, and "a fourth member" becomes "a fifth member".
- `architecture.md`: replace "**Not shipped:** ChatOps delivery (PR 2 — `chatops_namespace` is parsed and has no effect yet), the desktop panel (PR 3)…" with a ChatOps-sink paragraph plus the remaining Not-shipped list. The paragraph covers: the three-line escaped headline, the cap of 3 plus one summary, the outcomes in `delivery_json.chatops`, the boot gate, `chatops.pushedBrief` ledgering, headline-only content, Slack-only notify, and no ChatOps in demo. Keep "the desktop panel (PR 3), approve-from-push, and cascade ranking" as Not shipped.
- `cli-reference.md`: the config line becomes `chatops_namespace = ""   # "" = post nothing; else the namespace whose policy notify channels get each pushed headline`. Add one sentence to the `nimbus oncall pushed` intro: when `chatops_namespace` names a namespace with policy `notify` channels, a three-line headline is also posted there (`delivery.chatops` in `--json` shows the outcome).
- `CHANGELOG.md`: a `2026-10-0X — The on-call pushed brief, PR 2 of 3 (ChatOps sink)` entry. Fill the X with the merge date at PR time. State: what posts and where; headline only and why; the boot race and the gate; the demo ChatOps guard (I41); the corrected `incidentId=` parameter; no new invariant, egress class, IPC method or migration.
- `roadmap.md` row ~2402: "PARTIALLY SHIPPED (PR 1 of 3…)" becomes "PR 1 and 2 of 3". Remove "Slack/ChatOps delivery (PR 2)" from Not shipped and add one sentence on what PR 2 shipped.
- CLAUDE.md / GEMINI.md Status paragraph: one sentence noting PR 2 shipped (ChatOps headline sink), matching the style of the existing on-call push mention. Keep both files identical in every edited span.

- [ ] **Step 3: Verify**

Run: `bun run audit:doc-refs && bun run audit:status-drift`, then the Step 1 grep again. Expected: audits pass, and the grep shows only historical CHANGELOG hits.

- [ ] **Step 4: Commit** (`docs(oncall): document the pushed-brief ChatOps sink`)

---

### Task 10: Whole-branch verification and PR

- [ ] **Step 1: Full local gates**

```bash
bun run preflight:fast
bun test packages/gateway/src/oncall-push packages/gateway/src/chatops packages/gateway/src/egress packages/gateway/src/platform packages/gateway/src/demo packages/gateway/src/ipc packages/gateway/src/security-invariants.test.ts
bun run typecheck:tests
bun run verify:docker -- --changed
```

Expected: all green. `verify:docker` always shows one red exec-e2e from its own harness. That one is not this branch, so ignore it and nothing else. Run `bun run audit:platform-test-gaps` and note any test that cannot run on this OS.

- [ ] **Step 2: Audit D22(d) and D17** explicitly: `bun run audit:invariants`. Expected: clean.

- [ ] **Step 3: Whole-branch review.** Dispatch one fresh reviewer over `git diff main...HEAD`. Tell it to check cross-task seams in particular: the `ChatopsPoster` type through runtime → assemble → boot, and the reason strings against Global Constraints.

- [ ] **Step 4: Strip the spec, review and plan.** They never land on `main`.

```bash
git rm docs/superpowers/specs/2026-10-02-oncall-push-chatops-design.md docs/superpowers/specs/2026-10-02-oncall-push-chatops-review.md docs/superpowers/plans/2026-10-03-oncall-push-chatops.md docs/superpowers/plans/2026-10-03-oncall-push-chatops-plan-review.md
ls docs/superpowers/specs docs/superpowers/plans 2>/dev/null   # must list nothing from this branch
git commit -F msg.txt   # "chore: strip the PR 2 spec, review and plan before merge"
```

- [ ] **Step 5: Push and open the PR.**
  - Title: `feat(oncall): post the pushed brief's headline to ChatOps (PR 2 of 3)`. No `!`: existing users change nothing, since an empty namespace posts nothing.
  - The body becomes the squash commit. Cover what ships, the boot gate and why it replaced the reviewer's scheduler move, the I41 demo guard, the `incidentId` correction, and test evidence. End with the attribution line.
  - Use `gh pr create`. Do NOT merge: merging is the owner's call. If asked to merge later, use `gh pr merge --squash --auto`, never a merge with checks pending.
