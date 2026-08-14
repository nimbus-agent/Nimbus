# Incident Attribution — PR 2 (Sentry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Emit `person --assigned--> error_issue` from the Sentry assignment data already sitting in the index, and surface it in `nimbus negotiate` as a count kept separate from incident work.

**Architecture:** Populator-only. `sentry-issue-mapping.ts` already stores `assignedTo` raw in `item.metadata` (shipped in #1172 for exactly this), so there is **no connector change and no re-sync** — `nimbus index regraph` backfills every Sentry issue already indexed. The edge reuses `linkActorToEntity`, the helper PR 1 (#1177) left generic.

**Tech Stack:** Bun v1.2+, TypeScript strict, `bun:sqlite`, Biome. No new dependencies, no migration.

**Spec:** [`docs/superpowers/specs/2026-08-14-incident-attribution-design.md`](../specs/2026-08-14-incident-attribution-design.md) — §§ 2, 5.5, 5.7, 5.8 are the binding sections. Read them alongside this plan.

**Base:** `20b51f64` (PR 1 merged). Branch `dev/asafgolombek/incident-attribution-pr2-sentry`.

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **Run `bun run typecheck` before every commit and confirm it exits 0.** Bun does not typecheck at runtime — a wrong-arity call passes the whole suite and fails CI. This exact defect cost PR 1 a fix round: `syncTestContext(db, vault)` takes TWO arguments and already spreads `silentSyncContextExtras()` internally. **Green tests are not a green build.**
- **Run `bun run lint:fix` before every commit.** Biome `quoteStyle` is `"double"` (`biome.json:75`); `lint` runs with `--error-on-warnings`, so a warning fails CI like an error. Single quotes inside a template literal are SQL syntax — do not "fix" those.
- **No migration and no new relation type.** `assigned` is already registered in `graph_relation_type` (`index/graph-v7-sql.ts:37`). `graph_relation.type` is FK-constrained with `PRAGMA foreign_keys = ON`, so an unregistered type fails loudly at insert.
- **No connector change.** `packages/gateway/src/connectors/sentry-*` must not be touched. If you think it must be, stop and say why — that would contradict the spec's core claim that this is recoverable from stored rows.
- **`authorId` stays `null`** on `error_issue` items, as it already is.
- **A structural zero is never rendered as a measurement.** `null` means "could not be computed"; `0` means "measured, found nothing". This is the defect that made PR 1's whole-branch review return a Critical — see Task 2.
- **Never commit on `main`.** Stay on `dev/asafgolombek/incident-attribution-pr2-sentry`.
- **Before pushing:** `bun run preflight:fast`.

---

## File Structure

**Modified only — no new files:**

| File | Change |
| --- | --- |
| `packages/gateway/src/graph/graph-populator.ts` | Emit the `assigned` edge inside `syncErrorIssueGraph` |
| `packages/gateway/src/graph/graph-populator-error-issue.test.ts` | Its tests |
| `packages/gateway/src/agents/_lib/negotiate-types.ts` | `errorIssuesAssigned` on `NegotiateIncidents` |
| `packages/gateway/src/agents/negotiate.ts` | The count query + the Sentry gap note |
| `packages/gateway/src/agents/_lib/gap-notes.ts` | An `error_issue` remediation entry |
| `packages/gateway/src/agents/negotiate.test.ts` | Lane + gap-note + render tests |
| `packages/gateway/src/agents/_lib/render.ts` | A separate rendered line |
| `docs/CHANGELOG.md`, `docs/architecture.md` | Dated entry + graph-edge docs |

---

### Task 1: Emit `person --assigned--> error_issue`

Sentry's `assignedTo` is stored raw by `sentry-issue-mapping.ts:87` — a nullable actor object, not an email string. This task reads it, accepts only a user actor with a usable email, and links it.

**Files:**

- Modify: `packages/gateway/src/graph/graph-populator.ts` (`syncErrorIssueGraph`)
- Test: `packages/gateway/src/graph/graph-populator-error-issue.test.ts`

**Interfaces:**

- Consumes: `linkActorToEntity(db, row, toEntityId, rawEmail, relationType, now)` and `usableActorEmail` — both already in the file from PR 1. `asRecord` from `../connectors/unknown-record.ts`.
- Produces: `person --assigned--> error_issue` edges, person side keyed on `graph_entity.external_id = person.id`.

**Three facts that make this smaller than it looks — do not re-engineer them:**

1. **`assigned` is NOT in `CROSS_ITEM_RELATION_TYPES`** (`graph-populator.ts:89-94`, which holds only `resolves`, `mentions`, `correlates_with`, `reviewed`). `syncErrorIssueGraph` already calls `clearRelationsTouchingEntity`, so the generic clear retires the edge and a **reassignment self-heals with no extra code**. Do NOT add an explicit clear — unlike `resolves` in PR 1, this one does not need it.
2. **Emit AFTER the existing `clearRelationsTouchingEntity(db, entityId)` call**, or the clear wipes what you just wrote. The function's own doc comment says this.
3. **`error_issue` is replayed by `regraph`** via the catch-all slice at `regraph.ts:233-234` (it is deliberately absent from `REGRAPH_TYPE_ORDER`, which is an ordering hint, not a filter). That is what makes this backfill without a re-sync.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/gateway/src/graph/graph-populator-error-issue.test.ts
// Reuse whatever `freshDb()` / entity-query helpers the file already defines.
// If it has no edge helper, add this one:
function assignedEdges(db: Database): Array<{ from_ext: string; to_ext: string }> {
  return db
    .query(
      `SELECT pe.external_id AS from_ext, ie.external_id AS to_ext
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'error_issue'
        WHERE r.type = 'assigned'
        ORDER BY pe.external_id`,
    )
    .all() as Array<{ from_ext: string; to_ext: string }>;
}

function indexErrorIssue(db: Database, id: string, assignedTo: unknown): void {
  upsertIndexedItem(db, {
    service: "sentry",
    type: "error_issue",
    externalId: id,
    title: `TypeError in ${id}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    metadata: { org: "acme", project: "checkout", assignedTo },
  });
}

test("a user-assigned sentry issue gets a person --assigned--> error_issue edge", () => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-1", {
    type: "user",
    id: "42",
    name: "Jane Doe",
    email: "jane@example.com",
  });

  const edges = assignedEdges(db);
  expect(edges).toHaveLength(1);
  expect(edges[0]?.to_ext).toBe("sentry:SENTRY-1");
  // The person side MUST be the person.id — negotiate matches `pe.external_id = ?`
  // against a person id, so any other encoding silently breaks the reader.
  const person = db
    .query("SELECT id FROM person WHERE canonical_email = 'jane@example.com'")
    .get() as { id: string };
  expect(edges[0]?.from_ext).toBe(person.id);
});

// A team actor is not a person. Sentry allows assigning to a team, and a team
// has no canonical email — minting a person row for one would pollute every
// people-based brief.
test("a team-assigned issue produces no edge and no person row", () => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-2", { type: "team", id: "7", name: "platform" });
  expect(assignedEdges(db)).toHaveLength(0);
  const n = db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number };
  expect(n.n).toBe(0);
});

// §4.4: the presence of `email` on a user actor is UNVERIFIED against a real
// Sentry response. Fail closed, and prove it fails closed.
test.each([
  ["null assignedTo", null],
  ["a user actor with no email", { type: "user", id: "42", name: "Jane" }],
  ["a user actor with a junk email", { type: "user", id: "42", email: "unknown" }],
  ["a bare string", "jane@example.com"],
  ["a number", 42],
])("emits nothing for %s", (_label, assignedTo) => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-3", assignedTo);
  expect(assignedEdges(db)).toHaveLength(0);
  const n = db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number };
  expect(n.n).toBe(0);
});

// `assigned` is not a CROSS_ITEM type, so the existing clear retires it.
test("re-assigning an issue retires the previous edge", () => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-4", { type: "user", id: "1", email: "jane@example.com" });
  expect(assignedEdges(db)).toHaveLength(1);

  indexErrorIssue(db, "SENTRY-4", { type: "user", id: "2", email: "bob@example.com" });
  const edges = assignedEdges(db);
  expect(edges).toHaveLength(1);
  const bob = db.query("SELECT id FROM person WHERE canonical_email = 'bob@example.com'").get() as {
    id: string;
  };
  expect(edges[0]?.from_ext).toBe(bob.id);
});

// The whole reason this PR needs no re-sync: attribution rebuilds from rows
// already in the index, with no network.
test("regraph rebuilds attribution from stored rows alone", () => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-5", { type: "user", id: "1", email: "jane@example.com" });
  expect(assignedEdges(db)).toHaveLength(1);

  db.run("DELETE FROM graph_relation");
  db.run("DELETE FROM graph_entity");
  expect(assignedEdges(db)).toHaveLength(0);

  regraphAllItems(db);
  expect(assignedEdges(db)).toHaveLength(1);
});
```

Import `regraphAllItems` from `./regraph.ts` and `upsertIndexedItem` from `../index/item-store.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/graph/graph-populator-error-issue.test.ts`
Expected: FAIL — `expected [] to have length 1`

- [ ] **Step 3: Write minimal implementation**

Add this helper above `syncErrorIssueGraph`:

```ts
/**
 * Sentry stores `assignedTo` as a nullable ACTOR OBJECT, not an email string
 * (`connectors/sentry-issue-mapping.ts:87` keeps it raw for exactly this).
 * Only a USER actor maps to a person: Sentry also allows assigning to a team,
 * which has no canonical email, and handing one to `resolvePersonForSync` would
 * mint a junk person row that outlives the sync.
 *
 * Returns the raw email for `linkActorToEntity` to validate — `usableActorEmail`
 * is the single gate and lives there, so this must not re-implement it.
 *
 * The presence of `email` on a user actor is UNVERIFIED against a real Sentry
 * response (spec § 4.4); a shape mismatch therefore yields no edge, never a
 * wrong one.
 */
function sentryAssigneeEmail(metadata: Record<string, unknown>): unknown {
  const actor = asRecord(metadata["assignedTo"]);
  if (actor === undefined) return undefined;
  return stringField(actor, "type") === "user" ? actor["email"] : undefined;
}
```

Then, inside `syncErrorIssueGraph`, immediately after the existing
`clearRelationsTouchingEntity(db, entityId);` line:

```ts
  // AFTER the clear, or it wipes what we just wrote. `assigned` is NOT in
  // CROSS_ITEM_RELATION_TYPES, so that generic clear is what retires this edge
  // on re-assignment — no explicit clear needed here, unlike `resolves`.
  linkActorToEntity(db, row, entityId, sentryAssigneeEmail(row.metadata), "assigned", now);
```

**Imports — verified against the file, do not assume:**

- `stringField` is a **local function** in `graph-populator.ts:56`, NOT an import. It is already in
  scope; do not import another one. (Note its semantics differ slightly from the `unknown-record`
  version: this one also rejects whitespace-only strings, which is fine here.)
- `asRecord` is **not present in this file at all**. Add
  `import { asRecord } from "../connectors/unknown-record.ts";` to the import block. A `graph/` →
  `connectors/` import is already established: PR 1 added
  `import { usableActorEmail } from "../connectors/actor-email.ts"` to this same file and it passes
  every boundary audit. Do NOT hand-roll a `typeof x === "object" && x !== null` guard instead —
  `asRecord` also rejects arrays, which an inline guard would let through.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/graph/`
Expected: PASS across the whole graph directory.

- [ ] **Step 5: Red-prove the retirement**

Temporarily add `"assigned"` to `CROSS_ITEM_RELATION_TYPES` and re-run. The
`re-assigning an issue retires the previous edge` test MUST fail with 2 edges instead of 1.
Restore the constant. If it stays green, the test is not proving retirement — fix the test first.

Report the observed failure text in your report; a claim of "red-proved" without it will be rejected.

- [ ] **Step 6: Commit**

```bash
bun run typecheck && bun run lint:fix
git add packages/gateway/src/graph/
git commit -m "emit person assigned edges for sentry error issues"
```

---

### Task 2: Count it in `negotiate`, and disclose its absence

Two halves, and the second is why PR 1's whole-branch review returned a Critical: a lane that reports `0` with no gap note asserts "this person did nothing" from an index that may contain no Sentry data at all.

**Files:**

- Modify: `packages/gateway/src/agents/_lib/negotiate-types.ts`, `packages/gateway/src/agents/negotiate.ts`, `packages/gateway/src/agents/_lib/gap-notes.ts`
- Test: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Consumes: the edges from Task 1; `detectMissingConnector`, `detectMissingRelationToEntityType`, `remediationForEntityType` from `./_lib/gap-notes.ts`
- Produces: `NegotiateIncidents.errorIssuesAssigned: number`

**Do NOT reuse `countEdge`.** The existing helper inside `laneIncidents` hardcodes `ie.type = 'incident'`. Error issues need their own query with `ie.type = 'error_issue'`; passing `"assigned"` to `countEdge` would silently count incidents.

**Do NOT fold error issues into `unattributable`.** That field counts in-window *incidents* with no person edge. Error issues are a different population, and spec § 5.7 requires them counted and rendered separately — that separation is the entire reason Spec A chose `error_issue` over `incident`, so an error group that never paged anyone cannot inflate incident counts.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/gateway/src/agents/negotiate.test.ts
// `seedMe(db)` and `ctxFor(db)` already exist in this file from PR 1.
function seedErrorIssue(db: Database, id: string, email: string | null): void {
  upsertIndexedItem(db, {
    service: "sentry",
    type: "error_issue",
    externalId: id,
    title: `TypeError in ${id}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    metadata: {
      org: "acme",
      project: "checkout",
      assignedTo: email === null ? null : { type: "user", id: "1", email },
    },
  });
}

test("counts error issues assigned to the subject", async () => {
  const db = freshDb();
  seedMe(db);
  seedErrorIssue(db, "S-1", "jane@example.com");
  seedErrorIssue(db, "S-2", "jane@example.com");
  seedErrorIssue(db, "S-3", null);

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  expect(brief.incidents?.errorIssuesAssigned).toBe(2);
  db.close();
});

// Error issues must NOT leak into the incident counts. Spec § 5.7.
test("error issues do not inflate the incident counts", async () => {
  const db = freshDb();
  seedMe(db);
  seedErrorIssue(db, "S-1", "jane@example.com");

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  expect(brief.incidents?.errorIssuesAssigned).toBe(1);
  expect(brief.incidents?.assigned).toBe(0);
  expect(brief.incidents?.resolved).toBe(0);
  expect(brief.incidents?.unattributable).toBe(0);
  db.close();
});

test("no sentry connector yields a missing_connector gap naming sentry", async () => {
  const db = freshDb();
  seedMe(db);
  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  const details = brief.gaps.map((g) => g.detail).join(" ");
  expect(brief.gaps.map((g) => g.category)).toContain("missing_connector");
  expect(details).toContain("sentry");
  db.close();
});

test("sentry present but no assignment edges yields a missing_relation_emit gap", async () => {
  const db = freshDb();
  seedMe(db);
  db.run("INSERT INTO sync_state (connector_id) VALUES (?)", ["sentry"]);
  seedErrorIssue(db, "S-1", null);

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  const relationGaps = brief.gaps.filter((g) => g.category === "missing_relation_emit");
  expect(relationGaps.length).toBeGreaterThan(0);
  // The remediation must be actionable, not the shared default — the default says
  // the edges are "not yet emitted by the graph populator", which is false here.
  expect(relationGaps.some((g) => (g.remediation ?? "").includes("sentry"))).toBe(true);
  db.close();
});

test("a healthy sentry index emits neither sentry gap", async () => {
  const db = freshDb();
  seedMe(db);
  db.run("INSERT INTO sync_state (connector_id) VALUES (?)", ["sentry"]);
  seedErrorIssue(db, "S-1", "jane@example.com");

  const brief = await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db));
  const sentryGaps = brief.gaps.filter((g) => (g.detail + (g.remediation ?? "")).includes("sentry"));
  expect(sentryGaps).toHaveLength(0);
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts -t "error issue"`
Expected: FAIL — `errorIssuesAssigned` is `undefined`

- [ ] **Step 3: Write minimal implementation**

Add the remediation entry in `_lib/gap-notes.ts`, beside the existing `incident` one:

```ts
  error_issue:
    "Run `nimbus connector sync sentry`. Sentry issues indexed before attribution shipped " +
    "already carry the data — `nimbus index regraph` rebuilds the edges with no re-sync.",
```

Add the field to `NegotiateIncidents` in `_lib/negotiate-types.ts`:

```ts
  /**
   * Sentry error issues assigned to the subject. Counted and rendered SEPARATELY
   * from incident work, never summed into it: an error group that never paged
   * anyone is not an incident, which is exactly why Spec A gave it its own
   * entity type. Folding the two would discard that decision at the last step.
   */
  readonly errorIssuesAssigned: number;
```

In `negotiate.ts`, inside `laneIncidents`, add beside the existing counts:

```ts
  // Deliberately NOT `countEdge("assigned")` — that helper hardcodes
  // `ie.type = 'incident'` and would silently count the wrong population.
  const errorIssuesAssigned = (
    db
      .query(
        `SELECT COUNT(DISTINCT ie.id) AS n
           FROM graph_relation r
           JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
           JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'error_issue'
           JOIN item i          ON i.id = ie.external_id
          WHERE r.type = 'assigned' AND pe.external_id = ? AND i.modified_at >= ?`,
      )
      .get(personId, cutoff) as { n: number }
  ).n;
```

and return it in the object literal.

Then in `runNegotiate`, beside the existing PagerDuty gap block and gated the same way
(only when `subject.personId !== null`):

```ts
    const missingSentryConnector = detectMissingConnector(ctx.db, "sentry");
    if (missingSentryConnector !== null) {
      gaps.push(missingSentryConnector);
    } else {
      const missingErrorIssueEdges = detectMissingRelationToEntityType(
        ctx.db,
        "assigned",
        "error_issue",
        remediationForEntityType("error_issue"),
      );
      if (missingErrorIssueEdges !== null) gaps.push(missingErrorIssueEdges);
    }
```

The `if/else` is deliberate and mirrors the PagerDuty block: no connector structurally implies
no edges, so firing both would emit two notes for one root cause.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/agents/`
Expected: PASS. Any existing test constructing a `NegotiateIncidents` literal now needs the new
required field — `typecheck` will name them; update rather than making the field optional.

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run lint:fix
git add packages/gateway/src/agents/
git commit -m "count sentry error-issue assignments in the negotiate lane"
```

---

### Task 3: Render it as its own line

**Files:**

- Modify: `packages/gateway/src/agents/_lib/render.ts` (`renderNegotiateIncidents`)
- Test: `packages/gateway/src/agents/negotiate.test.ts`

**Interfaces:**

- Consumes: `NegotiateIncidents.errorIssuesAssigned` (Task 2)
- Produces: no new exports

Negotiate rendering is tested in `negotiate.test.ts`, driven from a real `runNegotiate` result — not in `_lib/render.test.ts`, which builds literal fixtures for other agents. Follow the local convention.

- [ ] **Step 1: Write the failing tests**

```ts
// append to packages/gateway/src/agents/negotiate.test.ts
test("renders error-issue assignments on their own line", async () => {
  const db = freshDb();
  seedMe(db);
  db.run("INSERT INTO sync_state (connector_id) VALUES (?)", ["sentry"]);
  seedErrorIssue(db, "S-1", "jane@example.com");
  seedErrorIssue(db, "S-2", "jane@example.com");

  const markdown = renderNegotiate(
    await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db)),
  );
  expect(markdown).toContain("## Incidents");
  expect(markdown).toContain("2 Sentry error issue(s) assigned");
  // Must NOT be folded into the incident line.
  expect(markdown).toContain("0 resolved, 0 assigned");
  db.close();
});

// Zero prints nothing: "0 Sentry error issues assigned" in a brief for someone
// with no Sentry connector reads as a measured zero, which it is not.
test("omits the error-issue line when it is zero", async () => {
  const db = freshDb();
  seedMe(db);
  const markdown = renderNegotiate(
    await runNegotiate({ mePersonIdOverride: "person:me" }, ctxFor(db)),
  );
  expect(markdown).not.toContain("Sentry error issue");
  db.close();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/agents/negotiate.test.ts -t "error-issue"`
Expected: FAIL — the string is absent

- [ ] **Step 3: Write minimal implementation**

In `renderNegotiateIncidents`, after the `resolved, assigned` line and before the
`unattributable` block:

```ts
  // Its own line, never summed into the incident counts (spec § 5.7). Suppressed
  // at zero: with no Sentry connector this lane is structurally empty, and a
  // printed "0 assigned" would read as a measurement of the person rather than
  // of the index. The gap note carries that case instead.
  if (i.errorIssuesAssigned > 0) {
    lines.push(`- ${String(i.errorIssuesAssigned)} Sentry error issue(s) assigned`);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/agents/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
bun run typecheck && bun run lint:fix
git add packages/gateway/src/agents/_lib/render.ts packages/gateway/src/agents/negotiate.test.ts
git commit -m "render sentry error-issue assignments as their own line"
```

---

### Task 4: Documentation and the full gate

**Files:**

- Modify: `docs/CHANGELOG.md`, `docs/architecture.md`

- [ ] **Step 1: CHANGELOG entry**

Add a dated entry under the current unreleased heading covering: the `person --assigned--> error_issue` edge; that it needs **no re-sync and no new Sentry scope** because `assignedTo` was already indexed, and that `nimbus index regraph` backfills existing issues; that a **team** assignment attributes to nobody by design; and that error-issue counts are reported separately from incident counts.

**Do not claim a measured recovery time.** State the structural behaviour and say what you did and did not execute — the PR 1 entry directly above is the model.

Carry forward the open caveat: whether a Sentry user actor carries `email` is still unverified against a real API response (spec § 4.4), so a shape mismatch yields no edge rather than a wrong one.

- [ ] **Step 2: architecture.md**

Add `assigned` (person → `error_issue`) beside the person → `incident` edges PR 1 documented.

- [ ] **Step 3: Run the full gate**

```bash
bun run preflight:fast
bun test packages/gateway/src/graph/ packages/gateway/src/agents/
```

Expected: green. If `audit:coverage-floor` appears, note it is full-tier and CI-Linux-authoritative — six pre-existing violations in platform-gated files (`platform/linux.ts`, `mcp-connectors/apple/*`, `ipc/server/socket-listeners.ts`) fail on a Windows host and are **not** this PR's. Do not run `--update-baseline` to silence anything.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "document sentry error-issue attribution"
```

---

## Self-Review

**Spec coverage.** § 2 (scope: `assigned` only, no Sentry "resolved by") → Task 1, and the plan adds no resolver path. § 5.5 (populator reads stored `assignedTo`, user actors only, fail closed) → Task 1. § 5.6 (Sentry recoverable via `regraph`, no re-sync) → Task 1 Step 1's regraph test + Task 4's CHANGELOG. § 5.7 (counted and rendered separately, `errorIssuesAssigned` added now that something emits it) → Tasks 2, 3. § 5.8 (four distinct zeros, never a structural zero as a measurement) → Task 2's gap block + Task 3's zero suppression. § 8.3 (populator-level regraph test) → Task 1 Step 1.

**Deliberately not covered.** § 8.2's real-payload fixture is an accepted open risk carried from PR 1 — no PagerDuty or Sentry credentials exist. Task 1's fail-closed table is the mitigation, not a substitute.

**Type consistency.** `errorIssuesAssigned` (Tasks 2, 3), `sentryAssigneeEmail` (Task 1), `linkActorToEntity` (Task 1), `remediationForEntityType("error_issue")` (Task 2) — spelled identically at every use.

**Interface change to flag:** adding a required field to `NegotiateIncidents` breaks any existing test constructing that literal. Task 2 Step 4 says to let `typecheck` name them and fix them, not to make the field optional — an optional field would let a caller silently omit it.

**Lesson carried from PR 1:** the gap-note wiring in Task 2 is the single most omittable piece here. PR 1's plan claimed § 5.8 coverage across three tasks and shipped none of it, and thirteen clean per-task reviews missed it because the requirement lived between tasks. It is therefore written into Task 2 with its own tests rather than left implicit.

**Helper names were verified against the tree, not recalled.** A first draft of this plan asserted that `stringField` was imported into `graph-populator.ts` and that `asRecord` sat alongside it. Neither is true: `stringField` is a local function at `:56`, and `asRecord` is absent from the file entirely. Task 1 now says so explicitly. This is the same class of defect that reached PR 1's plan (six phantom test-helper names, plus a `syncTestContext` arity that was wrong in eleven places) — every repo fact written from memory rather than executed has needed correcting, so re-verify before editing this plan.

**Existing test files confirmed present with the helpers this plan uses:** `graph-populator-error-issue.test.ts` (has `freshDb()`, imports `upsertIndexedItem`), `negotiate.test.ts` (has `freshDb()`, `ctxFor()`, `seedMe()`, `seedIncident()`), `regraphAllItems` exported at `regraph.ts:217`, `detectMissingConnector(db, service)` at `gap-notes.ts:29`.
