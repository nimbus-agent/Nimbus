# Incident Attribution — PR 1 (PagerDuty) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute PagerDuty incidents to people — emit `person --assigned--> incident` and `person --resolves--> incident` graph edges — so `catchup`, `expert` and `negotiate` can cite incident work instead of declaring it permanently unavailable.

**Architecture:** The connector fetches expanded actor objects (`include[]`), extracts their emails, and writes them into `item.metadata`. The graph populator — not the connector — resolves email → person and emits the edges, so `nimbus index regraph` rebuilds attribution with no network. Two agent lanes are already written against these edges and come alive on merge; `negotiate` gains a new lane.

**Tech Stack:** Bun v1.2+, TypeScript strict, `bun:sqlite`, Biome. No new dependencies.

**Spec:** [`docs/superpowers/specs/2026-08-14-incident-attribution-design.md`](../specs/2026-08-14-incident-attribution-design.md) — read it alongside this plan.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **No migration in this PR.** `resolves` and `assigned` are already registered in `graph_relation_type` (`index/graph-v7-sql.ts:35,37`). Do not add one.
- **No `author_id` writes.** `authorId` stays `null` on every incident. Six lanes across `negotiate.ts`, `expert.ts` and `catchup.ts` query `item.author_id` directly; an incident has no author.
- **The edge is spelled `resolves`, not `resolved`.** `catchup.ts:328` and `expert.ts:408` already spell it that way. Renaming leaves both lanes permanently dead.
- **Every outbound request calls `await ctx.rateLimiter.acquire("pagerduty")` first**, matching `pagerduty-sync.ts:162`.
- **Attribution failures never abort a sync.** A failed user lookup is logged, counted, and skipped.
- **Bounded regex quantifiers**, per house style at `updater/manifest-fetcher.ts:3` (`{1,256}`, never bare `+` on user input).
- **Branch:** work on `dev/asafgolombek/incident-attribution-pr1`. Never commit on `main`.
- **Format before every commit:** `bun run lint:fix` (`biome check --write --error-on-warnings .`). Biome's configured `quoteStyle` is `"double"` (`biome.json:75`), so TypeScript string literals use `"`. Single quotes inside a template literal are SQL syntax (`type = 'person'`) and Biome does not touch them — do not "fix" those. The `lint` gate runs with `--error-on-warnings`, so a warning fails CI exactly like an error.
- **Run `bun run typecheck` before every commit, not just the tests.** Bun does not typecheck at
  runtime, so a wrong-arity call or a bad type passes the entire suite and fails CI. This bit Task 4:
  `syncTestContext(db, vault)` takes TWO parameters and already spreads `silentSyncContextExtras()`
  internally — an earlier draft of this plan passed it a third argument in 11 places, 42 tests went
  green, and `typecheck` exited 1. Green tests are not evidence of a green build.
- **Before pushing:** `bun run preflight:fast`. If tests or logic changed, run the touched suites too.

---

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/connectors/actor-email.ts` | `usableActorEmail` — the one email guard, shared with Sentry in PR 2 |
| `packages/gateway/src/connectors/actor-email.test.ts` | Its test table |
| `packages/gateway/src/connectors/pagerduty-attribution.ts` | Pure actor extraction + `PAGERDUTY_INCIDENT_META_VERSION`. No network, no DB — so `ipc/index-rebody-rpc.ts` can import the constant without pulling in a sync module |
| `packages/gateway/src/connectors/pagerduty-attribution.test.ts` | Its tests |

**Modified:**

| File | Change |
| --- | --- |
| `packages/gateway/src/connectors/pagerduty-sync.ts` | `include[]` params, the bounded `/users/{id}` fallback, new metadata keys, `historyFloorMs` opt-in |
| `packages/gateway/src/graph/graph-populator.ts` | Person edges in the incident arm of `syncTimelineEventGraph` |
| `packages/gateway/src/ipc/index-rebody-rpc.ts:134` | A `pagerduty` row in `REBODY_REQUIRED_META_VERSION` |
| `packages/gateway/src/agents/_lib/negotiate-types.ts` | `NegotiateIncidents` type + a field on `NegotiateBrief` |
| `packages/gateway/src/agents/negotiate.ts` | `laneIncidents` + lane wiring; drop `"incidents resolved"` from `UNAVAILABLE_EVIDENCE` |
| `packages/gateway/src/agents/_lib/render.ts` | `renderNegotiateIncidents` + assembly |
| `packages/gateway/src/agents/_lib/gap-notes.ts:8,70-79` | Remediation string + the "future edge" comment |
| `packages/gateway/src/agents/expert.ts:410` | The same remediation string, duplicated inline |
| `docs/CHANGELOG.md`, `docs/architecture.md` | Dated entry + schema/graph notes |

---

### Task 1: The shared email guard

`resolvePersonForSync` **creates a person row** for whatever string it is handed, and `normalizeEmail` (`people/person-store.ts:6-8`) is only `raw.trim().toLowerCase()` — it does not validate. An actor payload carrying `"unknown"` would mint a junk person that pollutes every people-based brief and can never be merged away.

**Files:**

- Create: `packages/gateway/src/connectors/actor-email.ts`
- Test: `packages/gateway/src/connectors/actor-email.test.ts`

**Interfaces:**

- Consumes: nothing
- Produces: `usableActorEmail(raw: unknown): string | null`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/actor-email.test.ts
import { expect, test } from "bun:test";
import { usableActorEmail } from "./actor-email.ts";

test("accepts a well-formed address and preserves it verbatim", () => {
  expect(usableActorEmail("Jane.Doe@Example.com")).toBe("Jane.Doe@Example.com");
});

test("trims surrounding whitespace", () => {
  expect(usableActorEmail("  jane@example.com  ")).toBe("jane@example.com");
});

// Lowercasing is deliberately NOT done here: resolvePersonForSync already
// normalises via normalizeEmail (people/linker.ts:44). A second lowercasing at
// the call site is duplicated logic that can drift out of sync with it.
test("does not lowercase — normalisation belongs to the linker", () => {
  expect(usableActorEmail("JANE@EXAMPLE.COM")).toBe("JANE@EXAMPLE.COM");
});

test.each([
  ["empty", ""],
  ["whitespace only", "   "],
  ["a placeholder word", "unknown"],
  ["n/a", "n/a"],
  ["a display name", "Jane Doe"],
  ["no domain dot", "jane@example"],
  ["no local part", "@example.com"],
  ["two at signs", "jane@@example.com"],
  ["internal whitespace", "jane doe@example.com"],
  ["over the RFC 5321 ceiling", `${"a".repeat(250)}@example.com`],
])("rejects %s", (_label, input) => {
  expect(usableActorEmail(input)).toBeNull();
});

test.each([
  ["a number", 42],
  ["null", null],
  ["undefined", undefined],
  ["an object", { email: "jane@example.com" }],
])("rejects non-string %s", (_label, input) => {
  expect(usableActorEmail(input)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/actor-email.test.ts`
Expected: FAIL — `Cannot find module './actor-email.ts'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway/src/connectors/actor-email.ts

/**
 * Bounded quantifiers, matching the house style in `updater/manifest-fetcher.ts:3`.
 * Every segment is capped, so no input can drive superlinear backtracking; the
 * length check below runs BEFORE the regex so nothing pathological reaches it.
 */
const ACTOR_EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,63}(?:\.[^\s@.]{1,63}){1,8}$/;

/** RFC 5321's ceiling on a full address. */
const MAX_EMAIL_LENGTH = 254;

/**
 * The single gate between a connector's actor payload and
 * `resolvePersonForSync`, which CREATES a person row for whatever it is handed.
 * `normalizeEmail` only trims and lowercases — it does not validate — so
 * without this a payload carrying "unknown" or a display name mints a junk
 * person that pollutes every people-based brief and cannot be merged away.
 *
 * Deliberately does NOT lowercase: `resolvePersonForSync` already normalises
 * (`people/linker.ts:44`), and duplicating that here creates two places for the
 * rule to drift.
 *
 * Returns `null` rather than throwing — a rejected address is an expected
 * outcome that increments an unattributable count, not an error.
 */
export function usableActorEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EMAIL_LENGTH) return null;
  return ACTOR_EMAIL_RE.test(trimmed) ? trimmed : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/actor-email.test.ts`
Expected: PASS (all cases)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/actor-email.ts packages/gateway/src/connectors/actor-email.test.ts
git commit -m "add the shared actor-email guard"
```

---

### Task 2: Build the actor id → email map from an expanded page

With `include[]=assignees` and `include[]=acknowledgers`, PagerDuty replaces user *references* with full user objects carrying `email`. This task harvests those into a lookup keyed by user id, so a bare reference elsewhere in the same response (notably `last_status_change_by`) can be resolved for free.

**Files:**

- Create: `packages/gateway/src/connectors/pagerduty-attribution.ts`
- Test: `packages/gateway/src/connectors/pagerduty-attribution.test.ts`

**Interfaces:**

- Consumes: `usableActorEmail` (Task 1); `asRecord`, `stringField` from `./unknown-record.ts`
- Produces: `pagerdutyEmailMapFromIncidents(incidents: readonly unknown[]): Map<string, string>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/pagerduty-attribution.test.ts
import { expect, test } from "bun:test";
import { pagerdutyEmailMapFromIncidents } from "./pagerduty-attribution.ts";

test("harvests emails from expanded assignees and acknowledgers", () => {
  const map = pagerdutyEmailMapFromIncidents([
    {
      id: "PD-1",
      assignments: [{ assignee: { id: "PUSER1", type: "user", email: "jane@example.com" } }],
      acknowledgements: [{ acknowledger: { id: "PUSER2", type: "user", email: "bob@example.com" } }],
    },
  ]);
  expect(map.get("PUSER1")).toBe("jane@example.com");
  expect(map.get("PUSER2")).toBe("bob@example.com");
});

test("harvests across the whole page, not just the first incident", () => {
  const map = pagerdutyEmailMapFromIncidents([
    { id: "PD-1", assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }] },
    { id: "PD-2", assignments: [{ assignee: { id: "PUSER2", email: "bob@example.com" } }] },
  ]);
  expect(map.size).toBe(2);
});

// A service_reference acknowledger is an auto-ack, not a person.
test("skips a service acknowledger", () => {
  const map = pagerdutyEmailMapFromIncidents([
    {
      id: "PD-1",
      acknowledgements: [{ acknowledger: { id: "PSVC1", type: "service_reference" } }],
    },
  ]);
  expect(map.size).toBe(0);
});

test("skips an unexpanded reference that carries no email", () => {
  const map = pagerdutyEmailMapFromIncidents([
    { id: "PD-1", assignments: [{ assignee: { id: "PUSER1", type: "user_reference" } }] },
  ]);
  expect(map.size).toBe(0);
});

test("skips an actor whose email fails the guard", () => {
  const map = pagerdutyEmailMapFromIncidents([
    { id: "PD-1", assignments: [{ assignee: { id: "PUSER1", email: "unknown" } }] },
  ]);
  expect(map.size).toBe(0);
});

test("tolerates every field being absent or the wrong shape", () => {
  expect(pagerdutyEmailMapFromIncidents([null, 42, "x", {}, { assignments: "nope" }]).size).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/pagerduty-attribution.test.ts`
Expected: FAIL — `Cannot find module './pagerduty-attribution.ts'`

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/gateway/src/connectors/pagerduty-attribution.ts
import { usableActorEmail } from "./actor-email.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * Bumped whenever an incident row must be re-fetched to gain indexed depth.
 * Read by `ipc/index-rebody-rpc.ts`'s `REBODY_REQUIRED_META_VERSION`, which is
 * why this lives in a pure module: the IPC layer must not import a sync module.
 *
 * 1 — assignee/resolver attribution (Spec B).
 */
export const PAGERDUTY_INCIDENT_META_VERSION = 1;

/**
 * A PagerDuty actor reference that is a SERVICE rather than a person — an
 * auto-acknowledge or auto-resolve. Attributes to nobody, and must not be
 * counted as an attribution failure: nothing was lost.
 */
function isServiceActor(actor: Record<string, unknown>): boolean {
  const type = stringField(actor, "type") ?? "";
  return type.startsWith("service");
}

/** The expanded user objects on one incident, from both actor collections. */
function actorsOnIncident(row: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const assignments = row["assignments"];
  if (Array.isArray(assignments)) {
    for (const a of assignments) {
      const assignee = asRecord(asRecord(a)?.["assignee"]);
      if (assignee !== undefined) out.push(assignee);
    }
  }
  const acks = row["acknowledgements"];
  if (Array.isArray(acks)) {
    for (const a of acks) {
      const acker = asRecord(asRecord(a)?.["acknowledger"]);
      if (acker !== undefined) out.push(acker);
    }
  }
  return out;
}

/**
 * Harvest `user id -> email` from every EXPANDED actor across one page.
 *
 * Acknowledgers are harvested even though this spec emits no acknowledger edge.
 * They are an identity SOURCE only: `last_status_change_by` arrives as a bare
 * reference, and cross-referencing it against this map is what resolves a
 * responder who acknowledged and resolved but was never assigned — without
 * spending a request. Fetching a field for identity while declining to make a
 * claim from it is deliberate (spec § 3.2).
 */
export function pagerdutyEmailMapFromIncidents(
  incidents: readonly unknown[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of incidents) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    for (const actor of actorsOnIncident(row)) {
      if (isServiceActor(actor)) continue;
      const id = stringField(actor, "id");
      if (id === undefined || id === "") continue;
      const email = usableActorEmail(actor["email"]);
      if (email !== null && !map.has(id)) map.set(id, email);
    }
  }
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/pagerduty-attribution.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/pagerduty-attribution.ts packages/gateway/src/connectors/pagerduty-attribution.test.ts
git commit -m "harvest expanded pagerduty actor emails into an id map"
```

---

### Task 3: Extract one incident's actors

Pure, single-pass, and runs **after** the map is complete (including any fallback lookups from Task 5), so it never needs the network.

**Files:**

- Modify: `packages/gateway/src/connectors/pagerduty-attribution.ts`
- Test: `packages/gateway/src/connectors/pagerduty-attribution.test.ts`

**Interfaces:**

- Consumes: `pagerdutyEmailMapFromIncidents` (Task 2)
- Produces:
  - `MAX_ASSIGNEES_PER_INCIDENT = 10`
  - `type PagerdutyIncidentActors = { assigneeEmails: string[]; resolvedByEmail: string | null; unattributed: number }`
  - `extractPagerdutyActors(row: Record<string, unknown>, emailById: ReadonlyMap<string, string>): PagerdutyIncidentActors`
  - `pagerdutyUnresolvedActorIds(incidents: readonly unknown[], emailById: ReadonlyMap<string, string>): string[]`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/connectors/pagerduty-attribution.test.ts
import {
  extractPagerdutyActors,
  MAX_ASSIGNEES_PER_INCIDENT,
  pagerdutyUnresolvedActorIds,
} from "./pagerduty-attribution.ts";

const EMPTY = new Map<string, string>();

test("extracts assignee emails from expanded assignees", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "triggered",
      assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }],
    },
    EMPTY,
  );
  expect(actors.assigneeEmails).toEqual(["jane@example.com"]);
  expect(actors.unattributed).toBe(0);
});

test("falls back to the id map for a bare assignee reference", () => {
  const actors = extractPagerdutyActors(
    { id: "PD-1", status: "triggered", assignments: [{ assignee: { id: "PUSER1" } }] },
    new Map([["PUSER1", "jane@example.com"]]),
  );
  expect(actors.assigneeEmails).toEqual(["jane@example.com"]);
});

test("counts an assignee it cannot resolve", () => {
  const actors = extractPagerdutyActors(
    { id: "PD-1", status: "triggered", assignments: [{ assignee: { id: "PUSER1" } }] },
    EMPTY,
  );
  expect(actors.assigneeEmails).toEqual([]);
  expect(actors.unattributed).toBe(1);
});

test("dedupes a person assigned twice", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "triggered",
      assignments: [
        { assignee: { id: "PUSER1", email: "jane@example.com" } },
        { assignee: { id: "PUSER1", email: "jane@example.com" } },
      ],
    },
    EMPTY,
  );
  expect(actors.assigneeEmails).toEqual(["jane@example.com"]);
  expect(actors.unattributed).toBe(0);
});

// assignments[] is caller-controlled and unbounded. Overflow is COUNTED, never
// dropped silently — a silently truncated list reads as an exhaustive one.
test("caps assignees and counts the overflow", () => {
  const assignments = Array.from({ length: MAX_ASSIGNEES_PER_INCIDENT + 3 }, (_, i) => ({
    assignee: { id: `PUSER${String(i)}`, email: `u${String(i)}@example.com` },
  }));
  const actors = extractPagerdutyActors({ id: "PD-1", status: "triggered", assignments }, EMPTY);
  expect(actors.assigneeEmails).toHaveLength(MAX_ASSIGNEES_PER_INCIDENT);
  expect(actors.unattributed).toBe(3);
});

test("resolves last_status_change_by only when the incident is resolved", () => {
  const row = {
    id: "PD-1",
    status: "acknowledged",
    last_status_change_by: { id: "PUSER1", type: "user_reference" },
  };
  const map = new Map([["PUSER1", "jane@example.com"]]);
  expect(extractPagerdutyActors(row, map).resolvedByEmail).toBeNull();
  expect(extractPagerdutyActors({ ...row, status: "resolved" }, map).resolvedByEmail).toBe(
    "jane@example.com",
  );
});

// An auto-resolve attributes to nobody and is NOT an attribution failure.
test("a service_reference resolver attributes to nobody without counting a failure", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "resolved",
      last_status_change_by: { id: "PSVC1", type: "service_reference" },
    },
    EMPTY,
  );
  expect(actors.resolvedByEmail).toBeNull();
  expect(actors.unattributed).toBe(0);
});

test("counts a resolved incident whose resolver cannot be resolved", () => {
  const actors = extractPagerdutyActors(
    {
      id: "PD-1",
      status: "resolved",
      last_status_change_by: { id: "PUSER9", type: "user_reference" },
    },
    EMPTY,
  );
  expect(actors.resolvedByEmail).toBeNull();
  expect(actors.unattributed).toBe(1);
});

test("collects only the actor ids still missing an email", () => {
  const incidents = [
    {
      id: "PD-1",
      status: "resolved",
      assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }],
      last_status_change_by: { id: "PUSER9", type: "user_reference" },
    },
    {
      id: "PD-2",
      status: "resolved",
      last_status_change_by: { id: "PSVC1", type: "service_reference" },
    },
  ];
  const map = pagerdutyEmailMapFromIncidents(incidents);
  // PUSER1 is already known; PSVC1 is a service and must never cost a request.
  expect(pagerdutyUnresolvedActorIds(incidents, map)).toEqual(["PUSER9"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/pagerduty-attribution.test.ts`
Expected: FAIL — `extractPagerdutyActors is not a function`

- [ ] **Step 3: Write minimal implementation**

```ts
// append to packages/gateway/src/connectors/pagerduty-attribution.ts

/**
 * `assignments[]` is caller-controlled and unbounded. Ten is generous for a
 * real incident; beyond it the extras are COUNTED as unattributed rather than
 * dropped, so a truncated list can never read as an exhaustive one.
 */
export const MAX_ASSIGNEES_PER_INCIDENT = 10;

export type PagerdutyIncidentActors = {
  readonly assigneeEmails: string[];
  readonly resolvedByEmail: string | null;
  /** Actors seen but not attributable. Service actors are NOT counted here. */
  readonly unattributed: number;
};

/** The resolver reference, but only for an incident that is actually resolved. */
function resolverRef(row: Record<string, unknown>): Record<string, unknown> | undefined {
  if (stringField(row, "status") !== "resolved") return undefined;
  return asRecord(row["last_status_change_by"]);
}

/** An actor's email: its own expanded field first, then the page-wide map. */
function emailForActor(
  actor: Record<string, unknown>,
  emailById: ReadonlyMap<string, string>,
): string | null {
  const own = usableActorEmail(actor["email"]);
  if (own !== null) return own;
  const id = stringField(actor, "id");
  if (id === undefined || id === "") return null;
  return emailById.get(id) ?? null;
}

export function extractPagerdutyActors(
  row: Record<string, unknown>,
  emailById: ReadonlyMap<string, string>,
): PagerdutyIncidentActors {
  const assigneeEmails: string[] = [];
  let unattributed = 0;

  const assignments = Array.isArray(row["assignments"]) ? row["assignments"] : [];
  for (const a of assignments) {
    const assignee = asRecord(asRecord(a)?.["assignee"]);
    if (assignee === undefined || isServiceActor(assignee)) continue;
    const email = emailForActor(assignee, emailById);
    if (email === null) {
      unattributed += 1;
      continue;
    }
    if (assigneeEmails.includes(email)) continue;
    if (assigneeEmails.length >= MAX_ASSIGNEES_PER_INCIDENT) {
      unattributed += 1;
      continue;
    }
    assigneeEmails.push(email);
  }

  let resolvedByEmail: string | null = null;
  const resolver = resolverRef(row);
  // A service resolver (auto-resolve) attributes to nobody and is NOT a
  // failure — nothing was lost, so it must not inflate `unattributed`.
  if (resolver !== undefined && !isServiceActor(resolver)) {
    resolvedByEmail = emailForActor(resolver, emailById);
    if (resolvedByEmail === null) unattributed += 1;
  }

  return { assigneeEmails, resolvedByEmail, unattributed };
}

/**
 * Actor ids on this page that still have no email — the only ids worth spending
 * a `/users/{id}` request on. Service actors are excluded so an auto-resolving
 * tenant never burns the lookup budget.
 */
export function pagerdutyUnresolvedActorIds(
  incidents: readonly unknown[],
  emailById: ReadonlyMap<string, string>,
): string[] {
  const ids = new Set<string>();
  for (const raw of incidents) {
    const row = asRecord(raw);
    if (row === undefined) continue;
    const candidates = [...actorsOnIncident(row)];
    const resolver = resolverRef(row);
    if (resolver !== undefined) candidates.push(resolver);
    for (const actor of candidates) {
      if (isServiceActor(actor)) continue;
      if (usableActorEmail(actor["email"]) !== null) continue;
      const id = stringField(actor, "id");
      if (id === undefined || id === "" || emailById.has(id)) continue;
      ids.add(id);
    }
  }
  return [...ids];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/pagerduty-attribution.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/pagerduty-attribution.ts packages/gateway/src/connectors/pagerduty-attribution.test.ts
git commit -m "extract pagerduty incident assignees and resolver"
```

---

### Task 4: Request expanded actors

**Files:**

- Modify: `packages/gateway/src/connectors/pagerduty-sync.ts:163-167`
- Test: `packages/gateway/src/connectors/pagerduty-sync.test.ts`

**Interfaces:**

- Consumes: nothing new
- Produces: list requests carrying `include[]=assignees`, `include[]=acknowledgers`, `include[]=users`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/connectors/pagerduty-sync.test.ts
// `stubPagerdutyPages` records every requested URL in `calls`.
test("requests expanded actors so assignee emails cost no extra requests", async () => {
  const { calls } = stubPagerdutyPages([{ incidents: [], more: false }]);
  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );

  const url = calls[0] ?? "";
  expect(url).toContain("include%5B%5D=assignees");
  expect(url).toContain("include%5B%5D=acknowledgers");
  expect(url).toContain("include%5B%5D=users");
});
```

> **Note for the implementer:** `URLSearchParams.append` percent-encodes `[]` as `%5B%5D`. Assert on the encoded form — asserting on `include[]=` produces a test that can never pass.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/pagerduty-sync.test.ts -t "expanded actors"`
Expected: FAIL — the URL contains no `include` params

- [ ] **Step 3: Write minimal implementation**

In `pagerduty-sync.ts`, immediately after `u.searchParams.set("offset", …)`:

```ts
        // Expanded actors carry `email`, which is what makes assignee
        // attribution cost ZERO extra requests. `acknowledgers` is requested
        // even though no acknowledger edge is emitted: it is an identity
        // source for `last_status_change_by`, which arrives as a bare
        // reference (spec § 3.2). `append`, not `set` — `set` would replace
        // the previous value and only the last would survive.
        u.searchParams.append("include[]", "assignees");
        u.searchParams.append("include[]", "acknowledgers");
        u.searchParams.append("include[]", "users");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/pagerduty-sync.test.ts`
Expected: PASS — the new test and every pre-existing one

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/pagerduty-sync.ts packages/gateway/src/connectors/pagerduty-sync.test.ts
git commit -m "request expanded pagerduty actors on the incident list"
```

---

### Task 5: The bounded, rate-limited `/users/{id}` fallback

The one place this PR adds network traffic. It runs **once per page**, before mapping — not once per incident.

**Files:**

- Modify: `packages/gateway/src/connectors/pagerduty-sync.ts`
- Test: `packages/gateway/src/connectors/pagerduty-sync.test.ts`

**Interfaces:**

- Consumes: `pagerdutyUnresolvedActorIds` (Task 3)
- Produces: `MAX_USER_LOOKUPS_PER_SYNC = 25`; an internal `resolveMissingActorEmails(...)` that mutates a run-scoped `Map<string, string>`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/connectors/pagerduty-sync.test.ts

/**
 * Serves the incident list once, then answers /users/{id} lookups from `users`.
 * An id absent from `users` gets the given status, so a 403/404 can be aimed at
 * exactly one actor.
 */
function stubPagerdutyWithUsers(
  incidents: unknown[],
  users: Record<string, { email?: string; status?: number }>,
): { userCalls: string[] } {
  const userCalls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    if (url.startsWith("https://api.pagerduty.com/incidents")) {
      return new Response(JSON.stringify({ incidents, more: false }), { status: 200 });
    }
    if (url.startsWith("https://api.pagerduty.com/users/")) {
      userCalls.push(url);
      const id = url.slice("https://api.pagerduty.com/users/".length);
      const u = users[id];
      if (u?.status !== undefined) return new Response("{}", { status: u.status });
      return new Response(JSON.stringify({ user: { id, email: u?.email } }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { userCalls };
}

function resolvedIncident(id: string, resolverId: string): unknown {
  return {
    id,
    title: `Incident ${id}`,
    status: "resolved",
    updated_at: isoHoursAgo(1),
    created_at: isoHoursAgo(2),
    last_status_change_by: { id: resolverId, type: "user_reference" },
  };
}

test("resolves an unexpanded resolver through one /users lookup", async () => {
  const { userCalls } = stubPagerdutyWithUsers([resolvedIncident("PD-1", "PUSER9")], {
    PUSER9: { email: "jane@example.com" },
  });
  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );

  expect(userCalls).toHaveLength(1);
  expect(readIncidentMetadata(db, "PD-1").resolved_by_email).toBe("jane@example.com");
});

test("looks a repeated actor up only once per run", async () => {
  const { userCalls } = stubPagerdutyWithUsers(
    [resolvedIncident("PD-1", "PUSER9"), resolvedIncident("PD-2", "PUSER9")],
    { PUSER9: { email: "jane@example.com" } },
  );
  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );
  expect(userCalls).toHaveLength(1);
});

// The failure that matters: a token scoped before this feature 403s on EVERY
// lookup. Losing the whole incident index over that is far worse than an
// unattributed incident. Red-prove it — an implementation that lets the
// rejection propagate still passes a test that only asserts "no edge".
test("a 403 on one actor leaves the sync succeeding and every incident indexed", async () => {
  stubPagerdutyWithUsers([resolvedIncident("PD-1", "PUSER9"), resolvedIncident("PD-2", "PUSER8")], {
    PUSER9: { status: 403 },
    PUSER8: { email: "bob@example.com" },
  });
  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  const result: SyncResult = await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );

  expect(result.itemsUpserted).toBe(2);
  expectServiceItemCount(db, "pagerduty", 2);
  expect(readIncidentMetadata(db, "PD-1").resolved_by_email).toBeNull();
  expect(readIncidentMetadata(db, "PD-1").unattributed_actors).toBe(1);
  expect(readIncidentMetadata(db, "PD-2").resolved_by_email).toBe("bob@example.com");
});

// A 200 with a body that is empty, non-JSON, or missing `user` must degrade to
// an unattributed incident, never throw. `JSON.parse` sits INSIDE the try for
// exactly this reason, and `asRecord` returns undefined for null, a primitive,
// or an array — so no level of the traversal can explode.
test.each([
  ["an empty body", ""],
  ["non-JSON", "<html>502</html>"],
  ["JSON with no user block", '{"meta":{}}'],
  ["a JSON array", "[]"],
  ["a JSON null", "null"],
  ["a user with no email", '{"user":{"id":"PUSER9"}}'],
])("survives a 200 carrying %s", async (_label, body) => {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = urlFromFetchInput(input);
    if (url.startsWith("https://api.pagerduty.com/incidents")) {
      return new Response(
        JSON.stringify({ incidents: [resolvedIncident("PD-1", "PUSER9")], more: false }),
        { status: 200 },
      );
    }
    return new Response(body, { status: 200 });
  }) as typeof fetch;

  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  const result: SyncResult = await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );

  expect(result.itemsUpserted).toBe(1);
  expect(readIncidentMetadata(db, "PD-1").resolved_by_email).toBeNull();
  expect(readIncidentMetadata(db, "PD-1").unattributed_actors).toBe(1);
});

test("stops at the lookup cap and counts the rest", async () => {
  const incidents = Array.from({ length: MAX_USER_LOOKUPS_PER_SYNC + 5 }, (_, i) =>
    resolvedIncident(`PD-${String(i)}`, `PUSER${String(i)}`),
  );
  const { userCalls } = stubPagerdutyWithUsers(incidents, {});
  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );
  expect(userCalls).toHaveLength(MAX_USER_LOOKUPS_PER_SYNC);
  expectServiceItemCount(db, "pagerduty", MAX_USER_LOOKUPS_PER_SYNC + 5);
});
```

Add `MAX_USER_LOOKUPS_PER_SYNC` to the existing import from `./pagerduty-sync.ts`, and extend the `IncidentMetadata` type in that file with `assignee_emails?: string[]`, `resolved_by_email?: string | null`, `unattributed_actors?: number`, `meta_v?: number`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/pagerduty-sync.test.ts -t "/users"`
Expected: FAIL — `unexpected fetch: https://api.pagerduty.com/users/PUSER9` (nothing requests users yet)

- [ ] **Step 3: Write minimal implementation**

```ts
// in pagerduty-sync.ts, above createPagerdutySyncable

/**
 * Hard ceiling on identity lookups per sync run. The expansion in Task 4
 * covers assignees for free, so this only ever pays for actors that arrive as
 * bare references — normally a handful. Exported so the test can seed exactly
 * at the boundary without duplicating the number.
 */
export const MAX_USER_LOOKUPS_PER_SYNC = 25;

/**
 * Fill `emailById` for actor ids the page did not expand.
 *
 * Sequential on purpose. The cap bounds TOTAL requests, not their burst rate;
 * fanning 25 concurrent requests at a shared limiter is precisely the spike the
 * limiter exists to smooth. Each lookup acquires the limiter exactly as the
 * list requests do (`:162`).
 *
 * Every failure mode — non-OK status, thrown request, unparseable body — is
 * caught PER LOOKUP and memoised as a miss, then attribution simply degrades to
 * an unattributed count. A 403 here is the expected steady state for any token
 * scoped before this feature existed, so losing the whole incident index over
 * it would be a far worse outcome than an unattributed incident.
 *
 * Returns the bytes transferred so the caller keeps its accounting honest.
 */
async function resolveMissingActorEmails(
  ctx: SyncContext,
  token: string,
  ids: readonly string[],
  emailById: Map<string, string>,
  attempted: Set<string>,
): Promise<number> {
  let bytes = 0;
  for (const id of ids) {
    if (attempted.size >= MAX_USER_LOOKUPS_PER_SYNC) return bytes;
    if (attempted.has(id) || emailById.has(id)) continue;
    attempted.add(id);
    await ctx.rateLimiter.acquire("pagerduty");
    try {
      const res = await fetch(`https://api.pagerduty.com/users/${encodeURIComponent(id)}`, {
        headers: {
          Accept: "application/vnd.pagerduty+json;version=2",
          Authorization: `Token token=${token.trim()}`,
        },
      });
      const text = await res.text();
      bytes += text.length;
      if (!res.ok) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, status: res.status },
          "pagerduty sync: user lookup failed; incident left unattributed",
        );
        continue;
      }
      // Do NOT "simplify" this into a hand-rolled `typeof parsed === "object"
      // && parsed !== null` guard. `asRecord` already rejects null, primitives
      // AND arrays (`unknown-record.ts:1-6`); an inline guard drops the array
      // check, and binding `JSON.parse(text)` to a `const` without `as unknown`
      // types it `any`, which the no-`any` rule forbids. `JSON.parse` sits
      // inside the try precisely so an empty or non-JSON 200 body degrades to
      // an unattributed incident rather than throwing.
      const user = asRecord(asRecord(JSON.parse(text) as unknown)?.["user"]);
      const email = user === undefined ? null : usableActorEmail(user["email"]);
      if (email !== null) emailById.set(id, email);
    } catch (err) {
      ctx.logger.warn(
        { serviceId: SERVICE_ID, err },
        "pagerduty sync: user lookup threw; incident left unattributed",
      );
    }
  }
  return bytes;
}
```

Add the imports at the top of `pagerduty-sync.ts`:

```ts
import { usableActorEmail } from "./actor-email.ts";
import {
  extractPagerdutyActors,
  PAGERDUTY_INCIDENT_META_VERSION,
  pagerdutyEmailMapFromIncidents,
  pagerdutyUnresolvedActorIds,
} from "./pagerduty-attribution.ts";
```

Declare the run-scoped state beside `let maxUpdated = since;`:

```ts
      // Run-scoped, so a repeated actor costs one lookup per SYNC, not per page.
      const emailById = new Map<string, string>();
      const attemptedUserIds = new Set<string>();
```

And in the page loop, replacing the current call to `syncPagerdutyIncidentItems`:

```ts
        const pageEmails = pagerdutyEmailMapFromIncidents(parsed.incidents);
        for (const [k, v] of pageEmails) if (!emailById.has(k)) emailById.set(k, v);
        totalBytesTransferred += await resolveMissingActorEmails(
          ctx,
          token,
          pagerdutyUnresolvedActorIds(parsed.incidents, emailById),
          emailById,
          attemptedUserIds,
        );

        const { upserted, maxUpdated: pageMax } = syncPagerdutyIncidentItems(
          ctx,
          parsed.incidents,
          maxUpdated,
          now,
          emailById,
        );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/pagerduty-sync.test.ts`
Expected: PASS. Task 6 supplies the metadata keys these tests read — if `resolved_by_email` is `undefined` here, do Task 6 and re-run; do not weaken the assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/pagerduty-sync.ts packages/gateway/src/connectors/pagerduty-sync.test.ts
git commit -m "resolve unexpanded pagerduty actors through a bounded user lookup"
```

---

### Task 6: Write the attribution metadata

**Files:**

- Modify: `packages/gateway/src/connectors/pagerduty-sync.ts:59-128`
- Test: `packages/gateway/src/connectors/pagerduty-sync.test.ts`

**Interfaces:**

- Consumes: `extractPagerdutyActors` (Task 3)
- Produces: `syncPagerdutyIncidentItems(ctx, incidents, since, now, emailById)` — a fifth required parameter; item metadata gains `assignee_emails`, `resolved_by_email`, `unattributed_actors`, `meta_v`

> `emailById` is REQUIRED, not optional. An optional parameter would let a future call site silently omit it and produce permanently unattributed incidents with nothing to show for it.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/connectors/pagerduty-sync.test.ts
test("writes assignee, resolver and meta_v into incident metadata", async () => {
  stubPagerdutyIncidents([
    {
      id: "PD-1",
      title: "Checkout 500s",
      status: "resolved",
      updated_at: isoHoursAgo(1),
      created_at: isoHoursAgo(2),
      assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }],
      last_status_change_by: { id: "PUSER1", type: "user_reference" },
    },
  ]);
  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );

  const meta = readIncidentMetadata(db, "PD-1");
  expect(meta.assignee_emails).toEqual(["jane@example.com"]);
  expect(meta.resolved_by_email).toBe("jane@example.com");
  expect(meta.unattributed_actors).toBe(0);
  expect(meta.meta_v).toBe(1);
});

// `?? null` rather than a conditional key, so "nobody resolved this" is
// recorded rather than being indistinguishable from "this connector version
// did not capture resolution" — the same rule Spec A applied to assignedTo.
test("records an absent resolver as null, not as a missing key", async () => {
  stubPagerdutyIncidents([
    {
      id: "PD-2",
      title: "Still burning",
      status: "triggered",
      updated_at: isoHoursAgo(1),
      created_at: isoHoursAgo(2),
    },
  ]);
  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );

  const meta = readIncidentMetadata(db, "PD-2");
  expect(meta.resolved_by_email).toBeNull();
  expect(meta.assignee_emails).toEqual([]);
});

test("the item still carries no author", async () => {
  stubPagerdutyIncidents([
    {
      id: "PD-3",
      title: "Paged",
      status: "resolved",
      updated_at: isoHoursAgo(1),
      created_at: isoHoursAgo(2),
      assignments: [{ assignee: { id: "PUSER1", email: "jane@example.com" } }],
    },
  ]);
  const db = createMemoryIndexDb();
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(
    syncTestContext(db, createStubVault({ "pagerduty.api_token": "t" })),
    null,
  );

  const row = db
    .query("SELECT author_id FROM item WHERE service = 'pagerduty' AND external_id = 'PD-3'")
    .get() as { author_id: string | null };
  expect(row.author_id).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/pagerduty-sync.test.ts -t "metadata"`
Expected: FAIL — `expected undefined to equal [ "jane@example.com" ]`

- [ ] **Step 3: Write minimal implementation**

Thread `emailById` through and extend the metadata builder:

```ts
function buildPagerdutyMetadata(
  row: Record<string, unknown>,
  id: string,
  emailById: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const status = stringField(row, "status");
  const createdAt = stringField(row, "created_at");
  const openedAtMs = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  const serviceId = pdServiceId(row);
  const severity = pdPriorityName(row);
  const urgency = stringField(row, "urgency");
  const actors = extractPagerdutyActors(row, emailById);

  const metadata: Record<string, unknown> = {
    status: status ?? null,
    incidentId: id,
    // Always present, never conditional: an absent key would be
    // indistinguishable from a connector version that never captured actors,
    // which is exactly what `meta_v` and `nimbus index rebody` exist to detect.
    assignee_emails: actors.assigneeEmails,
    resolved_by_email: actors.resolvedByEmail,
    unattributed_actors: actors.unattributed,
    meta_v: PAGERDUTY_INCIDENT_META_VERSION,
  };
  if (Number.isFinite(openedAtMs)) metadata["opened_at_ms"] = openedAtMs;
  if (serviceId !== undefined && serviceId !== "") metadata["pagerduty_service_id"] = serviceId;
  if (severity !== undefined && severity !== "") metadata["severity"] = severity;
  if (urgency !== undefined && urgency !== "") metadata["urgency"] = urgency;
  return metadata;
}
```

Then add the `emailById: ReadonlyMap<string, string>` parameter to `upsertPagerdutyIncident` and to the exported `syncPagerdutyIncidentItems`, passing it down. `authorId: null` stays exactly as it is.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/pagerduty-sync.test.ts && bun test packages/gateway/src/graph/graph-populator-incidents.test.ts`
Expected: PASS. The populator test imports `syncPagerdutyIncidentItems` directly, so update its call site with `new Map()`.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/pagerduty-sync.ts packages/gateway/src/connectors/pagerduty-sync.test.ts packages/gateway/src/graph/graph-populator-incidents.test.ts
git commit -m "write pagerduty attribution metadata onto incident items"
```

---

### Task 7: Honour `historyFloorMs` on a cold start

Without this, `nimbus index rebody --service pagerduty --since 365` is accepted and then silently narrowed to the connector's own 30 days — the exact "accepted a flag and quietly narrowed it" failure `index-rebody-rpc.ts:104-108` exists to prevent.

**Files:**

- Modify: `packages/gateway/src/connectors/pagerduty-sync.ts:150-153`
- Test: `packages/gateway/src/connectors/pagerduty-sync.test.ts`

**Interfaces:**

- Consumes: `SyncContext.historyFloorMs` (`sync/types.ts:58`)
- Produces: nothing new

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/connectors/pagerduty-sync.test.ts
test("a cold start honours historyFloorMs", async () => {
  const { calls } = stubPagerdutyPages([{ incidents: [], more: false }]);
  const db = createMemoryIndexDb();
  const floorMs = Date.now() - 200 * 86_400_000;
  const ctx = {
    ...syncTestContext(
      db,
      createStubVault({ "pagerduty.api_token": "t" }),
    ),
    historyFloorMs: floorMs,
  };
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(ctx, null);

  const since = new URL(calls[0] ?? "").searchParams.get("since") ?? "";
  expect(Date.parse(since)).toBeCloseTo(floorMs, -4);
});

// An established cursor is more recent by construction and must win, or every
// backfill would re-walk history it has already indexed.
test("an established cursor beats historyFloorMs", async () => {
  const cursorIso = isoHoursAgo(2);
  const { calls } = stubPagerdutyPages([{ incidents: [], more: false }]);
  const db = createMemoryIndexDb();
  const ctx = {
    ...syncTestContext(
      db,
      createStubVault({ "pagerduty.api_token": "t" }),
    ),
    historyFloorMs: Date.now() - 200 * 86_400_000,
  };
  const syncable = createPagerdutySyncable({ ensurePagerdutyMcpRunning: async () => {} });
  await syncable.sync(ctx, `nimbus-pd1:${btoa(JSON.stringify({ lastUpdated: cursorIso }))}`);

  expect(new URL(calls[0] ?? "").searchParams.get("since")).toBe(cursorIso);
});
```

> **Note:** confirm the cursor encoding against `encodeNimbusJsonCursor` in `connectors/nimbus-json-cursor.ts` before relying on the `btoa` form above — if it differs, build the cursor with the real helper rather than adjusting the assertion.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/connectors/pagerduty-sync.test.ts -t "historyFloorMs"`
Expected: FAIL — `since` is 30 days ago, not 200

- [ ] **Step 3: Write minimal implementation**

Replace the `floorIso` / `since` pair:

```ts
      // Honors `SyncContext.historyFloorMs` (opt-in, see `sync/types.ts`) on a COLD
      // START only; an established cursor is more recent by construction and wins.
      // Opted in because an attribution substrate is exactly the case the mechanism
      // was built for — assembling a contribution brief needs more than 30 days of
      // history, once, without permanently widening every routine sync.
      const coldFloorMs =
        ctx.historyFloorMs !== undefined && Number.isFinite(ctx.historyFloorMs)
          ? ctx.historyFloorMs
          : now - initialSyncDepthDays * 86_400_000;
      const since = prev?.lastUpdated ?? new Date(coldFloorMs).toISOString();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/connectors/pagerduty-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/pagerduty-sync.ts packages/gateway/src/connectors/pagerduty-sync.test.ts
git commit -m "opt pagerduty into the cold-start history floor"
```

---

### Task 8: Make already-indexed incidents recoverable

**Files:**

- Modify: `packages/gateway/src/ipc/index-rebody-rpc.ts:1-10,134-137`
- Test: `packages/gateway/src/ipc/index-rebody-rpc.test.ts`

**Interfaces:**

- Consumes: `PAGERDUTY_INCIDENT_META_VERSION` (Task 2)
- Produces: `REBODY_REQUIRED_META_VERSION` gains a `pagerduty` entry

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/ipc/index-rebody-rpc.test.ts
import { PAGERDUTY_INCIDENT_META_VERSION } from "../connectors/pagerduty-attribution.ts";

test("pagerduty rows below the attribution meta version are eligible for rebody", () => {
  expect(REBODY_REQUIRED_META_VERSION.get("pagerduty")).toBe(PAGERDUTY_INCIDENT_META_VERSION);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts -t "pagerduty"`
Expected: FAIL — `expected undefined to be 1`

- [ ] **Step 3: Write minimal implementation**

```ts
import { PAGERDUTY_INCIDENT_META_VERSION } from "../connectors/pagerduty-attribution.ts";

export const REBODY_REQUIRED_META_VERSION: ReadonlyMap<string, number> = new Map([
  ["jira", TICKET_META_VERSION],
  ["linear", TICKET_META_VERSION],
  // Incidents indexed before Spec B carry no actor emails. The data was never
  // fetched, so unlike Sentry this is not recoverable from stored rows —
  // it needs a re-fetch.
  ["pagerduty", PAGERDUTY_INCIDENT_META_VERSION],
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/ipc/index-rebody-rpc.test.ts`
Expected: PASS. If a test asserts the map's size, update that count too.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/index-rebody-rpc.ts packages/gateway/src/ipc/index-rebody-rpc.test.ts
git commit -m "make pre-attribution pagerduty incidents rebody-eligible"
```

---

### Task 9: Emit the person edges

The heart of the PR. Two placement details are load-bearing and are the most likely thing to get wrong:

1. **Person edges must be emitted BEFORE the `if (affectedService === undefined) return;` bail-out.** That bail is about deploy↔incident correlation, which needs a service; attribution does not. Emitting after it silently drops attribution for every incident with no bound service.
2. **`resolves` is in `CROSS_ITEM_RELATION_TYPES` (`graph-populator.ts:90`), so `clearRelationsTouchingEntity` skips it** and it needs an explicit `clearIncomingRelationsOfType`. `assigned` is NOT in that set, so the generic clear already retires it. The two edge types retire by different mechanisms.

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts`
- Test: `packages/gateway/src/graph/graph-populator-incidents.test.ts`

**Interfaces:**

- Consumes: `usableActorEmail` (Task 1); `resolvePersonForSync` from `../people/linker.ts`
- Produces: `person --assigned--> incident` and `person --resolves--> incident` edges, with `graph_entity.external_id` on the person side set to the `person.id`

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/graph/graph-populator-incidents.test.ts
function edgesTo(db: Database, relation: string): Array<{ from_ext: string; to_ext: string }> {
  return db
    .query(
      `SELECT pe.external_id AS from_ext, ie.external_id AS to_ext
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id
         JOIN graph_entity ie ON ie.id = r.to_id
        WHERE r.type = ?
        ORDER BY pe.external_id`,
    )
    .all(relation) as Array<{ from_ext: string; to_ext: string }>;
}

function indexIncident(db: Database, id: string, metadata: Record<string, unknown>): void {
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: id,
    title: `Incident ${id}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    metadata,
  });
}

test("an assigned incident gets a person --assigned--> incident edge", () => {
  const db = freshDb();
  indexIncident(db, "PD-1", {
    service: "checkout",
    assignee_emails: ["jane@example.com"],
    resolved_by_email: null,
  });

  const edges = edgesTo(db, "assigned");
  expect(edges).toHaveLength(1);
  expect(edges[0]?.to_ext).toBe("pagerduty:PD-1");

  // The person side's external_id MUST be the person.id — catchup.ts:324
  // matches `pe.external_id = ?` against a person id, so any other encoding
  // silently breaks a reader that is already written.
  const person = db
    .query("SELECT id FROM person WHERE canonical_email = 'jane@example.com'")
    .get() as { id: string };
  expect(edges[0]?.from_ext).toBe(person.id);
});

test("a resolved incident gets a person --resolves--> incident edge", () => {
  const db = freshDb();
  indexIncident(db, "PD-2", {
    service: "checkout",
    assignee_emails: [],
    resolved_by_email: "jane@example.com",
  });
  expect(edgesTo(db, "resolves")).toHaveLength(1);
});

// The bail-out this guards is about deploy<->incident correlation, which needs
// a service. Attribution does not. Emitting after the bail silently drops
// attribution for every incident with no bound service.
test("attribution survives an incident with no affected service", () => {
  const db = freshDb();
  indexIncident(db, "PD-3", { assignee_emails: ["jane@example.com"], resolved_by_email: null });
  expect(edgesTo(db, "assigned")).toHaveLength(1);
});

// RED-PROVE BOTH: delete each clear in turn and confirm the matching assertion
// fails. `assigned` retires via the generic clearRelationsTouchingEntity;
// `resolves` is in CROSS_ITEM_RELATION_TYPES and needs the explicit incoming
// clear. A test that only asserts the NEW edge exists passes with both clears
// deleted.
test("re-syncing with different actors retires the previous edges", () => {
  const db = freshDb();
  indexIncident(db, "PD-4", {
    service: "checkout",
    assignee_emails: ["jane@example.com"],
    resolved_by_email: "jane@example.com",
  });
  expect(edgesTo(db, "assigned")).toHaveLength(1);

  indexIncident(db, "PD-4", {
    service: "checkout",
    assignee_emails: ["bob@example.com"],
    resolved_by_email: "bob@example.com",
  });

  const assigned = edgesTo(db, "assigned");
  expect(assigned).toHaveLength(1);
  const bob = db.query("SELECT id FROM person WHERE canonical_email = 'bob@example.com'").get() as {
    id: string;
  };
  expect(assigned[0]?.from_ext).toBe(bob.id);

  const resolves = edgesTo(db, "resolves");
  expect(resolves).toHaveLength(1);
  expect(resolves[0]?.from_ext).toBe(bob.id);
});

// The other direction of the same clear: an incident RE-OPENED upstream stops
// being resolved, so the connector writes `resolved_by_email: null` and the
// edge must disappear. Without the explicit incoming clear it survives forever,
// and the brief keeps crediting a resolution that was undone. The `assigned`
// edge correctly survives — they are still on the hook.
test("re-opening a resolved incident retires only the resolves edge", () => {
  const db = freshDb();
  indexIncident(db, "PD-7", {
    service: "checkout",
    assignee_emails: ["jane@example.com"],
    resolved_by_email: "jane@example.com",
  });
  expect(edgesTo(db, "resolves")).toHaveLength(1);

  indexIncident(db, "PD-7", {
    service: "checkout",
    assignee_emails: ["jane@example.com"],
    resolved_by_email: null,
  });
  expect(edgesTo(db, "resolves")).toHaveLength(0);
  expect(edgesTo(db, "assigned")).toHaveLength(1);
});

test("a malformed email creates neither an edge nor a person row", () => {
  const db = freshDb();
  indexIncident(db, "PD-5", {
    service: "checkout",
    assignee_emails: ["unknown", ""],
    resolved_by_email: "Jane Doe",
  });
  expect(edgesTo(db, "assigned")).toHaveLength(0);
  expect(edgesTo(db, "resolves")).toHaveLength(0);
  // Assert on the person TABLE, not just edge absence: the failure this guard
  // prevents is a junk row that outlives the sync.
  const n = db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number };
  expect(n.n).toBe(0);
});

test("a pr --resolves--> issue edge is untouched by an incident re-sync", () => {
  const db = freshDb();
  indexIncident(db, "PD-6", {
    service: "checkout",
    assignee_emails: [],
    resolved_by_email: "jane@example.com",
  });
  const before = edgesTo(db, "resolves").length;
  indexIncident(db, "PD-6", {
    service: "checkout",
    assignee_emails: [],
    resolved_by_email: "jane@example.com",
  });
  expect(edgesTo(db, "resolves")).toHaveLength(before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/graph/graph-populator-incidents.test.ts`
Expected: FAIL — `expected [] to have length 1`

- [ ] **Step 3: Write minimal implementation**

Add the import:

```ts
import { usableActorEmail } from "../connectors/actor-email.ts";
import { resolvePersonForSync } from "../people/linker.ts";
```

Add the two helpers above `syncTimelineEventGraph`:

```ts
/**
 * Resolve one actor email to a person and link it to `toEntityId`.
 *
 * Two distinct id spaces meet here and must not be conflated:
 * `resolvePersonForSync` returns a `person.id` (a UUID), while
 * `upsertGraphRelation`'s endpoints are `graph_entity.id` values (SHA-256, via
 * `deterministicGraphEntityId`). The person UUID is the graph entity's
 * `external_id`, never its `id` — that is also what lets `catchup.ts:324` match
 * `pe.external_id = ?` against a person id.
 *
 * `usableActorEmail` gates the call because `resolvePersonForSync` CREATES a
 * person row for whatever it is handed, and a junk row outlives the sync.
 */
function linkActorToEntity(
  db: Database,
  row: IndexedItemGraphInput,
  toEntityId: string,
  rawEmail: unknown,
  relationType: string,
  now: number,
): void {
  const email = usableActorEmail(rawEmail);
  if (email === null) return;
  const personId = resolvePersonForSync(db, { canonicalEmail: email });
  if (personId === null) return;
  const personEntityId = upsertGraphEntity(db, {
    type: "person",
    externalId: personId,
    label: personDisplayName(db, personId) ?? email,
    service: row.service,
  });
  upsertGraphRelation(db, personEntityId, toEntityId, relationType, now);
}

/**
 * `person --assigned--> incident` and `person --resolves--> incident` from the
 * emails the connector stored (spec § 5.4).
 *
 * Retirement works differently for the two types, which is the easiest thing
 * here to get wrong:
 *
 * - `assigned` is NOT in CROSS_ITEM_RELATION_TYPES, so the caller's
 *   `clearRelationsTouchingEntity` already retired it — a reassigned incident
 *   self-heals with no extra code.
 * - `resolves` IS in that set, so the generic clear deliberately skipped it and
 *   it must be retired explicitly here.
 *
 * The blanket incoming clear is safe only because no other populator emits
 * `resolves` INTO an `incident`: `syncPrGraph`'s `resolves` edges target
 * `issue` entities exclusively via `findIssueEntityIds`. If a second emitter
 * ever targets incidents, this must become endpoint-scoped.
 */
function syncIncidentPersonEdges(
  db: Database,
  row: IndexedItemGraphInput,
  incidentEntityId: string,
  now: number,
): void {
  clearIncomingRelationsOfType(db, incidentEntityId, "resolves");
  for (const email of stringArrayField(row.metadata, "assignee_emails")) {
    linkActorToEntity(db, row, incidentEntityId, email, "assigned", now);
  }
  linkActorToEntity(db, row, incidentEntityId, row.metadata["resolved_by_email"], "resolves", now);
}
```

Then call it inside `syncTimelineEventGraph`, immediately after the `correlates_with` clear pair and **before** the `if (affectedService === undefined) return;` line:

```ts
  // BEFORE the affectedService bail-out: that bail is about deploy<->incident
  // correlation, which needs a service. Attribution does not, and an incident
  // with no bound service is still someone's work.
  if (entityType === "incident") {
    syncIncidentPersonEdges(db, row, entityId, now);
  }

  // A null service correlates with nothing. Bail out only AFTER the clears.
  if (affectedService === undefined) return;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/graph/`
Expected: PASS across the whole graph directory, including `graph-populator-resolves.test.ts` and `regraph.test.ts`.

- [ ] **Step 5: Red-prove both clears**

Delete `clearIncomingRelationsOfType(db, incidentEntityId, "resolves");` and re-run — the retirement test must FAIL on the `resolves` assertion. Restore it. Then temporarily add `"assigned"` to `CROSS_ITEM_RELATION_TYPES` and re-run — the same test must FAIL on the `assigned` assertion. Restore it.

If either deletion leaves the suite green, the test is not proving retirement — fix the test before continuing.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/graph/graph-populator.ts packages/gateway/src/graph/graph-populator-incidents.test.ts
git commit -m "emit person assigned/resolves edges for pagerduty incidents"
```

---

### Task 10: The `negotiate` incidents lane

**Files:**

- Modify: `packages/gateway/src/agents/_lib/negotiate-types.ts`, `packages/gateway/src/agents/negotiate.ts`
- Test: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Consumes: the edges from Task 9
- Produces:
  - `type NegotiateIncidents = { resolved: number; assigned: number; unattributable: number; evidence: NegotiateEvidence }`
  - `NegotiateBrief.incidents: NegotiateIncidents | null`
  - `laneIncidents(db, personId, sinceMs): NegotiateIncidents`

> `errorIssuesAssigned` is deliberately NOT on this type. Nothing emits `person --assigned--> error_issue` until PR 2, and a field that can only ever be `0` is a structural zero rendered as a measurement. PR 2 adds the field in the same change that makes it real.

- [ ] **Step 1: Write the failing test**

The existing conventions in `negotiate.test.ts` are `freshDb()`, `ctxFor(db)`, people seeded with a raw `INSERT INTO person`, and the agent driven through the real `runNegotiate(input, ctx)`. Add one helper beside `seedPr`/`seedReview`, then the tests:

```ts
// append beside seedPr / seedReview in packages/gateway/src/agents/negotiate.test.ts

/**
 * Writes a pagerduty incident and lets the REAL populator build the edges —
 * `upsertIndexedItem` calls `syncGraphFromIndexedItem` synchronously. Seeding
 * graph rows by hand would test the lane against a graph shape the populator
 * never produces.
 */
function seedIncident(
  db: Database,
  id: string,
  actors: { assignees?: string[]; resolvedBy?: string | null; modifiedAt?: number },
): void {
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: id,
    title: `Incident ${id}`,
    bodyPreview: "",
    modifiedAt: actors.modifiedAt ?? Date.now(),
    syncedAt: Date.now(),
    metadata: {
      service: "checkout",
      assignee_emails: actors.assignees ?? [],
      resolved_by_email: actors.resolvedBy ?? null,
    },
  });
}

/** `resolvePersonForSync` matches on canonical_email, so it must be set. */
function seedMe(db: Database): string {
  db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
    "person:me",
    "Me",
    "jane@example.com",
  ]);
  return "person:me";
}

test("counts incidents resolved and assigned to the subject", async () => {
  const db = freshDb();
  seedMe(db);
  seedIncident(db, "PD-1", { assignees: ["jane@example.com"], resolvedBy: "jane@example.com" });
  seedIncident(db, "PD-2", { assignees: ["jane@example.com"] });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  expect(brief.incidents?.resolved).toBe(1);
  expect(brief.incidents?.assigned).toBe(2);
  db.close();
});

test("counts in-window incidents nobody could be attributed to", async () => {
  const db = freshDb();
  seedMe(db);
  seedIncident(db, "PD-1", { assignees: ["jane@example.com"] });
  seedIncident(db, "PD-2", {});

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  expect(brief.incidents?.unattributable).toBe(1);
  db.close();
});

test("excludes incidents outside the window", async () => {
  const db = freshDb();
  seedMe(db);
  seedIncident(db, "PD-OLD", {
    assignees: ["jane@example.com"],
    resolvedBy: "jane@example.com",
    modifiedAt: Date.now() - 200 * 86_400_000,
  });

  const brief = await runNegotiate(
    { sinceMs: 90 * 24 * 60 * 60 * 1000, mePersonIdOverride: "person:me" },
    ctxFor(db),
  );
  expect(brief.incidents?.resolved).toBe(0);
  db.close();
});

test("a re-synced incident counts once, not twice", async () => {
  const db = freshDb();
  seedMe(db);
  seedIncident(db, "PD-1", { assignees: ["jane@example.com"], resolvedBy: "jane@example.com" });
  seedIncident(db, "PD-1", { assignees: ["jane@example.com"], resolvedBy: "jane@example.com" });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  expect(brief.incidents?.resolved).toBe(1);
  db.close();
});
```

> **Breaking assertion — update it, do not work around it.** `negotiate.test.ts:108-112` asserts
> `expect(brief.unavailableEvidence).toEqual(["incidents resolved", "on-call shifts", "deploys triggered"])`.
> Removing the first entry makes that `toEqual` fail. Edit it to the two remaining entries; a
> `toContain` rewrite would silently stop guarding the list's exact contents.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts -t "incident"`
Expected: FAIL — `brief.incidents` is `undefined`

- [ ] **Step 3: Write minimal implementation**

Add to `negotiate-types.ts`:

```ts
/**
 * Incident work attributed to the subject (spec § 5.7).
 *
 * `unattributable` is a fact about the INDEX, not about this person: in-window
 * incidents carrying no person edge at all. It is counted rather than dropped
 * so a small `resolved` count cannot be read as "they did nothing" when the
 * real cause is an unexpanded actor payload or a token without user-read scope.
 * The same rule `NegotiateDecisions.unattributable` follows.
 */
export type NegotiateIncidents = {
  readonly resolved: number;
  readonly assigned: number;
  readonly unattributable: number;
  /** Incidents the subject RESOLVED, newest first — never drawn from `unattributable`. */
  readonly evidence: NegotiateEvidence;
};
```

and `readonly incidents: NegotiateIncidents | null;` to `NegotiateBrief`, beside `reviewedPrs`.

Add to `negotiate.ts`:

```ts
/**
 * A graph read: `person --resolves--> incident` and `person --assigned-->
 * incident`, joined back to `item` for the window cutoff — the same shape as
 * `laneTickets`. `COUNT(DISTINCT ie.id)` because one incident can carry both
 * edge types for the same person and must not count twice within a lane.
 */
function laneIncidents(db: Database, personId: string, sinceMs: number): NegotiateIncidents {
  const cutoff = Date.now() - sinceMs;
  const countEdge = (relationType: string): number =>
    (
      db
        .query(
          `SELECT COUNT(DISTINCT ie.id) AS n
             FROM graph_relation r
             JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
             JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
             JOIN item i          ON i.id = ie.external_id
            WHERE r.type = ? AND pe.external_id = ? AND i.modified_at >= ?`,
        )
        .get(relationType, personId, cutoff) as { n: number }
    ).n;

  const unattributable = (
    db
      .query(
        `SELECT COUNT(*) AS n
           FROM item i
          WHERE i.type = 'incident'
            AND i.modified_at >= ?
            AND NOT EXISTS (
                  SELECT 1
                    FROM graph_entity ie
                    JOIN graph_relation r ON r.to_id = ie.id AND r.type IN ('assigned', 'resolves')
                   WHERE ie.type = 'incident' AND ie.external_id = i.id
                )`,
      )
      .get(cutoff) as { n: number }
  ).n;

  const resolved = countEdge("resolves");
  const refs = evidenceRefsFor(
    db,
    `SELECT i.title AS title, COALESCE(i.canonical_url, i.url) AS url
       FROM graph_relation r
       JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
       JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
       JOIN item i          ON i.id = ie.external_id
      WHERE r.type = 'resolves' AND pe.external_id = ? AND i.modified_at >= ?
      ORDER BY i.modified_at DESC, i.id ASC
      LIMIT ?`,
    [personId, cutoff, NEGOTIATE_EVIDENCE_LIMIT],
  );

  return { resolved, assigned: countEdge("assigned"), unattributable, evidence: { refs, total: resolved } };
}
```

Wire it exactly as the six existing lanes are:

1. `laneNames.push("authoredPrs", "reviewedPrs", "tickets", "ownership", "decisions", "writing", "incidents");`
2. add `laneTask(() => laneIncidents(ctx.db, personId, sinceMs)),` to `tasks`
3. declare `let incidents: NegotiateIncidents | null = null;` beside the other lane results
4. add `else if (laneName === "incidents") incidents = decoded as NegotiateIncidents;`
5. add `incidents,` to the returned brief object
6. delete `"incidents resolved"` from `UNAVAILABLE_EVIDENCE` — leaving `"on-call shifts"` and `"deploys triggered"`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/negotiate.ts packages/gateway/src/agents/_lib/negotiate-types.ts packages/gateway/src/agents/negotiate.test.ts
git commit -m "add the negotiate incidents lane"
```

---

### Task 11: Render the incidents section

**Files:**

- Modify: `packages/gateway/src/agents/_lib/render.ts:687-700,908-959`
- Test: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Consumes: `NegotiateIncidents` (Task 10)
- Produces: `renderNegotiateIncidents(i: NegotiateIncidents | null): string`

> Negotiate rendering is tested in `negotiate.test.ts` — which already imports `renderNegotiate` and drives it from a real `runNegotiate` result — **not** in `_lib/render.test.ts`, which builds literal fixtures for the other agents. Follow the local convention; a hand-built `NegotiateBrief` literal here would drift from the type on the next lane.

- [ ] **Step 1: Write the failing test**

```ts
// append to packages/gateway/src/agents/negotiate.test.ts
test("renders incident counts and cites the incidents resolved", async () => {
  const db = freshDb();
  seedMe(db);
  seedIncident(db, "PD-1", { assignees: ["jane@example.com"], resolvedBy: "jane@example.com" });
  seedIncident(db, "PD-2", { assignees: ["jane@example.com"] });

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  const markdown = renderNegotiate(brief);
  expect(markdown).toContain("## Incidents");
  expect(markdown).toContain("1 resolved, 2 assigned");
  expect(markdown).toContain("Incident PD-1");
  db.close();
});

// Zero unattributable must print nothing rather than "0 attributed to nobody",
// which reads as a warning about a problem that does not exist.
test("omits the unattributable line when it is zero", async () => {
  const db = freshDb();
  seedMe(db);
  seedIncident(db, "PD-1", { assignees: ["jane@example.com"] });

  const markdown = renderNegotiate(
    await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db)),
  );
  expect(markdown).not.toContain("attributed to nobody");
  db.close();
});

// A null lane means "could not be computed" and must never render as 0 — the
// same rule every other negotiate lane follows. Driven from a brief literal
// because no real run produces a null lane without forcing a failure.
test("a null incidents lane renders as could-not-be-computed, never as zero", () => {
  const db = freshDb();
  seedMe(db);
  const base = {
    ...emptyNegotiateBriefForRender(db),
    incidents: null,
  } satisfies NegotiateBrief;
  const markdown = renderNegotiate(base);
  expect(markdown).toContain("## Incidents");
  expect(markdown).toContain("_could not be computed_");
  expect(markdown).not.toContain("0 resolved");
  db.close();
});
```

> **Implementer:** `negotiate.test.ts` already constructs a `NegotiateBrief` literal for its
> structurally-zero render tests (see the ones around `:155`, `:172`, `:200`). Reuse whatever
> that file already does to build one — extract it to `emptyNegotiateBriefForRender` if it is
> currently inline and needed twice. Do not invent a second brief-building idiom.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts -t "Incidents"`
Expected: FAIL — output contains no `## Incidents`

- [ ] **Step 3: Write minimal implementation**

```ts
/** Same "`null` ≠ `0`" rule as `renderNegotiateAuthoredPrs` — see its docstring. */
function renderNegotiateIncidents(i: NegotiateIncidents | null): string {
  if (i === null) {
    return ["## Incidents", "", "_could not be computed_"].join("\n");
  }
  const lines = [
    "## Incidents",
    "",
    `- ${String(i.resolved)} resolved, ${String(i.assigned)} assigned`,
  ];
  // Only when there is something to disclose. "0 attributed to nobody" reads as
  // a warning about a problem that does not exist.
  if (i.unattributable > 0) {
    lines.push(
      `- ${String(i.unattributable)} in-window incident(s) attributed to nobody — an unexpanded ` +
        "actor payload or a PagerDuty token without user-read scope, not necessarily inactivity",
    );
  }
  lines.push(...renderNegotiateEvidence(i.evidence));
  return lines.join("\n");
}
```

In `renderNegotiate`, add `const incidents = renderNegotiateIncidents(brief.incidents);` beside the other lane renders, and insert `incidents,` plus a `""` separator into the returned array — after `tickets` and before `ownership`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts`
Expected: PASS. Any existing test asserting the full rendered brief needs the new section added.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/render.ts packages/gateway/src/agents/negotiate.test.ts
git commit -m "render the negotiate incidents section"
```

---

### Task 12: Retire the now-false gap notes

Three strings and one comment become false the moment Task 9 merges. They claim the edge does not exist yet.

**Files:**

- Modify: `packages/gateway/src/agents/_lib/gap-notes.ts:8,70-79`, `packages/gateway/src/agents/expert.ts:410`
- Test: `packages/gateway/src/agents/expert.test.ts`, `packages/gateway/src/agents/_lib/gap-notes.test.ts`

**Interfaces:**

- Consumes: the edges from Task 9
- Produces: no API change

- [ ] **Step 1: Write the failing test**

`expert.test.ts` builds its db with `makePopulatedDb()` and drives the agent as `runExpert({ topicOrFile }, ctx)` where `ctx = { db, notify: () => {}, sessionId: "…" }`.

```ts
// append to packages/gateway/src/agents/expert.test.ts
test("the incident lane stops promising a future populator once the edge exists", async () => {
  const db = makePopulatedDb();
  db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
    "person:me",
    "Me",
    "jane@example.com",
  ]);
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "pagerduty",
    type: "incident",
    externalId: "PD-1",
    title: "Checkout 500s",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {
      service: "checkout",
      assignee_emails: ["jane@example.com"],
      resolved_by_email: "jane@example.com",
    },
  });

  const brief = await runExpert(
    { topicOrFile: "checkout" },
    { db, notify: () => {}, sessionId: "s-inc" },
  );
  const remediations = brief.gaps.map((g) => g.remediation ?? "").join(" ");
  expect(remediations).not.toContain("graph-populator follow-up");
  db.close();
});

// append to packages/gateway/src/agents/_lib/gap-notes.test.ts
test("the incident remediation no longer promises a future populator", () => {
  expect(remediationForEntityType("incident") ?? "").not.toContain("follow-up");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/agents/_lib/gap-notes.test.ts -t "incident remediation"`
Expected: FAIL — the string still reads "Tracked as a graph-populator follow-up…"

- [ ] **Step 3: Write minimal implementation**

In `gap-notes.ts`, replace the `incident` entry:

```ts
  incident:
    "Run `nimbus connector sync pagerduty`. Incidents indexed before attribution shipped carry " +
    "no actor emails — `nimbus index rebody --service pagerduty` re-fetches them.",
```

Replace the same string where `expert.ts:410` duplicates it inline, with the identical text.

Then correct the stale comment at `gap-notes.ts:70-79` — `person -> incident "resolves"` is no longer "a future" edge:

```ts
/**
 * I-2: like `detectMissingRelationEmit`, but scoped to edges of `relationType`
 * whose TARGET is `targetEntityType`. `detectMissingRelationEmit` probes for
 * *any* `graph_relation` row of the given type, of any endpoint shape — and
 * `resolves` now has TWO emitters with different endpoint shapes
 * (`pr -> issue` from `syncPrGraph`, `person -> incident` from
 * `syncIncidentPersonEdges`), so that broad probe finds the unrelated edge and
 * the gap note for the lane that still has nothing goes silently missing.
 * Scoping to the endpoint the caller's lane actually reads keeps the two
 * independent.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/gateway/src/agents/`
Expected: PASS across the whole agents directory — `catchup.test.ts` included, since `subIncidentServices` now returns rows.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/gap-notes.ts packages/gateway/src/agents/expert.ts packages/gateway/src/agents/expert.test.ts packages/gateway/src/agents/_lib/gap-notes.test.ts
git commit -m "retire the gap notes that promised a future incident populator"
```

---

### Task 13: Real-payload test, docs and the full gate

Two of the three edges depend on payload shapes that could not be verified from documentation (spec § 4.4). "Fails closed" and "emits zero rows in production while every test is green" are the same observable, so a fixture written from the same assumption as the parser cannot catch a wrong assumption.

**Files:**

- Create: `packages/gateway/src/connectors/__fixtures__/pagerduty-incidents-expanded.json`
- Modify: `packages/gateway/src/connectors/pagerduty-sync.test.ts`, `docs/CHANGELOG.md`, `docs/architecture.md`

- [ ] **Step 1: Capture a real payload**

Against a real PagerDuty account with at least one resolved, assigned incident:

```bash
curl -s -H "Accept: application/vnd.pagerduty+json;version=2" \
     -H "Authorization: Token token=$PD_TOKEN" \
     "https://api.pagerduty.com/incidents?limit=5&statuses[]=resolved&include[]=assignees&include[]=acknowledgers&include[]=users" \
  > packages/gateway/src/connectors/__fixtures__/pagerduty-incidents-expanded.json
```

Then **redact before committing**: replace every real email with `@example.com` addresses, every `html_url` with `https://pd.example/...`, and drop `summary` fields carrying customer or hostname detail. Keep the STRUCTURE — key names, nesting, and the `type` discriminators — exactly as returned. Structure is the whole point of the fixture.

- [ ] **Step 2: Record what the payload actually proved**

In the fixture's test, write down which of the two unverified assumptions the real response settled:

```ts
// append to packages/gateway/src/connectors/pagerduty-sync.test.ts
import expandedPage from "./__fixtures__/pagerduty-incidents-expanded.json";

/**
 * Captured from a live PagerDuty account on <DATE>, then redacted (emails,
 * urls, summaries). Structure is verbatim.
 *
 * Settles spec § 4.4's open question: `include[]` <DOES / DOES NOT> expand
 * `last_status_change_by`. <If it does not, the ladder's step 2/3 is what
 * carries resolver attribution in production — say so here.>
 */
test("attributes a real captured PagerDuty page", () => {
  const incidents = (expandedPage as { incidents: unknown[] }).incidents;
  const emailById = pagerdutyEmailMapFromIncidents(incidents);
  expect(emailById.size).toBeGreaterThan(0);

  const resolved = incidents
    .map((raw) => extractPagerdutyActors(raw as Record<string, unknown>, emailById))
    .filter((a) => a.resolvedByEmail !== null);
  expect(resolved.length).toBeGreaterThan(0);
});
```

If the real payload contradicts the spec, **stop and report it** rather than adjusting the test to match the parser. That inversion is the failure this task exists to prevent.

- [ ] **Step 3: Update the docs**

- `docs/CHANGELOG.md` — a dated entry under the current unreleased heading: incident attribution, the two edges, the `nimbus index rebody --service pagerduty` recovery path and its window, and that PagerDuty tokens now need user-read scope for resolver attribution.
- `docs/architecture.md` — add `assigned` / `resolves` (person → incident) to the graph-edge documentation.

Do **not** document a command you have not run. Run `nimbus index rebody --service pagerduty` and state the window it actually reports.

- [ ] **Step 4: Run the full gate**

```bash
bun run preflight:fast
bun test packages/gateway/src/connectors/ packages/gateway/src/graph/ packages/gateway/src/agents/
bun run preflight
```

Expected: all green. If `audit:coverage-floor` fails, remember it is CI-Linux-authoritative — reproduce via `bun run verify:docker` rather than trusting the local result.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/__fixtures__/ packages/gateway/src/connectors/pagerduty-sync.test.ts docs/CHANGELOG.md docs/architecture.md
git commit -m "prove attribution against a real payload and document the recovery path"
```

---

## Self-Review

**Spec coverage.** § 5.1 identity split → Tasks 1, 6, 9. § 5.2 connector changes → Tasks 4, 6. § 5.3 resolver ladder → Tasks 3, 5. § 5.4 population + clearing → Task 9. § 5.6 backfill → Tasks 7, 8. § 5.7 readers → Tasks 10, 11 (`catchup`/`expert`/`decision-corroborate` need no code; Task 12 verifies). § 5.8 honesty → Tasks 10, 11, 12. § 7 failure behaviour → Tasks 3, 5, 9. § 8 testing → items 1 and 6 in Task 9, item 2 in Task 13, items 4–5 in Task 5, item 7 in Tasks 10–12.

**Not covered, deliberately:** § 5.5 Sentry population and § 8's item 3 (`regraph` from stored rows) belong to PR 2 — Sentry attribution is populator-only and shares no code path with this PR beyond Task 1's guard. § 5.6.1's pagination stall is deferred by the spec itself.

**Known deviation from the spec text:** the spec's § 5.7 sketch types `refs` as a bare array; the house type is `NegotiateEvidence { refs, total }` (`negotiate-types.ts:59`) and Task 10 follows the house type. The spec's sketch also lists `errorIssuesAssigned`, which Task 10 defers to PR 2 so the field never renders as a structural zero.

**Type consistency.** `usableActorEmail` (Tasks 1, 5, 9), `pagerdutyEmailMapFromIncidents` (Tasks 2, 5, 13), `extractPagerdutyActors` (Tasks 3, 6, 13), `pagerdutyUnresolvedActorIds` (Tasks 3, 5), `PAGERDUTY_INCIDENT_META_VERSION` (Tasks 2, 6, 8), `MAX_USER_LOOKUPS_PER_SYNC` (Task 5), `NegotiateIncidents` (Tasks 10, 11) — each spelled identically at every use.

**Interface change to flag:** Task 6 makes `emailById` a required fifth parameter of the exported `syncPagerdutyIncidentItems`, which `graph-populator-incidents.test.ts` already calls. Task 6's step 4 updates it.

**Existing assertion this PR breaks:** `negotiate.test.ts:108-112` asserts `unavailableEvidence` `toEqual` a three-element array including `"incidents resolved"`. Task 10 removes that entry, so the assertion must be edited to the two remaining entries — flagged inline in Task 10 because a `toContain` rewrite would quietly stop guarding the list.

**Test-helper names were verified against the tree, not assumed.** A first draft of this plan cited `freshNegotiateDb`, `seedPerson`, `runNegotiate(db, …)`, `freshExpertDb`, `runExpert(db, …)` and `negotiateBriefFixture` — **none of which exist**. The real conventions are `freshDb()` / `ctxFor(db)` / `runNegotiate(input, ctx)` in `negotiate.test.ts`, `makePopulatedDb()` / `runExpert({ topicOrFile }, ctx)` in `expert.test.ts`, people seeded by raw `INSERT INTO person`, and negotiate rendering tested in `negotiate.test.ts` rather than `_lib/render.test.ts`. Tasks 10–12 use the real names. Any future edit to this plan should re-verify the same way — a plan that names a non-existent helper produces a test file that silently tests nothing.
