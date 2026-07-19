# Stage 0 — Seal the Narrow Waist: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `NimbusItem` a single, honest, machine-enforced contract shared by the gateway, the client and every downstream client — eliminating three live bugs caused by four hand-copied item-type enums that disagree.

**Architecture:** `@nimbus-dev/sdk` becomes the sole source of truth for `NimbusItem` and its item-type vocabulary, exported as an **open enum** (`KnownItemType | (string & {})`) plus a runtime `KNOWN_ITEM_TYPES` array. The gateway imports it and deletes its lossy coercion. The client stops passing `queryItems` rows through unvalidated and returns real `NimbusItem[]`, normalising the gateway's snake_case wire rows to the SDK's camelCase. A conformance test locks the wire shape so drift fails CI. `nimbus-vscode` deletes its private mirror and consumes the real type.

Licensing fixes the direction of the dependency: `nimbus-sdk` and `nimbus-client` are MIT, `Nimbus` is AGPL-3.0. MIT into AGPL is fine; the reverse would infect. The gateway already depends on `@nimbus-dev/sdk` `^1.3.0`, so no new dependency edge is created.

**Tech Stack:** TypeScript (strict), Bun (`bun test`) in `nimbus-sdk` and `nimbus-client`, Vitest in `nimbus-vscode`, Biome for lint in all three, release-please + npm trusted publishing for both packages.

## Context: the three bugs this fixes

All three have the same root cause — the SDK's `itemType` union lists six values (`file`, `folder`, `email`, `event`, `photo`, `task`) while the gateway emits nineteen, and `task`/`folder` are not among them.

1. **Silent data corruption inside the gateway.** `packages/gateway/src/index/local-index.ts:94` coerces any unrecognised type to `"file"`:

   ```ts
   function itemTypeFromRowType(raw: string): NimbusItem["itemType"] {
     if (raw === "file" || raw === "folder" || raw === "email" ||
         raw === "event" || raw === "photo" || raw === "task") {
       return raw;
     }
     return "file";
   }
   ```

   Every `deployment`, `alert`, `incident`, `pr`, `issue`, `pipeline_run`, `dashboard`, `infra_resource`, `log_alarm`, `data_model`, `data_pipeline`, `ml_model`, `data_quality_test`, `api_endpoint` and `obsidian_note` read through `rowToItem` is **relabelled `"file"`** — mislabelled, not dropped.

2. **Unvalidated wire passthrough.** `nimbus-client/src/nimbus-client.ts:263` returns `Record<string, unknown>[]` — the only public method with no validator, so nothing catches a shape change.

3. **A dead view in VS Code.** `nimbus-vscode/src/sidebar/index.ts:81` reads `rec["itemType"]` while the gateway sends `item_type` (`SELECT * FROM item`, `packages/gateway/src/index/item-list-query.ts:37`). It has never rendered a type or sorted by time.

See [`docs/ecosystem-roadmap.md`](../../ecosystem-roadmap.md) § Stage 0.

## Global Constraints

- TypeScript **strict**, **no `any`** — use `unknown` for external data. Biome enforces this in all three repos.
- The item-type vocabulary is an **open enum**. `docs/schema-reference.md` describes it as "open enum, extended per connector", and `docs/roadmap.md` plans to add `service`, `team`, `scorecard`, `dora_metric`, `security_finding`, `posture_finding`, `sbom_artifact`, `llm_trace`, `prompt_version`, `eval_run`, `vector_index`, `ai_spend_event`. A closed union would force exactly the coercion this plan deletes, and every future type addition would be a breaking change.
- **No unknown item type may ever be silently rewritten to another value.** Preserving an unrecognised type verbatim is required behaviour, not a nicety.
- `@nimbus-dev/sdk` ships as **1.4.0** (minor, additive). Widening a union and adding exports is non-breaking; the gateway's `^1.3.0` range resolves it without a manifest edit.
- `@nimbus-dev/client` ships as **0.6.0** (minor). Its `queryItems` return type changes, which is breaking for a 1.x package but permitted pre-1.0; it is called in exactly one place across the ecosystem (`nimbus-vscode/src/extension.ts:454`).
- Both packages release via **release-please** on merge to `main`; do not hand-edit `package.json` versions or `CHANGELOG.md`, and PR titles must be Conventional Commits.
- Never reach past the typed client. `IPCClient.call` stays out of bounds for consumers.
- Do not touch `vault.*` or `db.*`.

## Ordering and the release hops

Two npm publishes sit on the critical path. `nimbus-client` has `bun run verify:sdk`, which builds and packs the sibling `../nimbus-sdk` checkout into the client — so **Tasks 3 and 4 can be developed and tested before the SDK is published**, and only the client's *merge* waits on the real 1.4.0.

```text
Task 1 (sdk)  ──publish 1.4.0──┬── Task 2 (gateway)
                               │
                               └── Task 3 → Task 4 (client) ──publish 0.6.0── Task 5 (vscode)
```

Task 2 and Tasks 3–4 are independent of each other and may run in parallel.

## File structure

| File | Repo | Responsibility |
| --- | --- | --- |
| `src/types.ts` (modify) | `nimbus-sdk` | `NimbusItem`, `KnownItemType`, `ItemType` — the contract |
| `src/item-types.ts` (create) | `nimbus-sdk` | `KNOWN_ITEM_TYPES` runtime array + `isKnownItemType` guard |
| `src/item-types.test.ts` (create) | `nimbus-sdk` | Locks the vocabulary against `schema-reference.md` |
| `src/index.ts` (modify) | `nimbus-sdk` | Re-export the new symbols |
| `packages/gateway/src/index/local-index.ts` (modify) | `Nimbus` | Delete the lossy coercion |
| `packages/gateway/src/index/local-index.test.ts` (modify) | `Nimbus` | Prove ops types survive a round-trip |
| `src/validate.ts` (modify) | `nimbus-client` | `validateQueryItems` — snake_case → `NimbusItem` |
| `src/nimbus-client.ts` (modify) | `nimbus-client` | `queryItems` returns `NimbusItem[]` |
| `src/mock-client.ts` (modify) | `nimbus-client` | Parity stub |
| `test/query-items-conformance.test.ts` (create) | `nimbus-client` | **The gate** — wire shape locked to a golden fixture |
| `test/fixtures/query-items-rows.json` (create) | `nimbus-client` | Golden rows captured from a real gateway |
| `src/sidebar/index.ts` (modify) | `nimbus-vscode` | Delete the private mirror; consume `NimbusItem` |

---

## Task 1: SDK — the item-type contract

**Repo:** `nimbus-sdk` (`C:/gitrep/nimbus-sdk`)

**Files:**

- Create: `src/item-types.ts`
- Create: `src/item-types.test.ts`
- Modify: `src/types.ts:5-17`
- Modify: `src/index.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type KnownItemType` — union of the 19 emitted types.
  - `type ItemType = KnownItemType | (string & {})` — the open enum.
  - `const KNOWN_ITEM_TYPES: readonly KnownItemType[]`.
  - `function isKnownItemType(v: unknown): v is KnownItemType`.
  - `interface NimbusItem` with `itemType: ItemType` (all other fields unchanged).

- [ ] **Step 1: Write the failing test**

Create `src/item-types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { isKnownItemType, KNOWN_ITEM_TYPES } from "./item-types.ts";
import type { ItemType, NimbusItem } from "./types.ts";

// The authoritative list lives in the gateway's docs/schema-reference.md SQL
// comment. This test is the machine-readable copy; if the gateway adds a type,
// this list and that comment must change together.
const EMITTED = [
  "file", "email", "event", "photo",
  "pr", "issue", "pipeline_run", "deployment",
  "alert", "incident", "infra_resource",
  "data_model", "data_pipeline", "dashboard", "log_alarm",
  "ml_model", "data_quality_test",
  "api_endpoint", "obsidian_note",
];

describe("KNOWN_ITEM_TYPES", () => {
  test("contains exactly the types the gateway emits", () => {
    expect([...KNOWN_ITEM_TYPES].sort()).toEqual([...EMITTED].sort());
  });

  test("does not contain types the gateway never emits", () => {
    // schema-reference.md: 'task' is not a currently emitted item_type.
    expect(KNOWN_ITEM_TYPES).not.toContain("task");
    expect(KNOWN_ITEM_TYPES).not.toContain("folder");
  });

  test("includes the ops types that matter to the on-call ICP", () => {
    for (const t of ["deployment", "alert", "incident", "pipeline_run", "pr", "issue"]) {
      expect(KNOWN_ITEM_TYPES).toContain(t);
    }
  });
});

describe("isKnownItemType", () => {
  test("accepts an emitted type", () => {
    expect(isKnownItemType("deployment")).toBe(true);
  });

  test("rejects an unknown string", () => {
    expect(isKnownItemType("not_a_type")).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isKnownItemType(undefined)).toBe(false);
    expect(isKnownItemType(42)).toBe(false);
  });
});

describe("ItemType is an open enum", () => {
  test("a future gateway type is assignable without an SDK release", () => {
    // roadmap.md Phase 7+ plans 'service', 'scorecard', 'dora_metric', ...
    const future: ItemType = "dora_metric";
    expect(future).toBe("dora_metric");
  });

  test("NimbusItem accepts an unknown type verbatim", () => {
    const item: NimbusItem = { id: "x:1", service: "x", itemType: "brand_new", name: "n" };
    expect(item.itemType).toBe("brand_new");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd C:/gitrep/nimbus-sdk && bun test src/item-types.test.ts
```

Expected: FAIL — `Cannot find module './item-types.ts'`.

- [ ] **Step 3: Create the implementation**

Create `src/item-types.ts`:

```ts
/**
 * The item-type vocabulary the Nimbus gateway emits into `indexed_items`.
 *
 * This is an OPEN enum. The authoritative list is the SQL comment in the
 * gateway's `docs/schema-reference.md`, and that list grows (roadmap.md Phase 7+
 * adds `service`, `team`, `scorecard`, `dora_metric`, `security_finding`,
 * `llm_trace`, ...). `KnownItemType` gives autocomplete and exhaustiveness for
 * the types that exist today; `ItemType` accepts anything, so a gateway that
 * ships a new type does NOT break every client that has not upgraded.
 *
 * The one thing consumers must never do is rewrite an unrecognised type to a
 * recognised one — that is data corruption, and it is exactly the bug this
 * module exists to remove.
 */

export const KNOWN_ITEM_TYPES = [
  "file",
  "email",
  "event",
  "photo",
  "pr",
  "issue",
  "pipeline_run",
  "deployment",
  "alert",
  "incident",
  "infra_resource",
  "data_model",
  "data_pipeline",
  "dashboard",
  "log_alarm",
  "ml_model",
  "data_quality_test",
  "api_endpoint",
  "obsidian_note",
] as const;

/** A type the gateway is known to emit today. */
export type KnownItemType = (typeof KNOWN_ITEM_TYPES)[number];

const KNOWN = new Set<string>(KNOWN_ITEM_TYPES);

/** True when `v` is one of the types this SDK version knows about. */
export function isKnownItemType(v: unknown): v is KnownItemType {
  return typeof v === "string" && KNOWN.has(v);
}
```

- [ ] **Step 4: Widen `NimbusItem`**

In `src/types.ts`, replace lines 5-17 with:

```ts
import type { KnownItemType } from "./item-types.ts";

/**
 * An indexed item's type. Open by design — see `item-types.ts`. The
 * `(string & {})` arm keeps editor autocomplete for KnownItemType while
 * accepting types a newer gateway emits.
 */
export type ItemType = KnownItemType | (string & {});

export interface NimbusItem {
  id: string;
  service: string;
  itemType: ItemType;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  createdAt?: number;
  modifiedAt?: number;
  url?: string;
  parentId?: string;
  rawMeta?: Record<string, unknown>;
}
```

- [ ] **Step 5: Re-export from the barrel**

In `src/index.ts`, add alongside the existing `./types` export:

```ts
export { isKnownItemType, KNOWN_ITEM_TYPES } from "./item-types.ts";
export type { KnownItemType } from "./item-types.ts";
export type { ItemType } from "./types.ts";
```

- [ ] **Step 6: Run the tests and the gate**

```bash
cd C:/gitrep/nimbus-sdk && bun test src/item-types.test.ts && bun run typecheck && bun run lint && bun test
```

Expected: all PASS. If an existing test asserts `itemType` is one of the old six, update it — the old vocabulary was wrong.

- [ ] **Step 7: Commit**

```bash
cd C:/gitrep/nimbus-sdk
git checkout -b feat/item-type-contract
git add src/item-types.ts src/item-types.test.ts src/types.ts src/index.ts
git commit -m "feat: make NimbusItem.itemType the real, open item-type vocabulary

The union listed six values (file/folder/email/event/photo/task) while the
gateway emits nineteen, and neither 'folder' nor 'task' is among them. Every
consumer that trusted this type was wrong about deployments, alerts, incidents,
PRs, issues and pipeline runs.

Adds KNOWN_ITEM_TYPES (the 19 emitted types), KnownItemType, isKnownItemType,
and an open ItemType so a gateway that ships a new type does not break clients
that have not upgraded. Additive and non-breaking: previously-valid literals
still typecheck as strings."
```

- [ ] **Step 8: Open the PR and merge; let release-please publish 1.4.0**

```bash
gh pr create --title "feat: make NimbusItem.itemType the real, open item-type vocabulary"
```

Wait for the release PR to merge and `@nimbus-dev/sdk@1.4.0` to appear:

```bash
npm view @nimbus-dev/sdk version
```

Expected: `1.4.0`.

---

## Task 2: Gateway — delete the lossy coercion

**Repo:** `Nimbus` (`C:/gitrep/Nimbus`). **Depends on:** Task 1 published.

**Files:**

- Modify: `packages/gateway/src/index/local-index.ts:94-105`
- Modify: `packages/gateway/src/index/local-index.test.ts`

**Interfaces:**

- Consumes: `NimbusItem`, `ItemType` from `@nimbus-dev/sdk` (Task 1).
- Produces: no new exports. `rowToItem` keeps its signature; only its fidelity changes.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/index/local-index.test.ts`:

Add these next to the existing `"upsert with itemType 'event' round-trips as event"` test (line ~113), reusing that file's `makeIndex()` and `makeItem()` helpers:

```ts
test("upsert round-trips every ops item type instead of coercing to file", () => {
  const idx = makeIndex();
  const opsTypes = ["deployment", "alert", "incident", "pipeline_run", "pr", "issue"];
  for (const t of opsTypes) {
    idx.upsert(makeItem({ id: `ops-${t}`, itemType: t, name: `ops item ${t}` }));
  }
  for (const t of opsTypes) {
    const hits = idx.search({ name: `ops item ${t}` });
    expect(hits.find((h) => h.id === `ops-${t}`)?.itemType).toBe(t);
  }
});

test("upsert round-trips an item type this gateway build does not know", () => {
  const idx = makeIndex();
  idx.upsert(makeItem({ id: "future-1", itemType: "dora_metric", name: "future typed item" }));
  const hits = idx.search({ name: "future typed item" });
  expect(hits.find((h) => h.id === "future-1")?.itemType).toBe("dora_metric");
});
```

`makeItem` is `(overrides: Partial<NimbusItem> = {}) => NimbusItem` at line 24; `makeIndex()` at line 18 returns a `LocalIndex`; `idx.upsert(item)` is line 483 and `idx.search({ name })` is line 711 — the method that maps rows through `rowToItem`.

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd C:/gitrep/Nimbus && bun test packages/gateway/src/index/local-index.test.ts
```

Expected: FAIL — received `"file"` for every ops type. **This failure is the bug reproduced.** Record the output.

- [ ] **Step 3: Delete the coercion**

In `packages/gateway/src/index/local-index.ts`, delete the whole `itemTypeFromRowType` function (lines 94-105) and replace its single call site in `rowToItem` with a direct read. The raw column value IS the item type; the SDK's open `ItemType` accepts it.

```ts
// Before (in rowToItem):
//   itemType: itemTypeFromRowType(row.item_type),
// After:
    itemType: row.item_type,
```

If `ItemRow.item_type` is typed `string`, no cast is needed — `string` is assignable to the open `ItemType`.

- [ ] **Step 4: Run the tests**

```bash
cd C:/gitrep/Nimbus && bun test packages/gateway/src/index/local-index.test.ts
```

Expected: PASS.

- [ ] **Step 5: Confirm no other coercion survives**

```bash
cd C:/gitrep/Nimbus && grep -rn "itemTypeFromRowType" packages/ --include=*.ts
grep -rn '"folder"\|"task"' packages/gateway/src/index/ --include=*.ts
```

Expected: the first returns nothing. Investigate any hit from the second — those are the never-emitted values, and any surviving reference is likely the same bug in another spelling.

- [ ] **Step 6: Run the repo gate**

```bash
cd C:/gitrep/Nimbus && bun run typecheck && bun run lint && bun test packages/gateway/src/index/
```

Expected: all PASS.

- [ ] **Step 7: Commit and open the PR**

```bash
cd C:/gitrep/Nimbus
git checkout -b fix/item-type-coercion
git add packages/gateway/src/index/local-index.ts packages/gateway/src/index/local-index.test.ts
git commit -m "fix: stop relabelling every ops item type as \"file\"

itemTypeFromRowType() accepted only the six values in the old SDK union and
returned \"file\" for everything else, so every deployment, alert, incident, pr,
issue, pipeline_run, dashboard, infra_resource and log_alarm read through
rowToItem came back mislabelled rather than merely untyped.

@nimbus-dev/sdk 1.4.0 makes ItemType an open enum, so the raw column value can
be passed through unchanged. Adds regression tests for the ops types and for a
type this build does not know."
gh pr create --title "fix: stop relabelling every ops item type as \"file\""
```

---

## Task 3: Client — validate `queryItems`

**Repo:** `nimbus-client` (`C:/gitrep/nimbus-client`). **Can start immediately** via `bun run verify:sdk`; merge waits on SDK 1.4.0.

**Files:**

- Modify: `src/validate.ts`
- Modify: `src/nimbus-client.ts:174-180` (interface) and `:263-279` (implementation)
- Modify: `src/mock-client.ts:102-110`
- Modify: `test/nimbus-client.test.ts`

**Interfaces:**

- Consumes: `NimbusItem` from `@nimbus-dev/sdk` (Task 1).
- Produces:
  - `validateQueryItems(method: string, v: unknown): { items: NimbusItem[]; meta: { limit: number; total: number } }` exported from `src/validate.ts`.
  - `NimbusClientLike.queryItems(...)` now returns `Promise<{ items: NimbusItem[]; meta: { limit: number; total: number } }>`.

- [ ] **Step 1: Point the client at the local SDK**

```bash
cd C:/gitrep/nimbus-client && bun run verify:sdk
```

Expected: builds and packs `../nimbus-sdk`, installs it, runs the client's checks. This is how Tasks 3-4 proceed before 1.4.0 is on npm.

- [ ] **Step 2: Write the failing test**

Add to `test/nimbus-client.test.ts`, using that file's existing `FakeIpc` class (constructed with an array of queued responses) and `makeClient(ipc)` helper at line 38. Put these beside the existing `"queryItems forwards all filter params"` test at line ~91, which must keep passing unchanged.

```ts
describe("queryItems result validation", () => {
  test("maps the gateway's snake_case row onto NimbusItem", async () => {
    const ipc = new FakeIpc([
      {
        items: [
          {
            id: "github:42",
            service: "github",
            item_type: "deployment",
            name: "deploy prod",
            modified_at: 1_700_000_000_000,
            created_at: 1_600_000_000_000,
            url: "https://example.test/d/42",
            mime_type: "application/json",
            size_bytes: 12,
            parent_id: "github:1",
          },
        ],
        meta: { limit: 50, total: 1 },
      },
    ]);

    const { items, meta } = await makeClient(ipc).queryItems({ limit: 50 });

    expect(items[0]).toEqual({
      id: "github:42",
      service: "github",
      itemType: "deployment",
      name: "deploy prod",
      mimeType: "application/json",
      sizeBytes: 12,
      createdAt: 1_600_000_000_000,
      modifiedAt: 1_700_000_000_000,
      url: "https://example.test/d/42",
      parentId: "github:1",
    });
    expect(meta).toEqual({ limit: 50, total: 1 });
  });

  test("omits optional fields the row does not carry", async () => {
    const ipc = new FakeIpc([
      { items: [{ id: "x:1", service: "x", item_type: "file", name: "n" }], meta: { limit: 1, total: 1 } },
    ]);
    const { items } = await makeClient(ipc).queryItems({});
    expect(items[0]).toEqual({ id: "x:1", service: "x", itemType: "file", name: "n" });
  });

  test("preserves an item type this client version does not know", async () => {
    const ipc = new FakeIpc([
      { items: [{ id: "x:1", service: "x", item_type: "dora_metric", name: "n" }], meta: { limit: 1, total: 1 } },
    ]);
    const { items } = await makeClient(ipc).queryItems({});
    expect(items[0]?.itemType).toBe("dora_metric");
  });

  test("throws IpcResponseError when items is not an array", async () => {
    const ipc = new FakeIpc([{ items: "nope", meta: { limit: 0, total: 0 } }]);
    await expect(makeClient(ipc).queryItems({})).rejects.toBeInstanceOf(IpcResponseError);
  });

  test("throws IpcResponseError when a row is missing id", async () => {
    const ipc = new FakeIpc([
      { items: [{ service: "x", item_type: "file", name: "n" }], meta: { limit: 1, total: 1 } },
    ]);
    await expect(makeClient(ipc).queryItems({})).rejects.toBeInstanceOf(IpcResponseError);
  });
});
```

`IpcResponseError` is exported from `../src/validate.ts`; add it to the file's existing import list if it is not already there.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd C:/gitrep/nimbus-client && bun test test/nimbus-client.test.ts
```

Expected: FAIL — rows come back snake_case and untyped.

- [ ] **Step 4: Add the validator**

In `src/validate.ts`, import the type and append the guard, following the existing `record`/`str`/`num` helper style:

```ts
import type { NimbusItem } from "@nimbus-dev/sdk";

function optStr(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

function optNum(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The gateway answers index.queryItems with raw `SELECT * FROM item` rows, so
 * the wire shape is snake_case while NimbusItem is camelCase. Normalise here —
 * this is the seam where the two conventions meet, and leaving it to callers is
 * what let the VS Code Index view read `itemType` and silently get undefined.
 *
 * `itemType` is passed through verbatim: ItemType is an open enum and rewriting
 * an unrecognised type would be data corruption.
 */
export function validateQueryItems(
  method: string,
  v: unknown,
): { items: NimbusItem[]; meta: { limit: number; total: number } } {
  const o = record(method, v);
  const rawItems = o["items"];
  if (!Array.isArray(rawItems)) {
    throw new IpcResponseError(method, '"items" must be an array');
  }

  const items = rawItems.map((raw): NimbusItem => {
    const r = record(method, raw);
    const item: NimbusItem = {
      id: str(method, r, "id"),
      service: str(method, r, "service"),
      itemType: str(method, r, "item_type"),
      name: str(method, r, "name"),
    };
    const mimeType = optStr(r, "mime_type");
    if (mimeType !== undefined) item.mimeType = mimeType;
    const sizeBytes = optNum(r, "size_bytes");
    if (sizeBytes !== undefined) item.sizeBytes = sizeBytes;
    const createdAt = optNum(r, "created_at");
    if (createdAt !== undefined) item.createdAt = createdAt;
    const modifiedAt = optNum(r, "modified_at");
    if (modifiedAt !== undefined) item.modifiedAt = modifiedAt;
    const url = optStr(r, "url");
    if (url !== undefined) item.url = url;
    const parentId = optStr(r, "parent_id");
    if (parentId !== undefined) item.parentId = parentId;
    return item;
  });

  const meta = record(method, o["meta"]);
  return { items, meta: { limit: num(method, meta, "limit"), total: num(method, meta, "total") } };
}
```

- [ ] **Step 5: Wire it into the client**

In `src/nimbus-client.ts`, add `import type { NimbusItem } from "@nimbus-dev/sdk";`, change **both** the `NimbusClientLike` signature (line ~180) and the `NimbusClient` implementation (line ~263) return type to `Promise<{ items: NimbusItem[]; meta: { limit: number; total: number } }>`, and route the result through the guard:

```ts
  async queryItems(params: {
    services?: string[];
    types?: string[];
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
  }): Promise<{ items: NimbusItem[]; meta: { limit: number; total: number } }> {
    const raw = await this.ipc.call("index.queryItems", params);
    return validateQueryItems("index.queryItems", raw);
  }
```

- [ ] **Step 6: Update the mock for parity**

In `src/mock-client.ts`, change the stub's return type to match. The shared interface makes the compiler enforce this:

```ts
  async queryItems(_params: {
    services?: string[];
    types?: string[];
    sinceMs?: number;
    untilMs?: number;
    limit?: number;
  }): Promise<{ items: NimbusItem[]; meta: { limit: number; total: number } }> {
    const items = this.fixtures.items ?? [];
    return { items, meta: { limit: items.length, total: items.length } };
  }
```

Type `MockClientFixtures.items` as `NimbusItem[]` and delete the `as unknown as` cast — that cast existed only because the real type was wrong.

- [ ] **Step 7: Run the tests and the gate**

```bash
cd C:/gitrep/nimbus-client && bun test && bun run typecheck && bun run lint
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
cd C:/gitrep/nimbus-client
git checkout -b feat/validate-query-items
git add src/validate.ts src/nimbus-client.ts src/mock-client.ts test/nimbus-client.test.ts
git commit -m "feat!: queryItems returns validated NimbusItem[] instead of raw rows

queryItems was the only public method with no runtime validator: it returned
the gateway's raw \`SELECT * FROM item\` rows as Record<string, unknown>[], so
the snake_case wire shape leaked to every caller. nimbus-vscode read
rec[\"itemType\"] against a wire field named item_type and silently got
undefined on every row.

Adds validateQueryItems, which normalises snake_case to NimbusItem and throws
IpcResponseError on a malformed row. itemType passes through verbatim — ItemType
is an open enum and rewriting an unrecognised type would be data corruption."
```

---

## Task 4: Client — the conformance gate

**Repo:** `nimbus-client`. **Depends on:** Task 3.

This is the task that makes Stage 0 durable: without it, the next shape drift is silent again.

**Files:**

- Create: `test/fixtures/query-items-rows.json`
- Create: `test/query-items-conformance.test.ts`

**Interfaces:**

- Consumes: `validateQueryItems` (Task 3).
- Produces: no runtime exports — a CI gate only.

- [ ] **Step 1: Capture golden rows from a real gateway**

With a gateway running and an index containing at least one ops item:

```bash
cd C:/gitrep/Nimbus && nimbus query "SELECT * FROM item LIMIT 5" --json
```

Save the raw rows verbatim to `C:/gitrep/nimbus-client/test/fixtures/query-items-rows.json` as `{ "items": [ ... ], "meta": { "limit": 5, "total": 5 } }`. **Do not hand-write these** — the point is that they are what the gateway actually sends. Redact values if needed, but never rename a key.

If no gateway is available, generate the rows from the gateway's own schema by inserting a row through `upsertNimbusItemIntoItemTable` and dumping it; record in the fixture file's sibling `README` which method was used.

- [ ] **Step 2: Write the failing test**

Create `test/query-items-conformance.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { KNOWN_ITEM_TYPES } from "@nimbus-dev/sdk";
import { validateQueryItems } from "../src/validate.ts";
import golden from "./fixtures/query-items-rows.json" with { type: "json" };

/**
 * The conformance gate.
 *
 * `validateQueryItems` hand-transcribes the gateway's wire shape; nothing links
 * the two at compile time. This test pins the transcription to rows the gateway
 * actually produced, so a column rename upstream fails here instead of silently
 * yielding undefined fields in every downstream client.
 *
 * When this fails: re-capture the fixture from a current gateway, then fix the
 * validator to match. Do not edit the fixture by hand to make it pass.
 */
describe("index.queryItems conformance", () => {
  test("every golden row validates", () => {
    expect(() => validateQueryItems("index.queryItems", golden)).not.toThrow();
  });

  test("no required field comes back undefined", () => {
    const { items } = validateQueryItems("index.queryItems", golden);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.id).toBeTruthy();
      expect(item.service).toBeTruthy();
      expect(item.name).toBeTruthy();
      expect(item.itemType).toBeTruthy();
    }
  });

  test("the wire uses snake_case, so the validator must be mapping it", () => {
    const first = (golden as { items: Record<string, unknown>[] }).items[0];
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {})).toContain("item_type");
    expect(Object.keys(first ?? {})).not.toContain("itemType");
  });

  test("every itemType in the fixture is one this SDK knows", () => {
    const { items } = validateQueryItems("index.queryItems", golden);
    const unknown = items.map((i) => i.itemType).filter((t) => !KNOWN_ITEM_TYPES.includes(t as never));
    // Not a hard failure of the open enum — a signal the SDK vocabulary is stale.
    expect(unknown).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it**

```bash
cd C:/gitrep/nimbus-client && bun test test/query-items-conformance.test.ts
```

Expected: PASS. If the last test fails, the gateway emits a type the SDK does not list — add it in `nimbus-sdk/src/item-types.ts` and its test, and cut another SDK release. **That is the gate working.**

- [ ] **Step 4: Prove the gate actually catches drift**

Temporarily rename `item_type` to `itemType` in one fixture row and re-run:

```bash
cd C:/gitrep/nimbus-client && bun test test/query-items-conformance.test.ts
```

Expected: FAIL. Revert the fixture and confirm it passes again. A gate never observed failing is not a gate.

- [ ] **Step 5: Commit**

```bash
cd C:/gitrep/nimbus-client
git add test/fixtures/query-items-rows.json test/query-items-conformance.test.ts
git commit -m "test: pin index.queryItems to golden gateway rows

validateQueryItems hand-transcribes the wire shape with nothing linking it to
the gateway at compile time — the failure mode that produced the original bug.
This pins it to rows a real gateway produced, so an upstream column rename fails
in CI instead of yielding undefined fields in every downstream client.

Verified the gate fails when a fixture key is renamed."
```

- [ ] **Step 6: Open the PR, merge, and publish 0.6.0**

```bash
gh pr create --title "feat!: queryItems returns validated NimbusItem[] instead of raw rows"
npm view @nimbus-dev/client version   # expect 0.6.0
```

---

## Task 5: VS Code — delete the mirror

**Repo:** `nimbus-vscode` (`C:/gitrep/nimbus-vscode`). **Depends on:** Task 4 published.

**Files:**

- Modify: `package.json` (dependency bump)
- Modify: `src/sidebar/index.ts:4-30` and `:66-93`
- Modify: `test/unit/index.test.ts`

**Interfaces:**

- Consumes: `NimbusItem`, `KNOWN_ITEM_TYPES` from `@nimbus-dev/sdk` via `@nimbus-dev/client` (Tasks 1, 3).
- Produces: `IndexItem` keeps its name and shape so `index-view.ts` is unaffected.

- [ ] **Step 1: Bump the client**

```bash
cd C:/gitrep/nimbus-vscode && bun add @nimbus-dev/client@^0.6.0 && bun run typecheck
```

Expected: typecheck FAILS in `src/extension.ts:454` / `src/sidebar/index.ts` because `queryItems` now returns `NimbusItem[]`. **That failure is the contract working** — it is the compile error that should have existed all along.

- [ ] **Step 2: Write the failing test**

Add to `test/unit/index.test.ts`:

```ts
test("parseIndexRow keeps an ops item type", () => {
  const item = parseIndexRow({
    id: "github:1",
    service: "github",
    itemType: "deployment",
    name: "deploy prod",
    modifiedAt: 1_700_000_000_000,
  });
  expect(item?.itemType).toBe("deployment");
  expect(item?.updatedMs).toBe(1_700_000_000_000);
});

test("parseIndexRow keeps an item type this extension build does not know", () => {
  const item = parseIndexRow({
    id: "x:1", service: "x", itemType: "dora_metric", name: "n",
  });
  expect(item?.itemType).toBe("dora_metric");
});
```

- [ ] **Step 3: Run it to verify it fails**

```bash
cd C:/gitrep/nimbus-vscode && bun run test -- index.test.ts
```

Expected: FAIL — `itemType` is `undefined`, because `ITEM_TYPES` does not contain `deployment`.

- [ ] **Step 4: Delete the private mirror**

In `src/sidebar/index.ts`, delete the local `IndexItemType` union (line 5) and the `ITEM_TYPES` set (lines 23-30), and re-source the type:

```ts
import type { NimbusItem } from "@nimbus-dev/client";

// Sourced from the SDK contract — do NOT re-declare it here. A private mirror
// of this vocabulary is what made this view render no types for its entire life.
export type IndexItemType = NimbusItem["itemType"];
```

In `parseIndexRow`, accept any non-empty string as the type — the enum is open and the client has already validated the row:

```ts
  const itemType = asNonEmptyString(rec["itemType"]);
  if (itemType !== undefined) item.itemType = itemType;
```

- [ ] **Step 5: Make the icon map total**

`ITEM_TYPE_ICONS` is keyed on the old closed union and will no longer typecheck. Replace it with a lookup that has a fallback, so an unknown type renders a generic icon instead of failing:

```ts
const ITEM_TYPE_ICONS: Readonly<Record<string, string>> = {
  file: "file",
  email: "mail",
  event: "calendar",
  photo: "device-camera",
  pr: "git-pull-request",
  issue: "issues",
  pipeline_run: "play-circle",
  deployment: "rocket",
  alert: "warning",
  incident: "flame",
  infra_resource: "server",
  data_model: "database",
  data_pipeline: "type-hierarchy",
  dashboard: "dashboard",
  log_alarm: "bell",
  ml_model: "beaker",
  data_quality_test: "checklist",
  api_endpoint: "plug",
  obsidian_note: "note",
};

export function iconForItemType(t: string | undefined): string {
  return (t !== undefined ? ITEM_TYPE_ICONS[t] : undefined) ?? "symbol-misc";
}
```

Update the call site in `index-view.ts` to use `iconForItemType`. Verify each codicon name against <https://microsoft.github.io/vscode-codicons/dist/codicon.html> and substitute a real one for any that does not exist.

- [ ] **Step 6: Run the full gate**

```bash
cd C:/gitrep/nimbus-vscode && bun run typecheck && bun run lint && bun run test \
  && bun run build && bun run check-bundle && bun run check-vsix-contents && bun run check-settings-docs
```

Expected: all PASS.

- [ ] **Step 7: Verify in a real editor (Layer 2)**

Per `.claude/skills/verify-extension/SKILL.md`, this is a runtime/UI change and unit tests stub `vscode`. Package, install into an isolated profile, and confirm the Index view now shows types and orders by recency:

```bash
cd C:/gitrep/nimbus-vscode
SP="$TEMP/claude/nimbus-stage0"
bunx vsce package --no-dependencies --out "$SP/nimbus.vsix"
code --extensions-dir "$SP/ext" --user-data-dir "$SP/udata" --install-extension "$SP/nimbus.vsix"
code --extensions-dir "$SP/ext" --user-data-dir "$SP/udata" .
```

With a gateway running, open the Nimbus sidebar → Index. Expected: items show type icons, and each service group is newest-first. Record what you observed; do not claim this step passed without running it.

- [ ] **Step 8: Commit and open the PR**

```bash
cd C:/gitrep/nimbus-vscode
git checkout -b fix/index-item-type-contract
git add package.json bun.lock src/sidebar/index.ts src/sidebar/index-view.ts test/unit/index.test.ts
git commit -m "fix: Index view shows item types and sorts by time

The view kept a private copy of the SDK's itemType union and read camelCase
keys, while the gateway sends snake_case. Both were wrong, so itemType and
updatedMs were undefined on every row: the Index view has never displayed a
type or ordered by recency. It looked correct only because id, name, service
and url are single words that collide across both casings.

@nimbus-dev/client 0.6.0 returns validated NimbusItem[], so the mirror is
deleted and the type is sourced from the contract. The icon map covers all 19
emitted types and falls back for unknown ones."
gh pr create --title "fix: Index view shows item types and sorts by time"
```

---

## Stage 0 exit criteria

- [ ] A field-name or vocabulary drift between gateway, SDK and client fails CI in at least one repo — **and has been observed failing** (Task 4, Step 4).
- [ ] `index.queryItems` is validated like every other client method.
- [ ] No code path rewrites one item type into another. `grep -rn "itemTypeFromRowType" C:/gitrep/Nimbus/packages` is empty.
- [ ] Exactly one declaration of the item-type vocabulary exists across all four repos:

  ```bash
  grep -rn '"pipeline_run"' C:/gitrep/nimbus-sdk/src C:/gitrep/nimbus-client/src \
    C:/gitrep/nimbus-vscode/src C:/gitrep/Nimbus/packages/gateway/src --include=*.ts | grep -v test
  ```

  Expected: hits only in `nimbus-sdk/src/item-types.ts`.
- [ ] The VS Code Index view renders types and sorts by recency, confirmed in a real Extension Development Host.

## Follow-ups (not Stage 0)

- `docs/schema-reference.md`'s SQL comment and `nimbus-sdk/src/item-types.ts` are still two hand-maintained lists. Stage 0 makes them testable, not generated. Revisit generation once the gate has caught its first real drift — see [`ecosystem-roadmap.md`](../../ecosystem-roadmap.md) § Open decisions.
- `querySql` still returns `Record<string, unknown>[]`. That is correct — arbitrary SQL has no fixed shape — but the VS Code Sessions view's raw-SQL hack should move to `session.list` in Stage 1 wave 1d.
- Connector mappers still emit bare string literals. Typing them at the connector boundary is a Stage 1 cleanup; `upsertNimbusItemIntoItemTable` already accepts `NimbusItem`, so the chokepoint is typed after Task 1.
