# Agents for Items and Files — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the gateway's agents answer about an indexed item that is not a pull request -- an issue or an incident, **not** a Confluence page (spec F8) -- and about a source file identified by a forge coordinate rather than a local path.

**Architecture:** Three additive PRs. PR 1 adds an `itemUrl` input arm to `why`, `expert` and `ownership`, resolved through the shipped `resolveItemByUrl`. PR 2 adds `resolveFileByRemote` — a graph walk from a forge coordinate to the reader's local checkout — plus a forge-file arm on five agents, and fixes `impact` resolving a file path to an arbitrary symbol. PR 3 adds two read-only agents, `connections` and `currency`.

**Tech Stack:** TypeScript (strict), Bun, `bun:sqlite`, Vitest-style `bun test`.

**Spec:** [`docs/superpowers/specs/2026-08-31-agents-for-items-and-files-design.md`](../specs/2026-08-31-agents-for-items-and-files-design.md) — read it alongside this plan; the plan argues from it.

## Global Constraints

- **No breaking wire change.** Every type change here is additive. `WhyChangeSubject` is published at `stability: stable` in the SDK and must not be reshaped (spec F2).
- **`ownership`'s brief types are gateway-local** (`agents/_lib/ownership-types.ts`); only `GapNote` comes from `@nimbus-dev/sdk`. Changing them needs no SDK release.
- **`why`'s brief types are SDK-owned.** `WhyItemSubject` and `WhyBrief.itemSubject` must land in `@nimbus-dev/sdk` and be released before PR 1's gateway half can typecheck. See the SDK plan; PR 1 is blocked on that release.
- **HTTP exposure is derived, not declared.** `HTTP_AGENT_NAMES` (`ipc/agents-rpc.ts:983`) is every `AGENTS_RPC_HANDLERS` key minus `HTTP_EXCLUDED_AGENT_METHODS`, so a new handler is HTTP-reachable by default. `preflight`, `premortem` and `negotiate` must stay excluded.
- **Bounds are measured after trim, on the normalised value** — never on the caller's raw string.
- **Gaps, never empty answers.** A lane that cannot apply is silent; a lane that applies and finds nothing emits a `GapNote`. The `arm` discriminator decides which, never `subject === null`.
- **Run before every commit:** `bun run typecheck && bun run lint && bun test packages/gateway/src/agents/` and `bun run lint:markdown` after any docs change.

---

## File Structure

**PR 1**

- Modify `packages/gateway/src/agents/_lib/why-types.ts` — `WhyItemInput`, `isWhyItemInput`, re-export `WhyItemSubject`.
- Modify `packages/gateway/src/agents/why.ts` — `resolveItemArm`, `arm: "item"`, item-arm sub-lane queries.
- Modify `packages/gateway/src/agents/expert.ts` — the person-edge walk (new query code).
- Modify `packages/gateway/src/agents/ownership.ts` + `_lib/ownership-types.ts` — item→service mapping, `query.itemUrl`.
- Modify `packages/gateway/src/ipc/agents-rpc.ts` — three param guards.

**PR 2**

- Create `packages/gateway/src/index/resolve-file-by-remote.ts` — the forge→checkout resolver.
- Modify `packages/gateway/src/agents/impact.ts` — `source_file` before the symbol `LIKE`.
- Modify the five agents + `agents-rpc.ts` — the forge-file arm.

**PR 3**

- Create `packages/gateway/src/agents/connections.ts`, `packages/gateway/src/agents/currency.ts`.
- Modify `packages/gateway/src/ipc/agents-rpc.ts` — two handlers.
- Modify `packages/gateway/src/agent-runs/agent-http-e2e.test.ts` — roster count 11 → 13.

---

## PR 1 — The `itemUrl` arm

**Blocked on:** the SDK releasing `WhyItemSubject` + `WhyBrief.itemSubject`.

### Task 1: `WhyItemInput` and its type guard

**Files:**

- Modify: `packages/gateway/src/agents/_lib/why-types.ts`
- Test: `packages/gateway/src/agents/why.test.ts`

**Interfaces:**

- Consumes: `WhyInput`, `isWhyPrInput` (existing in this file).
- Produces: `type WhyItemInput = { itemUrl: string }`; `isWhyItemInput(i: WhyInput): i is WhyItemInput`. Used by Task 2 and Task 5.

- [ ] **Step 1: Write the failing test**

```ts
import { isWhyItemInput, isWhyPrInput } from "./_lib/why-types.ts";

test("isWhyItemInput separates the three arms", () => {
  expect(isWhyItemInput({ itemUrl: "https://acme.atlassian.net/browse/PLAT-9" })).toBe(true);
  expect(isWhyItemInput({ prUrl: "https://github.com/acme/web/pull/1" })).toBe(false);
  expect(isWhyItemInput({ ref: "src/a.ts" })).toBe(false);
  // The existing guard must not start claiming the new arm.
  expect(isWhyPrInput({ itemUrl: "https://acme.atlassian.net/browse/PLAT-9" })).toBe(false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/agents/why.test.ts -t "three arms"`
Expected: FAIL — `isWhyItemInput` is not exported.

- [ ] **Step 3: Add the type and guard**

In `_lib/why-types.ts`, alongside the existing `WhyPrInput` / `isWhyPrInput`:

```ts
/** The third arm: an indexed item that is not a pull request. */
export type WhyItemInput = { itemUrl: string };

export type WhyInput = WhyRefInput | WhyPrInput | WhyItemInput;

export function isWhyItemInput(i: WhyInput): i is WhyItemInput {
  return "itemUrl" in i;
}
```

Re-export the SDK's new subject so `why.ts` imports subjects from one place, matching how `WhyChangeSubject` is already re-exported through `_lib/findings.ts`:

```ts
export type { WhyItemSubject } from "@nimbus-dev/sdk";
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/gateway/src/agents/why.test.ts -t "three arms"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/why-types.ts packages/gateway/src/agents/why.test.ts
git commit -m "feat(why): a third input arm type for an indexed item"
```

---

### Task 2: `resolveItemArm`, and `arm: "item"`

**Files:**

- Modify: `packages/gateway/src/agents/why.ts:56` (the `arm` union), `:90-110` (beside `resolvePrArm`), `:182-198` (`runWhy`'s dispatch), `:226-232` (brief assembly)
- Test: `packages/gateway/src/agents/why.test.ts`

**Interfaces:**

- Consumes: `isWhyItemInput` (Task 1); `resolveItemByUrl` from `../../index/resolve-by-url.ts`.
- Produces: `WhyLaneResolution.itemSubject?: WhyItemSubject | null`; `LaneInput.arm` widened to `"ref" | "change" | "item"`. Tasks 3 and 4 branch on that arm.

- [ ] **Step 1: Write the failing test**

```ts
test("the item arm answers with itemSubject and leaves the other two null", async () => {
  const db = seedIndexedIssue(); // helper below
  const brief = await runWhy(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, roots: [], notify: () => {}, sessionId: "s1" },
  );

  expect(brief.itemSubject?.title).toBe("Checkout times out");
  expect(brief.itemSubject?.service).toBe("jira");
  expect(brief.subject).toBeNull();
  expect(brief.changeSubject).toBeUndefined();
  expect(brief.query.ref).toBe("https://acme.atlassian.net/browse/PLAT-9");
});

test("an itemUrl that resolves to nothing gaps rather than throwing", async () => {
  const db = emptyIndexedDb();
  const brief = await runWhy(
    { itemUrl: "https://acme.atlassian.net/browse/NOPE-1" },
    { db, roots: [], notify: () => {}, sessionId: "s2" },
  );
  expect(brief.itemSubject).toBeNull();
  expect(brief.gaps.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/agents/why.test.ts -t "item arm"`
Expected: FAIL — `runWhy` throws or returns no `itemSubject`.

- [ ] **Step 3: Widen the arm and add the resolver**

In `why.ts`, widen the `LaneInput.arm` union at line 56 and extend its comment to name the third member:

```ts
  arm: "ref" | "change" | "item";
```

Add beside `resolvePrArm`:

**Read `ResolveCandidate` before writing this.** It is
`{ id, service, type, title, url: string | null }` plus `modified_at: number`
(`index/resolve-by-url.ts:13`). It has **no `entityId` and no `number`**, `url` is nullable, and
`modified_at` is *not* — so a `?? null` on it is dead code. The lanes answer from graph edges, so the
entity is what this arm actually needs, and it must be looked up rather than read off the item.

```ts
/** The `itemUrl` arm: resolve the indexed item the lanes answer about. */
function resolveItemArm(db: Database, itemUrl: string): WhyLaneResolution {
  const miss: WhyLaneResolution = {
    subject: null,
    blame: null,
    pr: null,
    itemEntityId: null,
    // null, not absent: the caller asked about an item and we could not name it.
    itemSubject: null,
    queryRef: itemUrl,
    queryLine: null,
  };

  const resolved = resolveItemByUrl(db, itemUrl);
  if (!resolved.found) return miss;
  const item = resolved.item;

  // Every lane on this arm walks `graph_relation`, which hangs off a
  // `graph_entity`. An indexed item does not always have one:
  // `syncGraphFromIndexedItem` skips any type outside ITEM_LINKED_ENTITY_TYPES
  // and GRAPH_SYNC_BY_TYPE, which is why a Confluence page (`type: "page"`) has
  // none at all. No entity means there is genuinely nothing to answer from.
  //
  // Constrained by type as well as external_id: `deterministicGraphEntityId`
  // hashes (type, externalId), so one external id can legitimately exist under
  // more than one type.
  const entity = db
    .query("SELECT id FROM graph_entity WHERE external_id = ? AND type = ? LIMIT 1")
    .get(item.id, item.type) as { id?: string } | null;
  if (entity?.id === undefined) return miss;

  const numberRow = db
    .query("SELECT json_extract(metadata, '$.number') AS number FROM item WHERE id = ? LIMIT 1")
    .get(item.id) as { number: number | null } | null;

  return {
    subject: null,
    blame: null,
    // The item arm has no PR of its own. `subPullRequest` may find one and the
    // lanes that need it read it from their own result, not from here.
    pr: null,
    itemEntityId: entity.id,
    itemSubject: {
      itemId: item.id,
      entityId: entity.id,
      number: numberRow?.number ?? null,
      // `ResolveCandidate.url` is nullable and `WhyItemSubject.url` matches it.
      // Do NOT fall back to `itemUrl`: that substitutes the URL we were asked
      // with for the one the item has -- a fabricated field inside a subject.
      url: item.url,
      title: item.title,
      // `modified_at` is `number`, not nullable. No `??` here.
      modifiedAt: item.modified_at,
      service: item.service,
      type: item.type,
    },
    queryRef: itemUrl,
    queryLine: null,
  };
}
```

**The no-entity case returns the miss deliberately.** Falling back to `entityId: item.id` would put
an item id where a `graph_entity.id` belongs -- a field that looks resolved, reads as valid, and
matches nothing in the graph. A miss produces the same honest gap as an unresolvable URL, which is
the accurate answer: this item cannot be answered about from edges, because it has none.

In `runWhy`, replace the two-way dispatch at line 182 with a three-way one:

```ts
  const resolution = isWhyPrInput(input)
    ? resolvePrArm(ctx.db, input.prUrl)
    : isWhyItemInput(input)
      ? resolveItemArm(ctx.db, input.itemUrl)
      : await resolveRefArm(input, ctx);
  const { subject, blame, pr, changeSubject, itemSubject, queryRef, queryLine } = resolution;
```

Set the arm and `occurredAt` explicitly — do **not** fold the item arm into the existing ternaries, for the reason the `occurredAt` comment already gives about borrowing another arm's timestamp:

```ts
    occurredAt: armOf(input) === "item"
      ? (itemSubject?.modifiedAt ?? null)
      : isWhyPrInput(input)
        ? (pr?.modifiedAt ?? null)
        : (blame?.authorTimeMs ?? null),
    arm: armOf(input),
```

with:

```ts
function armOf(input: WhyInput): "ref" | "change" | "item" {
  if (isWhyPrInput(input)) return "change";
  return isWhyItemInput(input) ? "item" : "ref";
}
```

In the brief assembly, thread the new subject the same way `changeSubject` is threaded:

```ts
    ...(changeSubject === undefined ? {} : { changeSubject }),
    ...(itemSubject === undefined ? {} : { itemSubject }),
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/gateway/src/agents/why.test.ts -t "item arm"`
Expected: PASS, and every pre-existing `why` test still passes.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/why.ts packages/gateway/src/agents/why.test.ts
git commit -m "feat(why): resolve an indexed item as a third lane arm"
```

---

### Task 3: The two file/line lanes stay silent on `item`

**Files:**

- Modify: `packages/gateway/src/agents/why.ts:356` (`subAuthorship`), `:702` (`subDownstream`)
- Test: `packages/gateway/src/agents/why.test.ts`

**Interfaces:**

- Consumes: `LaneInput.arm` (Task 2).
- Produces: nothing new. This task only narrows behaviour.

**Why this is its own task:** these two lanes must be *silent*, not gapped. The comment on `LaneInput.arm` explains it for the `change` arm — they "stay silent rather than reporting a gap for the file subject a `prUrl` question never had" — and an item has no file subject either. A reviewer could reasonably accept Task 2 and reject this, which is what makes it a separate gate.

- [ ] **Step 1: Write the failing test**

```ts
test("the file/line lanes are silent on an item, not gapped", async () => {
  const db = seedIndexedIssue();
  const brief = await runWhy(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, roots: [], notify: () => {}, sessionId: "s3" },
  );
  // No gap should mention a file, a line, or blame: the question never had one.
  const text = brief.gaps.map((g) => g.detail).join(" ");
  expect(text).not.toMatch(/file|line|blame/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/agents/why.test.ts -t "silent on an item"`
Expected: FAIL — both lanes fall through to their file-subject gap.

- [ ] **Step 3: Extend both early returns**

At `why.ts:356` and `:702`, change the guard so the item arm takes the same exit:

```ts
  // `change` and `item` alike: neither question has a file subject, so a gap
  // here would report something missing that was never asked for.
  if (lane.arm !== "ref") return {};
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/gateway/src/agents/why.test.ts`
Expected: PASS, all `why` tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/why.ts packages/gateway/src/agents/why.test.ts
git commit -m "feat(why): the file lanes stay silent on the item arm"
```

---

### Task 4: The four lanes that *do* apply to an item

**Files:**

- Modify: `packages/gateway/src/agents/why.ts:457` (`subPullRequest`), `:533` (`subTicket`), `:564` (`subDiscussion`), `:629` (`subDriver`)
- Test: `packages/gateway/src/agents/why.test.ts`

**Interfaces:**

- Consumes: `LaneInput.arm`, `LaneInput.itemEntityId` (added here).
- Produces: nothing consumed downstream.

**Why this is the task the spec exists for:** `ticketRowsForPr` (`why.ts:320`) joins `pe.type = 'pr' AND r.from_id = ?` — handed an issue entity it returns zero rows, so without this task the item arm ships a well-formed empty brief for every issue in the index.

- [ ] **Step 1: Write the failing test**

```ts
test("subPullRequest finds the PR that resolves this issue", async () => {
  // PR --resolves--> issue. The PR arm walks this edge from `from_id`;
  // the item arm must walk it from `to_id`.
  const db = seedIssueResolvedByPr({ prNumber: 482, issueKey: "PLAT-9" });
  const brief = await runWhy(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, roots: [], notify: () => {}, sessionId: "s4" },
  );
  const titles = brief.findings.map((f) => f.title).join(" ");
  expect(titles).toContain("482");
});

test("an item with no neighbours gaps rather than returning nothing at all", async () => {
  const db = seedIndexedIssue(); // no edges
  const brief = await runWhy(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, roots: [], notify: () => {}, sessionId: "s5" },
  );
  expect(brief.findings).toEqual([]);
  expect(brief.gaps.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/agents/why.test.ts -t "subPullRequest finds"`
Expected: FAIL — no findings; the PR-shaped query returns zero rows.

- [ ] **Step 3: Add the item-arm queries**

Carry the item's entity id on the lane input (add to `LaneInput`, set in `resolveItemArm`):

```ts
  /** The indexed item the lanes answer about, on the `item` arm only. */
  itemEntityId: string | null;
```

Add the inverse traversal beside `ticketRowsForPr`:

```ts
/** PRs pointing AT this item — the inverse of `ticketRowsForPr`'s traversal. */
function prRowsResolvingItem(db: Database, itemEntityId: string): PrRow[] {
  return db
    .query(
      `SELECT pe.id AS entity_id, i.title AS title, i.url AS url,
              i.modified_at AS modified_at, i.external_id AS key
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'pr'
         JOIN item i ON i.id = pe.external_id
        WHERE r.to_id = ? AND r.type = 'resolves'
        LIMIT 10`,
    )
    .all(itemEntityId) as PrRow[];
}

/** Neighbouring issues — never the item itself. */
function siblingIssueRows(db: Database, itemEntityId: string): TicketRow[] {
  return db
    .query(
      `SELECT ie.id AS entity_id, i.external_id AS key, i.title AS title, i.url AS url,
              i.modified_at AS modified_at
         FROM graph_relation r
         JOIN graph_entity ie ON ie.id = CASE WHEN r.from_id = ?1 THEN r.to_id ELSE r.from_id END
         JOIN item i ON i.id = ie.external_id
        WHERE (r.from_id = ?1 OR r.to_id = ?1)
          AND r.type IN ('depends_on', 'mentions')
          AND ie.type = 'issue'
          AND ie.id <> ?1
        LIMIT 10`,
    )
    .all(itemEntityId) as TicketRow[];
}
```

In each of the four sub-agents, branch on the arm at the top and use the item query when `lane.arm === "item"`, keeping the existing PR path otherwise. `subDriver` runs only if `subPullRequest` found a PR; on the item arm it reads that PR from `prRowsResolvingItem`'s first row rather than from `lane.pr`, which is null there. `subDiscussion` needs no new query — its `message` traversal is already entity-keyed; pass `lane.itemEntityId` where it currently passes the PR entity id.

Each lane keeps its existing `detectMissingRelationToEntityType` gap call, so an item with no neighbours gaps rather than returning silently.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/gateway/src/agents/why.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/why.ts packages/gateway/src/agents/why.test.ts
git commit -m "feat(why): answer the four item-applicable lanes from the item entity"
```

---

### Task 5: `why`'s param guard becomes a count of three

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts:463-487` (`requireWhyParams`)
- Test: `packages/gateway/src/ipc/agents-rpc.test.ts`

**Interfaces:**

- Consumes: `WhyItemInput` (Task 1).
- Produces: `requireWhyParams` accepting exactly one of `ref` / `prUrl` / `itemUrl`.

- [ ] **Step 1: Write the failing test**

```ts
test("why requires exactly one of three arms", () => {
  const one = { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" };
  expect(() => requireWhyParams(one)).not.toThrow();

  expect(() => requireWhyParams({})).toThrow(/exactly one/);
  expect(() => requireWhyParams({ ref: "a.ts", itemUrl: "https://x/1" })).toThrow(/exactly one/);
  expect(() => requireWhyParams({ prUrl: "https://x/1", itemUrl: "https://x/2" })).toThrow(/exactly one/);
  expect(() =>
    requireWhyParams({ ref: "a.ts", prUrl: "https://x/1", itemUrl: "https://x/2" }),
  ).toThrow(/exactly one/);
});

test("itemUrl inherits the prUrl arm's guards", () => {
  expect(() => requireWhyParams({ itemUrl: "https://u:p@acme.atlassian.net/browse/PLAT-9" }))
    .toThrow(/userinfo/);
  expect(() => requireWhyParams({ itemUrl: "  " })).toThrow(/chars after trim/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/ipc/agents-rpc.test.ts -t "one of three arms"`
Expected: FAIL — `itemUrl` is rejected as "requires exactly one of { ref } or { prUrl }".

- [ ] **Step 3: Replace the two-value equality with a count**

`hasRef === hasPrUrl` does not generalise to three. Count the supplied arms:

```ts
function requireWhyParams(params: unknown): WhyInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(
      -32602,
      "agents.why requires exactly one of { ref }, { prUrl } or { itemUrl }",
    );
  }
  const p = params as { ref?: unknown; prUrl?: unknown; itemUrl?: unknown };
  const supplied = [p.ref, p.prUrl, p.itemUrl].filter((v) => v !== undefined).length;
  if (supplied !== 1) {
    throw new AgentsRpcError(
      -32602,
      "agents.why requires exactly one of { ref }, { prUrl } or { itemUrl }",
    );
  }
  if (p.itemUrl !== undefined) {
    return { itemUrl: requireUrlParam(p.itemUrl, "itemUrl") };
  }
  if (p.prUrl !== undefined) {
    return { prUrl: requireUrlParam(p.prUrl, "prUrl") };
  }
  return requireWhyRefParams(params);
}
```

Extract the `prUrl` arm's existing body — string check, trim, `MAX_PR_URL_LEN` bound, `prUrlHasCredentials` — into `requireUrlParam(value: unknown, name: string): string` so both URL arms share one validator rather than growing a second copy that can drift.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/gateway/src/ipc/agents-rpc.test.ts`
Expected: PASS, including the pre-existing two-arm tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.test.ts
git commit -m "feat(agents-rpc): why accepts exactly one of three arms"
```

---

### Task 6: `expert`'s person-edge walk

**Files:**

- Modify: `packages/gateway/src/agents/expert.ts`, `packages/gateway/src/ipc/agents-rpc.ts` (`requireExpertParams`)
- Test: `packages/gateway/src/agents/expert.test.ts`

**Interfaces:**

- Consumes: `resolveItemByUrl`.
- Produces: `ExpertInput` widened to `{ topicOrFile: string } | { itemUrl: string }`.
- **SDK dependency:** `ExpertBrief.query` is `{ topicOrFile: string }` and is SDK-owned
  (`brief-composites.ts:61`). It gains an optional `itemUrl?: string | null` in the same SDK
  release as `WhyItemSubject`. This task cannot typecheck before that release.

**Why this is bigger than it looks:** `runExpert` today takes `input.topicOrFile: string` and its five sub-agents run `LIKE '%' || ? || '%'` scans over titles and previews (`expert.ts:175`). There is **no entity-based path to reuse** — this task writes one.

- [ ] **Step 1: Write the failing test**

```ts
test("the item arm answers from graph edges, not from a title match", async () => {
  // Two items with near-identical titles; only one is edge-linked to the person.
  const db = seedItemAuthoredBy({ itemKey: "PLAT-9", person: "Dana" });
  seedUnrelatedItemWithSimilarTitle(db, { person: "Rae" });

  const brief = await runExpert(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, notify: () => {}, sessionId: "s6" },
  );
  // `ExpertBrief` is `ranked: ExpertFinding[]`, NOT `findings` -- and an
  // ExpertFinding has `displayName`/`personId`, never `title`.
  const names = brief.ranked.map((f) => f.displayName).join(" ");
  expect(names).toContain("Dana");
  expect(names).not.toContain("Rae"); // a LIKE scan would have matched this
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/agents/expert.test.ts -t "not from a title match"`
Expected: FAIL — `runExpert` rejects the input shape, or matches both people.

- [ ] **Step 3: Add the arm and the walk**

```ts
export type ExpertInput = { topicOrFile: string; limit?: number } | { itemUrl: string; limit?: number };

/** People edge-linked to this item, with the edge that links them. */
function peopleForItem(db: Database, itemEntityId: string): PersonRow[] {
  return db
    .query(
      `SELECT pe.id AS entity_id, pe.label AS name, r.type AS edge
         FROM graph_relation r
         JOIN graph_entity pe
           ON pe.id = CASE WHEN r.from_id = ?1 THEN r.to_id ELSE r.from_id END
          AND pe.type = 'person'
        WHERE (r.from_id = ?1 OR r.to_id = ?1)
          AND r.type IN ('authored', 'reviewed', 'opened', 'posted')
        LIMIT 20`,
    )
    .all(itemEntityId) as PersonRow[];
}
```

On the item arm, `runExpert` resolves the URL, runs `peopleForItem`, and emits one finding per person naming the edge that linked them ("Dana — authored"). The five `LIKE` sub-agents do not run on this arm: they answer a different question and running both would mix an edge-backed answer with a lexical guess in one list. A resolve miss, or an item with no person edges, emits the existing `missing_entity_type` gap.

In `requireExpertParams`, accept exactly one of `topicOrFile` / `itemUrl`, reusing `requireUrlParam` from Task 5.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/gateway/src/agents/expert.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/expert.ts packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/agents/expert.test.ts
git commit -m "feat(expert): answer about an indexed item from its person edges"
```

---

### Task 7: `ownership`'s item arm, mapped to its service

**Files:**

- Modify: `packages/gateway/src/agents/_lib/ownership-types.ts:27`, `packages/gateway/src/agents/ownership.ts`, `packages/gateway/src/ipc/agents-rpc.ts:699`
- Test: `packages/gateway/src/agents/ownership.test.ts`

**Interfaces:**

- Consumes: `resolveItemByUrl`.
- Produces: `OwnershipBrief.query` widened to `{ path: string | null; service: string | null; itemUrl: string | null }`.

**Constraint:** `OwnershipTargetView.kind` stays `"source_file" | "directory" | "service"`. The item is mapped to its owning service via `belongs_to`, so no new target kind is introduced.

- [ ] **Step 1: Write the failing test**

```ts
test("an item resolves to its owning service, and the brief records what was asked", async () => {
  const db = seedItemInService({ itemKey: "PLAT-9", service: "checkout" });
  const brief = await runOwnership(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, notify: () => {}, sessionId: "s7" },
  );
  expect(brief.target?.kind).toBe("service");
  expect(brief.service?.id).toBe("checkout");
  expect(brief.query.itemUrl).toBe("https://acme.atlassian.net/browse/PLAT-9");
  expect(brief.query.path).toBeNull();
  expect(brief.query.service).toBeNull();
});

test("ownership still rejects two scopes at once, now across three", () => {
  expect(() => requireOwnershipParams({ path: "a.ts", itemUrl: "https://x/1" }))
    .toThrow(/mutually exclusive/);
  expect(() => requireOwnershipParams({ service: "checkout", itemUrl: "https://x/1" }))
    .toThrow(/mutually exclusive/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/agents/ownership.test.ts -t "owning service"`
Expected: FAIL — `itemUrl` is not accepted and `query` has no such field.

- [ ] **Step 3: Widen the query and add the mapping**

In `_lib/ownership-types.ts`:

```ts
  readonly query: {
    readonly path: string | null;
    readonly service: string | null;
    /** The item the caller asked about, when they asked by item. */
    readonly itemUrl: string | null;
  };
```

Every existing construction site of `query` must add `itemUrl: null` — the compiler lists them.

In `ownership.ts`, the item arm resolves the URL, walks `belongs_to` from the item entity to a `service` entity, and then runs the **existing** service lane with that id, so item-scoped and service-scoped answers cannot diverge. An item that belongs to no service emits a `missing_entity_type` gap naming the item, not the service.

In `requireOwnershipParams`, extend the existing pairwise rejection to a count over the three, keeping the message's "pass one, or neither for a coverage summary" wording.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/gateway/src/agents/ownership.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/_lib/ownership-types.ts packages/gateway/src/agents/ownership.ts packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/agents/ownership.test.ts
git commit -m "feat(ownership): answer about an item through its owning service"
```

---

### Task 8: The per-entity-type matrix, and PR 1's docs

**Files:**

- Test: `packages/gateway/src/agents/why.test.ts`, `expert.test.ts`
- Modify: `docs/roadmap.md` (the Client surfaces row), `docs/CHANGELOG.md`

- [ ] **Step 1: Write the matrix test**

```ts
describe.each(["issue", "incident"])("the item arm on a %s", (itemType) => {
  test("produces findings or gaps, never a well-formed empty brief", async () => {
    const db = seedIndexedItemOfType(itemType);
    const brief = await runWhy(
      { itemUrl: urlForSeededItem(itemType) },
      { db, roots: [], notify: () => {}, sessionId: `m-${itemType}` },
    );
    expect(brief.findings.length + brief.gaps.length).toBeGreaterThan(0);
  });
});
```

Then pin the surface that is deliberately **not** covered, so the exclusion is a decision on record
rather than an omission someone later "fixes":

```ts
test("a Confluence page has no graph entity, so it resolves to a miss", async () => {
  // `type: "page"` is in neither ITEM_LINKED_ENTITY_TYPES nor GRAPH_SYNC_BY_TYPE,
  // so syncGraphFromIndexedItem writes nothing for it. Spec F8.
  const db = seedIndexedConfluencePage();
  const brief = await runWhy(
    { itemUrl: "https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Runbook" },
    { db, roots: [], notify: () => {}, sessionId: "m-page" },
  );
  expect(brief.itemSubject).toBeNull();
  expect(brief.findings).toEqual([]);
  expect(brief.gaps.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/src/agents/why.test.ts -t "item arm on a"`
Expected: PASS (Tasks 2–4 made it so; this test is the regression fence).

- [ ] **Step 3: Record the change**

Add a `docs/CHANGELOG.md` entry naming the three agents and the new arm. Update the roadmap's Client surfaces row to say the browser can now ask about an item.

- [ ] **Step 4: Run the gates**

Run: `bun run typecheck && bun run lint && bun run lint:markdown && bun test packages/gateway/src/agents/`
Expected: all pass.

- [ ] **Step 5: Commit and open PR 1**

```bash
git add -A
git commit -m "docs: record the item arm across why, expert and ownership"
```

---

## PR 2 — `resolveFileByRemote` and the forge-file arm

**Blocked on:** nothing. Can be built in parallel with PR 1.

### Task 9: The `impact` `source_file` fix, on its own

**Files:**

- Modify: `packages/gateway/src/agents/impact.ts:131-165` (`resolveStartEntity`)
- Test: `packages/gateway/src/agents/impact.test.ts`

**Interfaces:**

- Produces: `resolveStartEntity` preferring an exact `source_file` label match.

**Ship this first and alone.** It is a correctness fix to a shipped agent on the terminal surface (`nimbus impact src/foo.ts`) and it must be reviewable without the browser feature attached to it.

- [ ] **Step 1: Write the failing test**

```ts
test("a file path resolves to the file, not to a symbol defined inside it", () => {
  const db = seedDb();
  // symbol labels are `${name} — ${file}`, so a path substring-matches them
  upsertEntity(db, { type: "symbol", label: "x — src/foo.ts" });
  upsertEntity(db, { type: "symbol", label: "parseEverything — src/foo.ts" });
  const fileId = upsertEntity(db, { type: "source_file", label: "src/foo.ts" });

  const start = resolveStartEntity(db, "src/foo.ts");
  expect(start?.entityId).toBe(fileId);
  expect(start?.entityType).toBe("source_file");
});

test("a genuine symbol name still resolves to the symbol", () => {
  const db = seedDb();
  const symId = upsertEntity(db, { type: "symbol", label: "parseTags — src/clip.ts" });
  expect(resolveStartEntity(db, "parseTags")?.entityId).toBe(symId);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/agents/impact.test.ts -t "not to a symbol defined inside it"`
Expected: FAIL — returns the `x — src/foo.ts` symbol, because `ORDER BY length(label) ASC` picks the shortest.

- [ ] **Step 3: Put the file lookup first**

In `resolveStartEntity`, after the PR attempt and **before** the symbol queries:

```ts
  // `symbol` labels are `${name} — ${file}`, so no symbol label is ever a bare
  // path — the exact-symbol arm below cannot match file input, and the LIKE
  // arm answers with an arbitrary symbol from inside the file. Look for the
  // file itself first.
  const file = db
    .query("SELECT id FROM graph_entity WHERE type = 'source_file' AND label = ? LIMIT 1")
    .get(fileOrPrUrl) as { id?: string } | null;
  if (file?.id !== undefined) {
    return { entityId: file.id, entityType: "source_file", repoIds: [] };
  }
```

Widen `ResolvedStart["entityType"]` to include `"source_file"` and handle it wherever `entityType` is switched on.

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test packages/gateway/src/agents/impact.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/impact.ts packages/gateway/src/agents/impact.test.ts
git commit -m "fix(impact): a file path resolves to the file, not a symbol inside it"
```

---

### Task 10: `resolveFileByRemote`

**Files:**

- Create: `packages/gateway/src/index/resolve-file-by-remote.ts`
- Test: `packages/gateway/src/index/resolve-file-by-remote.test.ts`

**Interfaces:**

- Consumes: `fileExternalId` — **import it** from `../ownership/ownership-pass.ts` (export it if it is not already exported); do not re-format the string here.
- Produces:

```ts
export type ResolveFileResult =
  | { ok: true; fileEntityId: string; repoRoot: string; path: string }
  | { ok: false; reason: "remote_not_tracked" | "file_not_indexed"; repo: string };

export function resolveFileByRemote(
  db: Database,
  input: { service: string; repo: string; refAndPath: string },
): ResolveFileResult;
```

- [ ] **Step 1: Write the failing tests**

```ts
test("walks remote -> workspace -> source_file", () => {
  const db = seedTrackedRepo({ remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
  const r = resolveFileByRemote(db, { service: "github", repo: "acme/web", refAndPath: "main/src/foo.ts" });
  expect(r).toMatchObject({ ok: true, repoRoot: "/home/d/web", path: "src/foo.ts" });
});

test("a branch name with slashes still finds the file", () => {
  const db = seedTrackedRepo({ remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
  const r = resolveFileByRemote(db, {
    service: "github", repo: "acme/web", refAndPath: "feat/auth-v2/src/foo.ts",
  });
  expect(r).toMatchObject({ ok: true, path: "src/foo.ts" });
});

test("remote casing does not decide the answer", () => {
  const db = seedTrackedRepo({ remote: "github:ACME/Web", root: "/home/d/web", files: ["src/foo.ts"] });
  const r = resolveFileByRemote(db, { service: "github", repo: "acme/web", refAndPath: "main/src/foo.ts" });
  expect(r.ok).toBe(true);
});

test("the two misses are distinguishable", () => {
  const empty = seedDb();
  expect(resolveFileByRemote(empty, { service: "github", repo: "acme/web", refAndPath: "main/a.ts" }))
    .toMatchObject({ ok: false, reason: "remote_not_tracked" });

  const tracked = seedTrackedRepo({ remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
  expect(resolveFileByRemote(tracked, { service: "github", repo: "acme/web", refAndPath: "main/nope.ts" }))
    .toMatchObject({ ok: false, reason: "file_not_indexed" });
});

test("two worktrees on one remote resolve to the one that has the file, stably", () => {
  const db = seedTwoWorktrees({
    remote: "github:acme/web",
    roots: [
      { root: "/home/d/web", files: [] },
      { root: "/home/d/web-hotfix", files: ["src/foo.ts"] },
    ],
  });
  const first = resolveFileByRemote(db, { service: "github", repo: "acme/web", refAndPath: "main/src/foo.ts" });
  const second = resolveFileByRemote(db, { service: "github", repo: "acme/web", refAndPath: "main/src/foo.ts" });
  expect(first).toMatchObject({ ok: true, repoRoot: "/home/d/web-hotfix" });
  expect(second).toEqual(first); // stable across calls, not arbitrary
});

test("a Windows root and a POSIX request meet", () => {
  const db = seedTrackedRepo({ remote: "github:acme/web", root: "C:\\gitrep\\web", files: ["src/foo.ts"] });
  const r = resolveFileByRemote(db, { service: "github", repo: "acme/web", refAndPath: "main/src/foo.ts" });
  expect(r.ok).toBe(true);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/gateway/src/index/resolve-file-by-remote.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Order of operations, each one earning its place from a test above:

1. Find candidate `repo` entities: `type = 'repo'` and `LOWER(external_id) = LOWER(?)`. Empty → `{ ok: false, reason: "remote_not_tracked", repo }`.
2. Walk `tracks_remote` **backwards** (`to_id` = repo entity) to every `workspace`. Read each workspace's `repoRoot` from its external id (`filesystem:<root>`).
3. For each candidate root, split `refAndPath` at each `/`, shortest ref first, and look up `fileExternalId(root, candidatePath)` — normalising `candidatePath` to the separator convention the indexer writes. **Read the indexer to determine that convention; do not assume.** Take the first hit.
4. If several roots hit, prefer the most recently indexed, then the lowest entity id. Both are needed: the first is the useful answer, the second makes it deterministic.
5. No hit anywhere → `{ ok: false, reason: "file_not_indexed", repo }`.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test packages/gateway/src/index/resolve-file-by-remote.test.ts`
Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/index/resolve-file-by-remote.ts packages/gateway/src/index/resolve-file-by-remote.test.ts
git commit -m "feat(index): resolve a forge file coordinate to the local checkout"
```

---

### Task 11: The forge-file arm on five agents

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts:248` (`requireFileParam`), and `impact.ts`, `expert.ts`, `ownership.ts`, `ghost.ts`, `conflicts.ts`
- Test: each agent's test file, plus `agents-rpc.test.ts`

**Interfaces:**

- Consumes: `resolveFileByRemote` (Task 10).
- Produces: a shared `{ service, repo, refAndPath }` param shape accepted by all five.

- [ ] **Step 1: Write the failing tests**

```ts
test("all five agents accept a forge file coordinate", async () => {
  const db = seedTrackedRepo({ remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
  const coord = { service: "github", repo: "acme/web", refAndPath: "main/src/foo.ts" };
  for (const run of [runImpact, runExpert, runOwnership, runGhost, runConflicts]) {
    const brief = await run(coord, { db, notify: () => {}, sessionId: "s" });
    expect(brief.gaps.some((g) => /not tracked/i.test(g.detail))).toBe(false);
  }
});

test("ghost and conflicts never fan out to peers from this arm", async () => {
  const sent: unknown[] = [];
  const db = seedTrackedRepo({ remote: "github:acme/web", root: "/home/d/web", files: ["src/foo.ts"] });
  await runGhost(
    { service: "github", repo: "acme/web", refAndPath: "main/src/foo.ts" },
    { db, notify: () => {}, sessionId: "s", sendOverWire: (m) => { sent.push(m); } },
  );
  expect(sent).toEqual([]);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/gateway/src/agents/ -t "forge file coordinate"`
Expected: FAIL — the param shape is rejected.

- [ ] **Step 3: Add the arm**

Extend `requireFileParam` to accept either the existing `{ file }` or the new `{ service, repo, refAndPath }`, applying the same `MIN_FILE_LEN`/`MAX_FILE_LEN` bounds to `refAndPath` after trim. On the new shape it calls `resolveFileByRemote` and hands each agent the resolved local path — so the five agent bodies are unchanged, which is what keeps this task small.

`parseNamespaces` is **not** called on the new shape: it stays `[]`, so `ghost` and `conflicts` answer local-only.

A miss returns the agent's gap carrying the typed `reason`, so a client branches on a value.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test packages/gateway/src/agents/ && bun test packages/gateway/src/ipc/agents-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A packages/gateway/src
git commit -m "feat(agents): a forge file coordinate as input to the five file agents"
```

---

## PR 3 — `connections` and `currency`

### Task 12: `connections`

**Files:**

- Create: `packages/gateway/src/agents/connections.ts`
- Modify: `packages/gateway/src/ipc/agents-rpc.ts` (handler + `newSessionId` union)
- Test: `packages/gateway/src/agents/connections.test.ts`

**Interfaces:**

- Produces: `emitConnectionsBrief(input, ctx)`, `briefReadyMethod: "connections.briefReady"`, brief `kind: "connections"`. Shape is fixed in spec §4.3 — copy it exactly; the SDK mirrors it.

- [ ] **Step 1: Write the failing tests**

```ts
test("a neighbour is present because an edge says so", async () => {
  const db = seedIssueResolvedByPr({ prNumber: 482, issueKey: "PLAT-9" });
  const brief = await runConnections(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, notify: () => {}, sessionId: "c1" },
  );
  expect(brief.neighbours).toHaveLength(1);
  expect(brief.neighbours[0]).toMatchObject({ edgeType: "resolves", direction: "inbound" });
});

test("similar titles with no edge are not neighbours", async () => {
  const db = seedTwoSimilarlyTitledUnlinkedItems();
  const brief = await runConnections(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, notify: () => {}, sessionId: "c2" },
  );
  expect(brief.neighbours).toEqual([]);
});

test("filesystem edges never appear", async () => {
  const db = seedItemWithDefinedInAndInRepoEdges();
  const brief = await runConnections(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, notify: () => {}, sessionId: "c3" },
  );
  expect(brief.neighbours.map((n) => n.edgeType)).not.toContain("defined_in");
  expect(brief.neighbours.map((n) => n.edgeType)).not.toContain("in_repo");
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/gateway/src/agents/connections.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement it**

Resolve `itemUrl` via `resolveItemByUrl`, then select from `graph_relation` in both directions where `type` is in the item-linked vocabulary (spec §4.3 — `defined_in`, `in_repo` and `tracks_remote` excluded), join the neighbour entity and its `item` row when one exists, and emit one `ConnectionNeighbour` per row. Second hop only through `resolves` → `merged_as`. Follow `impact.ts`'s file layout: `runConnections` builds the brief, `emitConnectionsBrief` wraps it in `emitBriefWithSynthesis` with `briefReadyMethod: "connections.briefReady"`.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test packages/gateway/src/agents/connections.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/connections.ts packages/gateway/src/agents/connections.test.ts packages/gateway/src/ipc/agents-rpc.ts
git commit -m "feat(agents): connections -- an item's typed graph neighbours"
```

---

### Task 13: `currency`

**Files:**

- Create: `packages/gateway/src/agents/currency.ts`
- Modify: `packages/gateway/src/ipc/agents-rpc.ts`
- Test: `packages/gateway/src/agents/currency.test.ts`

**Interfaces:**

- Produces: `emitCurrencyBrief`, `briefReadyMethod: "currency.briefReady"`, brief `kind: "currency"`. Shape fixed in spec §4.4: `verdict` is `"stale" | "current"` only, and `evidence` is a non-empty tuple.

- [ ] **Step 1: Write the failing tests**

```ts
test("a claim always carries its evidence", async () => {
  const db = seedIssueWhosePrMergedAfterIt();
  const brief = await runCurrency(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, notify: () => {}, sessionId: "u1" },
  );
  expect(brief.claims.length).toBeGreaterThan(0);
  for (const c of brief.claims) {
    expect(c.evidence.length).toBeGreaterThan(0);
    expect(c.signal).toBe("resolved_issue_pr_merged");
  }
});

test("no signal produces a gap, not a claim", async () => {
  const db = seedIndexedIssue(); // no edges, no state
  const brief = await runCurrency(
    { itemUrl: "https://acme.atlassian.net/browse/PLAT-9" },
    { db, notify: () => {}, sessionId: "u2" },
  );
  expect(brief.claims).toEqual([]);
  expect(brief.gaps.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/gateway/src/agents/currency.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the four signals**

Each signal is a separate function returning `CurrencyClaim | null`, and each builds its evidence array before it builds its claim — so a signal that cannot cite anything returns null rather than a claim with an empty array. Recency (`inactivity_threshold`) is the weakest and is reported with `verdict: "current"` plus an observation, never as a staleness claim on its own.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test packages/gateway/src/agents/currency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/agents/currency.ts packages/gateway/src/agents/currency.test.ts packages/gateway/src/ipc/agents-rpc.ts
git commit -m "feat(agents): currency -- is this item still true, with its evidence"
```

---

### Task 14: The roster moves 11 → 13

**Files:**

- Modify: `packages/gateway/src/agent-runs/agent-http-e2e.test.ts:197-213`
- Modify: `docs/CHANGELOG.md`, `docs/roadmap.md`

- [ ] **Step 1: Update the roster assertion and prove the exclusions held**

```ts
      const { agents } = (await res.json()) as { agents: string[] };
      expect(agents).not.toContain("preflight");
      expect(agents).not.toContain("premortem");
      expect(agents).not.toContain("whyPeek");
      expect(agents).not.toContain("negotiate");
      expect(agents).toContain("expert");
      // connections and currency are pure reads with no HITL consequence, so
      // they are HTTP-reachable by the derivation in HTTP_AGENT_NAMES.
      expect(agents).toContain("connections");
      expect(agents).toContain("currency");
      expect(agents).toHaveLength(13);
```

Leave the three exclusion tests at `:152`, `:166` and `:181` **untouched** — they must keep passing verbatim.

- [ ] **Step 2: Run the whole e2e file**

Run: `bun test packages/gateway/src/agent-runs/agent-http-e2e.test.ts`
Expected: PASS, including the three untouched exclusion tests.

- [ ] **Step 3: Record it**

Changelog entry naming both agents and the roster count.

- [ ] **Step 4: Run the gates**

Run: `bun run typecheck && bun run lint && bun run lint:markdown && bun test packages/gateway/src/`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(agents): publish connections and currency over HTTP"
```
