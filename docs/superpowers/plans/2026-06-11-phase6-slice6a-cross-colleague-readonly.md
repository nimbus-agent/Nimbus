# Phase 6 Slice 6a — Cross-colleague Intelligence (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three on-demand, read-only built-in agents — `nimbus ghost <file>`,
`nimbus conflicts <file>`, `nimbus huddle` — that surface cross-colleague context by fanning the
already-shipped federated-query primitives across paired peers.

**Architecture:** Pure asker-side orchestration over the shipped I17 federated-query path. A new
`peer-fanout.ts` generalizes the `team.auditMerged` fan-out (bounded-parallel, best-effort) over
`federation.query` / `federation.expertise`. Three agent modules mirror `impact`/`expert`/`catchup`
(typed `run<Agent>` + `emit<Agent>Brief` → `<kind>.briefReady`). One append-only table (V38) caches
known remote namespaces so the agents can default to an ambient sweep. No new structural invariant,
no new over-the-wire method.

**Tech Stack:** Bun 1.2+, TypeScript 6 strict (no `any`), `bun:sqlite`, Biome, the existing
`agents/_lib` brief/synthesize/render machinery, `ipc/lan-client.ts` `sendFederatedOverWire`.

**Spec:** `docs/superpowers/specs/2026-06-11-phase6-slice6a-cross-colleague-readonly-design.md`

**Conventions for every task:**

- Run scoped tests as `timeout 60 bun test <path>` (bun test can hang on Windows). On Windows use
  the Bash tool's `timeout`, or `bun test <path> --timeout 60000`.
- No `any`; use `unknown` + narrowing for external data. No `mock.module` — dependency injection only.
- Per-file typecheck after touching gateway code: `cd packages/gateway && bunx tsc --noEmit`
  (`bun test` transpiles but does NOT full-typecheck).
- Commit after each task with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
  trailer.

---

## File Structure

**New (gateway):**

- `packages/gateway/src/index/known-namespaces-v38-sql.ts` — V38 table DDL.
- `packages/gateway/src/index/known-namespace-store.ts` — `KnownNamespaceStore` (record/prune/list).
- `packages/gateway/src/federation/peer-fanout.ts` — `fanOutQuery` / `fanOutExpertise`.
- `packages/gateway/src/agents/_lib/match-token.ts` — file → machine-portable match token + local
  existence check.
- `packages/gateway/src/agents/ghost.ts` — ghost reviewers agent.
- `packages/gateway/src/agents/conflicts.ts` — cross-user conflict detection agent.
- `packages/gateway/src/agents/huddle.ts` — team huddle briefing agent.
- Matching `.test.ts` beside each.

**New (cli):**

- `packages/cli/src/commands/ghost.ts`, `conflicts.ts`, `huddle.ts` + `.test.ts`.

**Modified (gateway):**

- `agents/_lib/findings.ts` — add `FederatedItemLite`, `GhostBrief`, `ConflictBrief`,
  `HuddleBrief` + type guards; extend `AgentBrief`.
- `agents/_lib/emit-brief.ts` — extend `AnyBrief`.
- `agents/_lib/synthesize.ts` — extend `SynthInput`, `toolNameFor`, `deterministicRender`.
- `agents/_lib/render.ts` — add `renderGhost`, `renderConflict`, `renderHuddle`.
- `ipc/agents-rpc.ts` — `agents.ghost/conflicts/huddle` handlers; `AgentsRpcContext` gains
  `index?` / `selfIdentity?` / `sendOverWire?`.
- `ipc/server/dispatchers.ts` — thread `index` / `selfIdentity` into the agents context.
- `ipc/federation-rpc.ts` — record-on-answered hook in the `federation.ask` success path.
- `index/local-index.ts` — `CURRENT_SCHEMA_VERSION` → 38; `removeLanPeer` cascade-prunes the cache.
- `index/migrations/runner.ts` — register the V38 step.

**Modified (cli):**

- `packages/cli/src/types/agents.ts` — CLI-side brief types + guards.
- `packages/cli/src/index.ts` — register in `COMMAND_HANDLERS`.
- `packages/cli/src/registry.ts` — register in `COMMAND_NAMES`.

**Modified (ui / docs):**

- `packages/ui/src-tauri/src/gateway_bridge.rs` — 3 read-only methods in `ALLOWED_METHODS`.
- `packages/gateway/src/security-invariants.test.ts` — Tauri count JS-mirror bump.
- `docs/architecture.md`, `docs/cli-reference.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`,
  `.claude/commands/nimbus-agent-patterns.md`, `.claude/commands/nimbus-federation-identity.md`.

---

## Task 1: V38 migration — `federation_known_namespaces` table

**Files:**

- Create: `packages/gateway/src/index/known-namespaces-v38-sql.ts`
- Create: `packages/gateway/src/index/migrations/runner-v38.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import + `INDEXED_SCHEMA_STEPS`)
- Modify: `packages/gateway/src/index/local-index.ts:269` (`CURRENT_SCHEMA_VERSION = 37` → `38`)

- [ ] **Step 1: Write the migration SQL constant**

Create `packages/gateway/src/index/known-namespaces-v38-sql.ts`:

```ts
/**
 * V38 — asker-side cache of remote namespaces this gateway has successfully queried, so the
 * cross-colleague agents (ghost / conflicts / huddle) can default to an ambient fan-out without a
 * namespace-discovery primitive. Append-only; rows key on the stable peer_id.
 */
export const KNOWN_NAMESPACES_V38_SQL = `
CREATE TABLE IF NOT EXISTS federation_known_namespaces (
  peer_id       TEXT NOT NULL,
  namespace     TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  PRIMARY KEY (peer_id, namespace)
);
`;
```

- [ ] **Step 2: Write the failing runner test**

Create `packages/gateway/src/index/migrations/runner-v38.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "./runner.ts";

describe("V38 known-namespaces cache migration", () => {
  it("creates federation_known_namespaces at target version 38", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 38);
    const names = (
      db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain("federation_known_namespaces");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/index/migrations/runner-v38.test.ts`
Expected: FAIL — the migration step does not exist yet (table absent at version 38, or runner
rejects target 38 as out of range).

- [ ] **Step 4: Register the V38 step and bump the version**

In `packages/gateway/src/index/migrations/runner.ts`, add the import near the other v-sql imports
(by the `GDPR_V37_SQL` import at line ~35):

```ts
import { KNOWN_NAMESPACES_V38_SQL } from "../known-namespaces-v38-sql.ts";
```

Append to the end of the `INDEXED_SCHEMA_STEPS` array (after the existing V37 step):

```ts
  simpleStep(37, 38, "federation_known_namespaces asker-side cache", KNOWN_NAMESPACES_V38_SQL),
```

In `packages/gateway/src/index/local-index.ts:269`:

```ts
export const CURRENT_SCHEMA_VERSION = 38;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/index/migrations/runner-v38.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck + commit**

```bash
cd packages/gateway && bunx tsc --noEmit
cd ../.. && git add packages/gateway/src/index/known-namespaces-v38-sql.ts \
  packages/gateway/src/index/migrations/runner-v38.test.ts \
  packages/gateway/src/index/migrations/runner.ts \
  packages/gateway/src/index/local-index.ts
git commit -m "feat(db): V38 federation_known_namespaces asker-side cache table"
```

---

## Task 2: `KnownNamespaceStore` — record / prune / list

**Files:**

- Create: `packages/gateway/src/index/known-namespace-store.ts`
- Create: `packages/gateway/src/index/known-namespace-store.test.ts`
- Modify: `packages/gateway/src/index/local-index.ts` (`removeLanPeer` cascade-prune)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/index/known-namespace-store.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";
import { KnownNamespaceStore } from "./known-namespace-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("KnownNamespaceStore", () => {
  let db: Database;
  let store: KnownNamespaceStore;
  beforeEach(() => {
    db = freshDb();
    store = new KnownNamespaceStore(db);
  });

  it("records (peerId, namespace) and lists it", () => {
    store.record("peer:aa", "project:zurich", 1000);
    expect(store.list()).toEqual([{ peerId: "peer:aa", namespace: "project:zurich" }]);
  });

  it("record is idempotent on the primary key and updates last_used_at", () => {
    store.record("peer:aa", "project:zurich", 1000);
    store.record("peer:aa", "project:zurich", 2000);
    const rows = db
      .query("SELECT first_seen_at, last_used_at FROM federation_known_namespaces")
      .all() as Array<{ first_seen_at: number; last_used_at: number }>;
    expect(rows).toEqual([{ first_seen_at: 1000, last_used_at: 2000 }]);
  });

  it("prune removes a single (peerId, namespace)", () => {
    store.record("peer:aa", "ns1", 1);
    store.record("peer:aa", "ns2", 1);
    store.prune("peer:aa", "ns1");
    expect(store.list()).toEqual([{ peerId: "peer:aa", namespace: "ns2" }]);
  });

  it("pruneAllForPeer removes every row for a peer", () => {
    store.record("peer:aa", "ns1", 1);
    store.record("peer:bb", "ns2", 1);
    store.pruneAllForPeer("peer:aa");
    expect(store.list()).toEqual([{ peerId: "peer:bb", namespace: "ns2" }]);
  });

  it("listForPeer filters to one peer", () => {
    store.record("peer:aa", "ns1", 1);
    store.record("peer:bb", "ns2", 1);
    expect(store.listForPeer("peer:aa")).toEqual(["ns1"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/index/known-namespace-store.test.ts`
Expected: FAIL — `KnownNamespaceStore` not defined.

- [ ] **Step 3: Implement the store**

Create `packages/gateway/src/index/known-namespace-store.ts`:

```ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface KnownNamespaceRow {
  readonly peerId: string;
  readonly namespace: string;
}

/**
 * Asker-side cache of remote namespaces this gateway has successfully queried (V38). Used by the
 * cross-colleague agents to default to an ambient fan-out. Rows are recorded only on an ANSWERED
 * federated query and pruned on no_grant / unpair (self-healing).
 */
export class KnownNamespaceStore {
  constructor(private readonly db: Database) {}

  record(peerId: string, namespace: string, nowMs: number): void {
    dbRun(
      this.db,
      `INSERT INTO federation_known_namespaces (peer_id, namespace, first_seen_at, last_used_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(peer_id, namespace)
       DO UPDATE SET last_used_at = excluded.last_used_at`,
      [peerId, namespace, nowMs, nowMs],
    );
  }

  prune(peerId: string, namespace: string): void {
    dbRun(
      this.db,
      `DELETE FROM federation_known_namespaces WHERE peer_id = ? AND namespace = ?`,
      [peerId, namespace],
    );
  }

  pruneAllForPeer(peerId: string): void {
    dbRun(this.db, `DELETE FROM federation_known_namespaces WHERE peer_id = ?`, [peerId]);
  }

  list(): KnownNamespaceRow[] {
    return this.db
      .query(
        `SELECT peer_id AS peerId, namespace FROM federation_known_namespaces
         ORDER BY peer_id ASC, namespace ASC`,
      )
      .all() as KnownNamespaceRow[];
  }

  listForPeer(peerId: string): string[] {
    return (
      this.db
        .query(
          `SELECT namespace FROM federation_known_namespaces WHERE peer_id = ? ORDER BY namespace ASC`,
        )
        .all(peerId) as Array<{ namespace: string }>
    ).map((r) => r.namespace);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/index/known-namespace-store.test.ts`
Expected: PASS

- [ ] **Step 5: Wire unpair-prune into `removeLanPeer`**

In `packages/gateway/src/index/local-index.ts`, `removeLanPeer` currently (line ~874):

```ts
  public removeLanPeer(peerId: string): void {
    dbRun(this.db, `DELETE FROM lan_peers WHERE peer_id = ?`, [peerId]);
  }
```

Change to also drop the cache rows for that peer:

```ts
  public removeLanPeer(peerId: string): void {
    dbRun(this.db, `DELETE FROM lan_peers WHERE peer_id = ?`, [peerId]);
    dbRun(this.db, `DELETE FROM federation_known_namespaces WHERE peer_id = ?`, [peerId]);
  }
```

- [ ] **Step 6: Add the unpair-prune regression test**

Append to `packages/gateway/src/index/known-namespace-store.test.ts`:

```ts
import { LocalIndex } from "./local-index.ts";

describe("removeLanPeer cascade-prunes the namespace cache", () => {
  it("drops known-namespace rows when a peer is unpaired", () => {
    const db = freshDb();
    const idx = new LocalIndex(db);
    const store = new KnownNamespaceStore(db);
    store.record("peer:gone", "ns1", 1);
    idx.removeLanPeer("peer:gone");
    expect(store.listForPeer("peer:gone")).toEqual([]);
  });
});
```

- [ ] **Step 7: Run tests + typecheck + commit**

Run: `cd packages/gateway && timeout 60 bun test src/index/known-namespace-store.test.ts && bunx tsc --noEmit`
Expected: PASS

```bash
git add packages/gateway/src/index/known-namespace-store.ts \
  packages/gateway/src/index/known-namespace-store.test.ts \
  packages/gateway/src/index/local-index.ts
git commit -m "feat(index): KnownNamespaceStore + removeLanPeer cascade-prune"
```

---

## Task 3: Brief types, guards, and renderers

**Files:**

- Modify: `packages/gateway/src/agents/_lib/findings.ts`
- Modify: `packages/gateway/src/agents/_lib/emit-brief.ts`
- Modify: `packages/gateway/src/agents/_lib/synthesize.ts`
- Modify: `packages/gateway/src/agents/_lib/render.ts`
- Modify: `packages/gateway/src/agents/_lib/findings.test.ts`

- [ ] **Step 1: Write failing type-guard tests**

Append to `packages/gateway/src/agents/_lib/findings.test.ts`:

```ts
import {
  isConflictBrief,
  isGhostBrief,
  isHuddleBrief,
} from "./findings.ts";

describe("6a brief guards", () => {
  it("isGhostBrief accepts a well-formed ghost brief", () => {
    const b = {
      kind: "ghost",
      agentVersion: 1,
      generatedAt: 1,
      latencyMs: 1,
      gaps: [],
      query: { file: "auth.ts" },
      startEntityId: null,
      findings: [],
    };
    expect(isGhostBrief(b)).toBe(true);
    expect(isGhostBrief({ ...b, kind: "impact" })).toBe(false);
  });

  it("isConflictBrief checks the collisions array", () => {
    const b = {
      kind: "conflict",
      agentVersion: 1,
      generatedAt: 1,
      latencyMs: 1,
      gaps: [],
      query: { file: "auth.ts" },
      startEntityId: null,
      collisions: [],
    };
    expect(isConflictBrief(b)).toBe(true);
    expect(isConflictBrief({ ...b, collisions: undefined })).toBe(false);
  });

  it("isHuddleBrief checks the contributions array", () => {
    const b = {
      kind: "huddle",
      agentVersion: 1,
      generatedAt: 1,
      latencyMs: 1,
      gaps: [],
      query: { sinceMs: 0 },
      contributions: [],
    };
    expect(isHuddleBrief(b)).toBe(true);
    expect(isHuddleBrief({ ...b, kind: "ghost" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/agents/_lib/findings.test.ts`
Expected: FAIL — `isGhostBrief` etc. not exported.

- [ ] **Step 3: Add the types + guards in `findings.ts`**

Append to `packages/gateway/src/agents/_lib/findings.ts` (before the existing `AgentBrief` union if
convenient; the union must be updated too):

```ts
import type { ExpertiseRank, FederatedItem } from "../../federation/types.ts";

/** A leak-proof projection of FederatedItem (no metadata), reused by the huddle buckets. */
export type FederatedItemLite = {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
};

export type GhostFinding = {
  peerId: string;
  expert: string | null;
  rank: ExpertiseRank;
  context: FederatedItemLite[];
  suggestedContact: string;
};

export type GhostBrief = AgentBriefBase & {
  kind: "ghost";
  query: { file: string };
  startEntityId: string | null;
  findings: GhostFinding[];
};

export type ConflictType = "open_pr" | "assigned_ticket" | "recent_commit" | "open_branch";

export type ConflictFinding = {
  peerId: string;
  who: string | null;
  service: string;
  collisionType: ConflictType;
  title: string;
  snippet: string;
  modifiedAt: number;
};

export type ConflictBrief = AgentBriefBase & {
  kind: "conflict";
  query: { file: string };
  startEntityId: string | null;
  collisions: ConflictFinding[];
};

export type HuddleContribution = {
  peerId: string;
  who: string | null;
  prs: FederatedItemLite[];
  tickets: FederatedItemLite[];
  incidents: FederatedItemLite[];
};

export type HuddleBrief = AgentBriefBase & {
  kind: "huddle";
  query: { sinceMs: number };
  contributions: HuddleContribution[];
};

export function isGhostBrief(x: unknown): x is GhostBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "ghost" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["findings"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isConflictBrief(x: unknown): x is ConflictBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "conflict" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["collisions"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}

export function isHuddleBrief(x: unknown): x is HuddleBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "huddle" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["contributions"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}
```

Update the existing `AgentBrief` union in `findings.ts`:

```ts
export type AgentBrief =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief;
```

- [ ] **Step 4: Extend `emit-brief.ts` and `synthesize.ts` unions**

In `packages/gateway/src/agents/_lib/emit-brief.ts`, update the import and the `AnyBrief` type:

```ts
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  GhostBrief,
  HuddleBrief,
  ImpactBrief,
} from "./findings.ts";

type AnyBrief =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief;
```

In `packages/gateway/src/agents/_lib/synthesize.ts`, update the import, `SynthInput`, `toolNameFor`,
and `deterministicRender`:

```ts
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  GhostBrief,
  HuddleBrief,
  ImpactBrief,
} from "./findings.ts";
import {
  renderCatchup,
  renderConflict,
  renderExpert,
  renderGhost,
  renderHuddle,
  renderImpact,
} from "./render.ts";

type SynthInput =
  | ExpertBrief
  | ImpactBrief
  | CatchupBrief
  | GhostBrief
  | ConflictBrief
  | HuddleBrief;

function deterministicRender(brief: SynthInput): string {
  if (brief.kind === "expert") return renderExpert(brief);
  if (brief.kind === "impact") return renderImpact(brief);
  if (brief.kind === "catchup") return renderCatchup(brief);
  if (brief.kind === "ghost") return renderGhost(brief);
  if (brief.kind === "conflict") return renderConflict(brief);
  return renderHuddle(brief);
}

function toolNameFor(brief: SynthInput): string {
  if (brief.kind === "expert") return "agents.expert";
  if (brief.kind === "impact") return "agents.impact";
  if (brief.kind === "catchup") return "agents.catchup";
  if (brief.kind === "ghost") return "agents.ghost";
  if (brief.kind === "conflict") return "agents.conflicts";
  return "agents.huddle";
}
```

- [ ] **Step 5: Add the renderers in `render.ts`**

Append to `packages/gateway/src/agents/_lib/render.ts` (extend the import line with the new types):

```ts
import type {
  ConflictBrief,
  ConflictFinding,
  GhostBrief,
  GhostFinding,
  HuddleBrief,
} from "./findings.ts";

function renderGhostFinding(f: GhostFinding): string {
  const head = `**${f.expert ?? f.peerId}** (${f.rank}) — ${f.suggestedContact}`;
  if (f.context.length === 0) return `- ${head}`;
  const lines = f.context.slice(0, 5).map((c) => `   - ${c.title} (\`${c.service}\`)`);
  return [`- ${head}`, ...lines].join("\n");
}

export function renderGhost(brief: GhostBrief): string {
  const header = `# Ghost: ${brief.query.file}`;
  const body =
    brief.findings.length === 0
      ? "_no teammate context found_"
      : brief.findings.map(renderGhostFinding).join("\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
}

function renderConflictFinding(f: ConflictFinding): string {
  return `- **${f.who ?? f.peerId}** — ${f.collisionType.replaceAll("_", " ")}: ${f.title} (\`${
    f.service
  }\`)`;
}

export function renderConflict(brief: ConflictBrief): string {
  const header = `# Conflicts: ${brief.query.file}`;
  const body =
    brief.collisions.length === 0
      ? "_no work-in-progress collisions found_"
      : brief.collisions.map(renderConflictFinding).join("\n");
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", body, gaps, footer].filter((s) => s !== "").join("\n");
}

export function renderHuddle(brief: HuddleBrief): string {
  const header = "# Team Huddle";
  const sections: string[] = [];
  if (brief.contributions.length === 0) {
    sections.push("_no teammate activity in the window_");
  } else {
    for (const c of brief.contributions) {
      const heading = `## ${c.who ?? c.peerId}`;
      const lines = [
        ...c.prs.map((p) => `- PR: ${p.title}`),
        ...c.tickets.map((t) => `- Ticket: ${t.title}`),
        ...c.incidents.map((i) => `- Incident: ${i.title}`),
      ];
      sections.push([heading, "", ...(lines.length === 0 ? ["_quiet_"] : lines)].join("\n"));
    }
  }
  const gaps = renderGaps(brief.gaps);
  const footer = renderLatency(brief.latencyMs);
  return [header, "", ...sections, gaps, footer].filter((s) => s !== "").join("\n");
}
```

- [ ] **Step 6: Run tests + typecheck + commit**

Run: `cd packages/gateway && timeout 60 bun test src/agents/_lib/findings.test.ts && bunx tsc --noEmit`
Expected: PASS

```bash
git add packages/gateway/src/agents/_lib/
git commit -m "feat(agents): ghost/conflict/huddle brief types, guards, renderers"
```

---

## Task 4: `peer-fanout.ts` — bounded-parallel federated fan-out

**Files:**

- Create: `packages/gateway/src/federation/peer-fanout.ts`
- Create: `packages/gateway/src/federation/peer-fanout.test.ts`

The helper iterates paired peers in bounded parallel, calls the shipped wire methods, records the
namespace cache on an answered query, prunes on `no_grant`, and turns every other failure into a gap
note.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/federation/peer-fanout.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { fanOutExpertise, fanOutQuery } from "./peer-fanout.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function seedTwoPeers(db: Database): LocalIndex {
  const idx = new LocalIndex(db);
  idx.addLanPeer({
    peerId: "peer:aa",
    pubkey: new Uint8Array(32).fill(1),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7401,
    displayName: "Alice",
  });
  idx.addLanPeer({
    peerId: "peer:bb",
    pubkey: new Uint8Array(32).fill(2),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7402,
    displayName: "Bob",
  });
  return idx;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("fanOutQuery", () => {
  it("aggregates answered peers and records the namespace cache", async () => {
    const db = freshDb();
    const index = seedTwoPeers(db);
    const store = new KnownNamespaceStore(db);
    const send = async (_h: string, _p: number, _s: BoxKeypair, pubkey: Uint8Array) => {
      // Alice answers with one PR; Bob's grant is gone.
      if (pubkey[0] === 1) {
        return {
          items: [
            { id: "i1", service: "github", type: "pr", title: "fix auth race", snippet: "x", modifiedAt: 10 },
          ],
        };
      }
      throw new Error("lan-client: peer error no_grant");
    };
    const out = await fanOutQuery(
      { index, selfIdentity: SELF, sendOverWire: send, store, now: () => 5 },
      { namespace: "project:zurich", purpose: "ghost", types: ["pr"] },
    );
    expect(out.perPeer).toEqual([
      {
        peerId: "peer:aa",
        displayName: "Alice",
        items: [
          { id: "i1", service: "github", type: "pr", title: "fix auth race", snippet: "x", modifiedAt: 10 },
        ],
      },
    ]);
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]?.detail).toContain("Bob");
    // Alice answered -> cached; Bob no_grant -> pruned (was never present, no-op).
    expect(store.list()).toEqual([{ peerId: "peer:aa", namespace: "project:zurich" }]);
  });

  it("silently skips peers with a null host (matches team.auditMerged)", async () => {
    const db = freshDb();
    const idx = new LocalIndex(db);
    idx.addLanPeer({
      peerId: "peer:cc",
      pubkey: new Uint8Array(32).fill(3),
      direction: "inbound",
      hostIp: null,
      hostPort: null,
      displayName: "Carol",
    });
    const out = await fanOutQuery(
      { index: idx, selfIdentity: SELF, sendOverWire: async () => ({ items: [] }), store: new KnownNamespaceStore(db) },
      { namespace: "ns", purpose: "ghost" },
    );
    // A null-host peer is inbound-only (no dial-back address) — not a fan-out target and not a
    // transient error. reachablePeers() filters it out BEFORE the pool, matching the shipped
    // team.auditMerged convention (federation-rpc.ts: `if (host_ip === null) continue;`). No gap.
    expect(out.perPeer).toEqual([]);
    expect(out.gaps).toEqual([]);
  });
});

describe("fanOutExpertise", () => {
  it("returns one rank per answering peer", async () => {
    const db = freshDb();
    const index = seedTwoPeers(db);
    const send = async (_h: string, _p: number, _s: BoxKeypair, pubkey: Uint8Array) =>
      pubkey[0] === 1 ? { rank: "high" } : { rank: "none" };
    const out = await fanOutExpertise(
      { index, selfIdentity: SELF, sendOverWire: send, store: new KnownNamespaceStore(db) },
      { query: "auth.ts", purpose: "ghost" },
    );
    expect(out.perPeer).toEqual([
      { peerId: "peer:aa", displayName: "Alice", rank: "high" },
      { peerId: "peer:bb", displayName: "Bob", rank: "none" },
    ]);
  });
});
```

> NOTE: confirm `LocalIndex.addLanPeer`'s exact parameter shape before running (read
> `local-index.ts` around line 838). If it differs from the object form above, adapt the seed
> helper — the rest of the test is unaffected.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/federation/peer-fanout.test.ts`
Expected: FAIL — `peer-fanout.ts` not found.

- [ ] **Step 3: Implement the fan-out helper**

Create `packages/gateway/src/federation/peer-fanout.ts`:

```ts
import type { GapNote } from "../agents/_lib/findings.ts";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LanPeerRow, LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { ExpertiseRank, FederatedItem } from "./types.ts";

const FANOUT_CONCURRENCY = 5;

export interface PeerFanoutDeps {
  readonly index: LocalIndex;
  readonly selfIdentity: BoxKeypair;
  readonly store: KnownNamespaceStore;
  /** DI seam — defaults to the real over-the-wire client; faked in tests. */
  readonly sendOverWire?: typeof sendFederatedOverWire;
  readonly now?: () => number;
}

export interface PeerQueryResult {
  readonly peerId: string;
  readonly displayName: string | null;
  readonly items: readonly FederatedItem[];
}

export interface PeerExpertiseResult {
  readonly peerId: string;
  readonly displayName: string | null;
  readonly rank: ExpertiseRank;
}

export interface PeerFanoutOutcome<T> {
  readonly perPeer: readonly T[];
  readonly gaps: readonly GapNote[];
}

function reachablePeers(index: LocalIndex): LanPeerRow[] {
  return index.listLanPeers().filter((r) => r.host_ip !== null && r.host_port !== null);
}

function gapForPeer(row: LanPeerRow, err: unknown): GapNote {
  const who = row.display_name ?? row.peer_id;
  const msg = err instanceof Error ? err.message : String(err);
  return { category: "missing_connector", detail: `peer ${who}: ${msg}` };
}

function isNoGrant(err: unknown): boolean {
  return err instanceof Error && err.message.includes("no_grant");
}

/** Bounded-parallel map: at most FANOUT_CONCURRENCY in-flight; never rejects (errors map to gaps). */
async function runPool<T>(
  rows: LanPeerRow[],
  worker: (row: LanPeerRow) => Promise<{ ok: T } | { gap: GapNote }>,
): Promise<{ perPeer: T[]; gaps: GapNote[] }> {
  const perPeer: T[] = [];
  const gaps: GapNote[] = [];
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < rows.length) {
      const row = rows[cursor++];
      if (row === undefined) return;
      const r = await worker(row);
      if ("ok" in r) perPeer.push(r.ok);
      else gaps.push(r.gap);
    }
  }
  const lanes = Math.min(FANOUT_CONCURRENCY, rows.length);
  await Promise.all(Array.from({ length: lanes }, () => pump()));
  return { perPeer, gaps };
}

export async function fanOutQuery(
  deps: PeerFanoutDeps,
  req: { namespace: string; purpose: string; types?: readonly string[] },
): Promise<PeerFanoutOutcome<PeerQueryResult>> {
  const send = deps.sendOverWire ?? sendFederatedOverWire;
  const nowMs = (deps.now ?? Date.now)();
  const body: Record<string, unknown> = { namespace: req.namespace, purpose: req.purpose };
  if (req.types !== undefined) body["types"] = [...req.types];

  const { perPeer, gaps } = await runPool<PeerQueryResult>(reachablePeers(deps.index), async (row) => {
    try {
      const result = (await send(
        row.host_ip as string,
        row.host_port as number,
        deps.selfIdentity,
        row.peer_pubkey,
        "federation.query",
        body,
      )) as { items?: readonly FederatedItem[] };
      deps.store.record(row.peer_id, req.namespace, nowMs);
      return {
        ok: { peerId: row.peer_id, displayName: row.display_name, items: result.items ?? [] },
      };
    } catch (err) {
      if (isNoGrant(err)) deps.store.prune(row.peer_id, req.namespace);
      return { gap: gapForPeer(row, err) };
    }
  });
  perPeer.sort((a, b) => a.peerId.localeCompare(b.peerId));
  return { perPeer, gaps };
}

export async function fanOutExpertise(
  deps: PeerFanoutDeps,
  req: { query: string; purpose: string },
): Promise<PeerFanoutOutcome<PeerExpertiseResult>> {
  const send = deps.sendOverWire ?? sendFederatedOverWire;
  const { perPeer, gaps } = await runPool<PeerExpertiseResult>(
    reachablePeers(deps.index),
    async (row) => {
      try {
        const result = (await send(
          row.host_ip as string,
          row.host_port as number,
          deps.selfIdentity,
          row.peer_pubkey,
          "federation.expertise",
          { query: req.query, purpose: req.purpose },
        )) as { rank?: ExpertiseRank };
        return {
          ok: { peerId: row.peer_id, displayName: row.display_name, rank: result.rank ?? "none" },
        };
      } catch (err) {
        return { gap: gapForPeer(row, err) };
      }
    },
  );
  perPeer.sort((a, b) => a.peerId.localeCompare(b.peerId));
  return { perPeer, gaps };
}
```

> NOTE: `runPool` does not preserve input order across concurrency lanes, so both fan-out functions
> sort `perPeer` by `peerId` before returning. This removes display jitter (consecutive
> `nimbus huddle` / `ghost` runs render peers in a stable order despite network-timing differences)
> and makes the expertise test deterministic regardless of lane scheduling.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/gateway && timeout 60 bun test src/federation/peer-fanout.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/gateway && bunx tsc --noEmit
cd ../.. && git add packages/gateway/src/federation/peer-fanout.ts \
  packages/gateway/src/federation/peer-fanout.test.ts
git commit -m "feat(federation): bounded-parallel peer fan-out over query/expertise"
```

---

## Task 5: `match-token.ts` — machine-portable file resolution

**Files:**

- Create: `packages/gateway/src/agents/_lib/match-token.ts`
- Create: `packages/gateway/src/agents/_lib/match-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/_lib/match-token.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { resolveMatchToken, symbolExistsLocally } from "./match-token.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("resolveMatchToken", () => {
  it("uses the graph_entity symbol label when one resolves", () => {
    const db = freshDb();
    db.run(
      "INSERT INTO graph_entity (id, type, label, external_id) VALUES (?, 'symbol', ?, ?)",
      ["e1", "src/auth.ts", "sym:src/auth.ts"],
    );
    const r = resolveMatchToken(db, "C:\\\\repo\\\\src\\\\auth.ts");
    expect(r.token).toBe("src/auth.ts");
    expect(r.entityId).toBe("e1");
  });

  it("falls back to the basename when no entity resolves", () => {
    const db = freshDb();
    const r = resolveMatchToken(db, "/Users/bob/project/src/auth.ts");
    expect(r.token).toBe("auth.ts");
    expect(r.entityId).toBeNull();
  });
});

describe("symbolExistsLocally", () => {
  it("is true when a matching symbol exists, false otherwise", () => {
    const db = freshDb();
    db.run("INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e1','symbol','src/auth.ts','x')");
    expect(symbolExistsLocally(db, "src/auth.ts")).toBe(true);
    expect(symbolExistsLocally(db, "gone.ts")).toBe(false);
  });
});
```

> NOTE: confirm the `graph_entity` columns (`id`, `type`, `label`, `external_id`) exist in the V38
> schema before running (read `impact.ts:resolveStartEntity`, which queries the same table). Adjust
> the INSERT if a NOT NULL column is missing.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/agents/_lib/match-token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/gateway/src/agents/_lib/match-token.ts`:

```ts
import type { Database } from "bun:sqlite";

export interface ResolvedToken {
  /** The graph entity id when one resolved, else null. */
  readonly entityId: string | null;
  /** A machine-portable match token: a symbol/repo-relative label, else the file basename. */
  readonly token: string;
}

function basename(fileOrPath: string): string {
  const parts = fileOrPath.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.at(-1) ?? fileOrPath;
}

/**
 * Resolve a user-supplied file argument to a machine-portable match token. Prefers the local
 * graph's symbol label (service-relative, e.g. a repo-relative path) so the token matches across
 * machines; falls back to the file basename. Never returns the absolute local path.
 */
export function resolveMatchToken(db: Database, fileArg: string): ResolvedToken {
  const base = basename(fileArg);
  const exact = db
    .query("SELECT id, label FROM graph_entity WHERE type = 'symbol' AND label = ? LIMIT 1")
    .get(fileArg) as { id?: string; label?: string } | null;
  if (exact?.id !== undefined && exact.label !== undefined) {
    return { entityId: exact.id, token: exact.label };
  }
  const byBase = db
    .query(
      "SELECT id, label FROM graph_entity WHERE type = 'symbol' AND label LIKE '%' || ? || '%' " +
        "ORDER BY length(label) ASC, id ASC LIMIT 1",
    )
    .get(base) as { id?: string; label?: string } | null;
  if (byBase?.id !== undefined && byBase.label !== undefined) {
    return { entityId: byBase.id, token: byBase.label };
  }
  return { entityId: null, token: base };
}

/** Local check: does a symbol whose label contains `token` still exist in the graph? */
export function symbolExistsLocally(db: Database, token: string): boolean {
  const row = db
    .query(
      "SELECT 1 AS hit FROM graph_entity WHERE type = 'symbol' AND label LIKE '%' || ? || '%' LIMIT 1",
    )
    .get(token) as { hit?: number } | null;
  return row?.hit === 1;
}
```

> NOTE: do NOT wrap the `LIKE` clauses in `LOWER()`. SQLite `LIKE` is already case-insensitive for
> ASCII by default, so `%Auth.ts%` matches a stored `src/auth.ts` — the case-variant fallback is
> already covered. `LOWER()` would only re-apply ASCII folding (SQLite's stock `lower()` is
> ASCII-only too — it does not fix Unicode), while defeating index use. The only case-sensitive
> probe is the exact `label = ?`; a case variant there falls through to the case-insensitive LIKE.

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

Run: `cd packages/gateway && timeout 60 bun test src/agents/_lib/match-token.test.ts && bunx tsc --noEmit`
Expected: PASS

```bash
git add packages/gateway/src/agents/_lib/match-token.ts \
  packages/gateway/src/agents/_lib/match-token.test.ts
git commit -m "feat(agents): machine-portable match-token resolver"
```

---

## Task 6: Ghost reviewers agent — `agents/ghost.ts`

**Files:**

- Create: `packages/gateway/src/agents/ghost.ts`
- Create: `packages/gateway/src/agents/ghost.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/ghost.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { runGhost } from "./ghost.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("runGhost", () => {
  it("ranks contacts by expertise and pulls matching context, suppressing dead symbols", async () => {
    const db = freshDb();
    db.run("INSERT INTO graph_entity (id, type, label, external_id) VALUES ('e1','symbol','src/auth.ts','x')");
    const index = new LocalIndex(db);
    index.addLanPeer({
      peerId: "peer:aa",
      pubkey: new Uint8Array(32).fill(1),
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7401,
      displayName: "Alice",
    });
    const send = async (_h: string, _p: number, _s: BoxKeypair, _k: Uint8Array, method: string) => {
      if (method === "federation.expertise") return { rank: "high" };
      return {
        items: [
          { id: "i1", service: "github", type: "pr", title: "fix race in src/auth.ts", snippet: "y", modifiedAt: 20 },
          { id: "i2", service: "github", type: "pr", title: "unrelated change", snippet: "z", modifiedAt: 10 },
        ],
      };
    };
    const brief = await runGhost(
      { file: "src/auth.ts", namespaces: ["project:zurich"] },
      { db, index, selfIdentity: SELF, sendOverWire: send, store: new KnownNamespaceStore(db), sessionId: "s1", notify: () => {} },
    );
    expect(brief.kind).toBe("ghost");
    expect(brief.findings).toHaveLength(1);
    expect(brief.findings[0]?.expert).toBe("Alice");
    expect(brief.findings[0]?.rank).toBe("high");
    // Only the item whose title matches the token "src/auth.ts" is kept.
    expect(brief.findings[0]?.context.map((c) => c.title)).toEqual(["fix race in src/auth.ts"]);
  });

  it("emits a gap when there are no paired peers", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    const brief = await runGhost(
      { file: "auth.ts", namespaces: ["ns"] },
      { db, index, selfIdentity: SELF, sendOverWire: async () => ({ items: [] }), store: new KnownNamespaceStore(db), sessionId: "s1", notify: () => {} },
    );
    expect(brief.findings).toHaveLength(0);
    expect(brief.gaps.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/agents/ghost.test.ts`
Expected: FAIL — `ghost.ts` not found.

- [ ] **Step 3: Implement the agent**

Create `packages/gateway/src/agents/ghost.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import {
  fanOutExpertise,
  fanOutQuery,
  type PeerExpertiseResult,
  type PeerQueryResult,
} from "../federation/peer-fanout.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote, GhostBrief, GhostFinding } from "./_lib/findings.ts";
import { resolveMatchToken, symbolExistsLocally } from "./_lib/match-token.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

const GHOST_TYPES = ["pr", "issue", "incident", "commit"] as const;

export type GhostInput = { file: string; namespaces: string[] };

export type GhostContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

function fanoutDeps(ctx: GhostContext) {
  const deps: {
    index: LocalIndex;
    selfIdentity: BoxKeypair;
    store: KnownNamespaceStore;
    sendOverWire?: typeof sendFederatedOverWire;
  } = { index: ctx.index, selfIdentity: ctx.selfIdentity, store: ctx.store };
  if (ctx.sendOverWire !== undefined) deps.sendOverWire = ctx.sendOverWire;
  return deps;
}

function suggested(rank: string, who: string): string {
  return `Ask ${who} (${rank} relevance)`;
}

export async function runGhost(input: GhostInput, ctx: GhostContext): Promise<GhostBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  const resolved = resolveMatchToken(ctx.db, input.file);

  if (input.namespaces.length === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "no known namespaces — pass --namespace <name>",
    });
  }
  if (ctx.index.listLanPeers().length === 0) {
    gaps.push({ category: "missing_connector", detail: "no paired peers — run `nimbus team pair`" });
  }

  const deps = fanoutDeps(ctx);

  // Expertise: who knows this token.
  const exp = await fanOutExpertise(deps, { query: resolved.token, purpose: "ghost" });
  gaps.push(...exp.gaps);
  const rankByPeer = new Map<string, PeerExpertiseResult>();
  for (const r of exp.perPeer) rankByPeer.set(r.peerId, r);

  // Context: what they did, across each known namespace, filtered locally to the token.
  const ctxByPeer = new Map<string, PeerQueryResult["items"][number][]>();
  for (const ns of input.namespaces) {
    const q = await fanOutQuery(deps, { namespace: ns, purpose: "ghost", types: [...GHOST_TYPES] });
    gaps.push(...q.gaps);
    for (const peer of q.perPeer) {
      const matched = peer.items.filter(
        (it) =>
          it.title.includes(resolved.token) || it.snippet.includes(resolved.token),
      );
      if (matched.length === 0) continue;
      const acc = ctxByPeer.get(peer.peerId) ?? [];
      acc.push(...matched);
      ctxByPeer.set(peer.peerId, acc);
    }
  }

  const findings: GhostFinding[] = [];
  for (const [peerId, rankRes] of rankByPeer) {
    if (rankRes.rank === "none") continue;
    const context = (ctxByPeer.get(peerId) ?? [])
      .filter((it) => symbolExistsLocally(ctx.db, resolved.token) || it.type !== "commit")
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map((it) => ({ title: it.title, snippet: it.snippet, service: it.service, modifiedAt: it.modifiedAt }));
    const who = rankRes.displayName ?? peerId;
    findings.push({
      peerId,
      expert: rankRes.displayName,
      rank: rankRes.rank,
      context,
      suggestedContact: suggested(rankRes.rank, who),
    });
  }
  findings.sort((a, b) => rankWeight(b.rank) - rankWeight(a.rank));

  return {
    kind: "ghost",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { file: input.file },
    startEntityId: resolved.entityId,
    findings,
  };
}

function rankWeight(rank: string): number {
  if (rank === "high") return 3;
  if (rank === "medium") return 2;
  if (rank === "low") return 1;
  return 0;
}

export function emitGhostBrief(input: GhostInput, ctx: GhostContext): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "ghost.briefReady",
    briefErrorMethod: "ghost.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runGhost(input, ctx),
  });
}
```

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

Run: `cd packages/gateway && timeout 60 bun test src/agents/ghost.test.ts && bunx tsc --noEmit`
Expected: PASS

```bash
git add packages/gateway/src/agents/ghost.ts packages/gateway/src/agents/ghost.test.ts
git commit -m "feat(agents): ghost reviewers agent"
```

---

## Task 7: Cross-user conflict detection — `agents/conflicts.ts`

**Files:**

- Create: `packages/gateway/src/agents/conflicts.ts`
- Create: `packages/gateway/src/agents/conflicts.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/conflicts.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { runConflicts } from "./conflicts.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("runConflicts", () => {
  it("classifies collision type from the federated item type and matches the token", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    index.addLanPeer({
      peerId: "peer:bb",
      pubkey: new Uint8Array(32).fill(2),
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7402,
      displayName: "Bob",
    });
    const send = async () => ({
      items: [
        { id: "p1", service: "github", type: "pr", title: "WIP src/auth.ts refactor", snippet: "", modifiedAt: 30 },
        { id: "t1", service: "jira", type: "issue", title: "auth.ts perms ticket", snippet: "src/auth.ts", modifiedAt: 25 },
        { id: "x1", service: "github", type: "pr", title: "no match here", snippet: "", modifiedAt: 5 },
      ],
    });
    const brief = await runConflicts(
      { file: "src/auth.ts", namespaces: ["project:zurich"] },
      { db, index, selfIdentity: SELF, sendOverWire: send, store: new KnownNamespaceStore(db), sessionId: "s1", notify: () => {} },
    );
    expect(brief.kind).toBe("conflict");
    expect(brief.collisions.map((c) => c.collisionType)).toEqual(["open_pr", "assigned_ticket"]);
    expect(brief.collisions[0]?.who).toBe("Bob");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/agents/conflicts.test.ts`
Expected: FAIL — `conflicts.ts` not found.

- [ ] **Step 3: Implement the agent**

Create `packages/gateway/src/agents/conflicts.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import { fanOutQuery } from "../federation/peer-fanout.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type {
  ConflictBrief,
  ConflictFinding,
  ConflictType,
  GapNote,
} from "./_lib/findings.ts";
import { resolveMatchToken } from "./_lib/match-token.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

const CONFLICT_TYPES = ["pr", "issue", "commit"] as const;

export type ConflictInput = { file: string; namespaces: string[] };

export type ConflictContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
};

function classify(itemType: string): ConflictType {
  if (itemType === "issue") return "assigned_ticket";
  if (itemType === "commit") return "recent_commit";
  return "open_pr";
}

export async function runConflicts(
  input: ConflictInput,
  ctx: ConflictContext,
): Promise<ConflictBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  const resolved = resolveMatchToken(ctx.db, input.file);

  if (input.namespaces.length === 0) {
    gaps.push({ category: "missing_connector", detail: "no known namespaces — pass --namespace <name>" });
  }
  if (ctx.index.listLanPeers().length === 0) {
    gaps.push({ category: "missing_connector", detail: "no paired peers — run `nimbus team pair`" });
  }

  const deps: {
    index: LocalIndex;
    selfIdentity: BoxKeypair;
    store: KnownNamespaceStore;
    sendOverWire?: typeof sendFederatedOverWire;
  } = { index: ctx.index, selfIdentity: ctx.selfIdentity, store: ctx.store };
  if (ctx.sendOverWire !== undefined) deps.sendOverWire = ctx.sendOverWire;

  const collisions: ConflictFinding[] = [];
  for (const ns of input.namespaces) {
    const q = await fanOutQuery(deps, { namespace: ns, purpose: "conflicts", types: [...CONFLICT_TYPES] });
    gaps.push(...q.gaps);
    for (const peer of q.perPeer) {
      for (const it of peer.items) {
        if (!it.title.includes(resolved.token) && !it.snippet.includes(resolved.token)) continue;
        collisions.push({
          peerId: peer.peerId,
          who: peer.displayName,
          service: it.service,
          collisionType: classify(it.type),
          title: it.title,
          snippet: it.snippet,
          modifiedAt: it.modifiedAt,
        });
      }
    }
  }
  collisions.sort((a, b) => b.modifiedAt - a.modifiedAt);

  return {
    kind: "conflict",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { file: input.file },
    startEntityId: resolved.entityId,
    collisions,
  };
}

export function emitConflictsBrief(
  input: ConflictInput,
  ctx: ConflictContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "conflicts.briefReady",
    briefErrorMethod: "conflicts.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runConflicts(input, ctx),
  });
}
```

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

Run: `cd packages/gateway && timeout 60 bun test src/agents/conflicts.test.ts && bunx tsc --noEmit`
Expected: PASS

```bash
git add packages/gateway/src/agents/conflicts.ts packages/gateway/src/agents/conflicts.test.ts
git commit -m "feat(agents): cross-user conflict detection agent"
```

---

## Task 8: Team huddle briefing — `agents/huddle.ts`

**Files:**

- Create: `packages/gateway/src/agents/huddle.ts`
- Create: `packages/gateway/src/agents/huddle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/agents/huddle.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { runHuddle } from "./huddle.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("runHuddle", () => {
  it("buckets each peer's items by type within the window", async () => {
    const db = freshDb();
    const index = new LocalIndex(db);
    index.addLanPeer({
      peerId: "peer:aa",
      pubkey: new Uint8Array(32).fill(1),
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7401,
      displayName: "Alice",
    });
    const send = async () => ({
      items: [
        { id: "p1", service: "github", type: "pr", title: "ship feature", snippet: "", modifiedAt: 1000 },
        { id: "t1", service: "jira", type: "issue", title: "fix bug", snippet: "", modifiedAt: 1000 },
        { id: "n1", service: "pagerduty", type: "incident", title: "page resolved", snippet: "", modifiedAt: 500 },
        { id: "old", service: "github", type: "pr", title: "stale", snippet: "", modifiedAt: 1 },
      ],
    });
    const store = new KnownNamespaceStore(db);
    store.record("peer:aa", "project:zurich", 1);
    const brief = await runHuddle(
      { sinceMs: 100, namespaces: ["project:zurich"] },
      // now=600, sinceMs=100 -> cutoff=500: keeps modifiedAt 1000 & 500, drops "stale" (1).
      { db, index, selfIdentity: SELF, sendOverWire: send, store, sessionId: "s1", notify: () => {}, now: () => 600 },
    );
    expect(brief.kind).toBe("huddle");
    expect(brief.contributions).toHaveLength(1);
    const c = brief.contributions[0];
    expect(c?.prs.map((p) => p.title)).toEqual(["ship feature"]); // "stale" is before the window
    expect(c?.tickets).toHaveLength(1);
    expect(c?.incidents).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/agents/huddle.test.ts`
Expected: FAIL — `huddle.ts` not found.

- [ ] **Step 3: Implement the agent**

Create `packages/gateway/src/agents/huddle.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import type { sendFederatedOverWire } from "../ipc/lan-client.ts";
import { fanOutQuery } from "../federation/peer-fanout.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type {
  FederatedItemLite,
  GapNote,
  HuddleBrief,
  HuddleContribution,
} from "./_lib/findings.ts";
import type { SynthesizerLlm } from "./_lib/synthesize.ts";

const HUDDLE_TYPES = ["pr", "issue", "incident"] as const;
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

export type HuddleInput = { sinceMs?: number; namespaces: string[] };

export type HuddleContext = {
  db: Database;
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  /** Injectable clock for deterministic window tests; production omits it (defaults Date.now). */
  now?: () => number;
};

function lite(it: { title: string; snippet: string; service: string; modifiedAt: number }): FederatedItemLite {
  return { title: it.title, snippet: it.snippet, service: it.service, modifiedAt: it.modifiedAt };
}

export async function runHuddle(input: HuddleInput, ctx: HuddleContext): Promise<HuddleBrief> {
  const start = performance.now();
  const gaps: GapNote[] = [];
  const sinceMs = input.sinceMs ?? DEFAULT_SINCE_MS;
  const cutoff = (ctx.now ?? Date.now)() - sinceMs;

  // Resolve namespaces: explicit, else the asker-side cache default.
  const namespaces =
    input.namespaces.length > 0
      ? input.namespaces
      : [...new Set(ctx.store.list().map((r) => r.namespace))];
  if (namespaces.length === 0) {
    gaps.push({ category: "missing_connector", detail: "no known namespaces — pass --namespace <name>" });
  }
  if (ctx.index.listLanPeers().length === 0) {
    gaps.push({ category: "missing_connector", detail: "no paired peers — run `nimbus team pair`" });
  }

  const deps: {
    index: LocalIndex;
    selfIdentity: BoxKeypair;
    store: KnownNamespaceStore;
    sendOverWire?: typeof sendFederatedOverWire;
  } = { index: ctx.index, selfIdentity: ctx.selfIdentity, store: ctx.store };
  if (ctx.sendOverWire !== undefined) deps.sendOverWire = ctx.sendOverWire;

  const byPeer = new Map<string, HuddleContribution>();
  for (const ns of namespaces) {
    const q = await fanOutQuery(deps, { namespace: ns, purpose: "huddle", types: [...HUDDLE_TYPES] });
    gaps.push(...q.gaps);
    for (const peer of q.perPeer) {
      const contrib =
        byPeer.get(peer.peerId) ??
        { peerId: peer.peerId, who: peer.displayName, prs: [], tickets: [], incidents: [] };
      for (const it of peer.items) {
        if (it.modifiedAt < cutoff) continue;
        if (it.type === "pr") contrib.prs.push(lite(it));
        else if (it.type === "issue") contrib.tickets.push(lite(it));
        else if (it.type === "incident") contrib.incidents.push(lite(it));
      }
      byPeer.set(peer.peerId, contrib);
    }
  }

  return {
    kind: "huddle",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { sinceMs },
    contributions: [...byPeer.values()].filter(
      (c) => c.prs.length + c.tickets.length + c.incidents.length > 0,
    ),
  };
}

export function emitHuddleBrief(input: HuddleInput, ctx: HuddleContext): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "huddle.briefReady",
    briefErrorMethod: "huddle.briefError",
    notify: ctx.notify,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    buildBrief: () => runHuddle(input, ctx),
  });
}
```

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

Run: `cd packages/gateway && timeout 60 bun test src/agents/huddle.test.ts && bunx tsc --noEmit`
Expected: PASS

```bash
git add packages/gateway/src/agents/huddle.ts packages/gateway/src/agents/huddle.test.ts
git commit -m "feat(agents): team huddle briefing agent"
```

---

## Task 9: IPC wiring — `agents.ghost / conflicts / huddle`

**Files:**

- Modify: `packages/gateway/src/ipc/agents-rpc.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts:112`
- Modify: `packages/gateway/src/ipc/agents-rpc.test.ts`

The agents need asker-side deps. `AgentsRpcContext` gains `index?`, `selfIdentity?`, `sendOverWire?`.
When `index`/`selfIdentity` are absent (federation disabled), the agents must still return a brief
with a gap note — so each handler guards and emits a degraded brief rather than throwing.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/ipc/agents-rpc.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { LocalIndex } from "../index/local-index.ts";

describe("agents.ghost / conflicts / huddle dispatch", () => {
  function ctxWithFederation() {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 38);
    const index = new LocalIndex(db);
    return {
      db,
      notify: () => {},
      index,
      selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
      sendOverWire: async () => ({ items: [] }),
    };
  }

  it("agents.ghost returns a sessionId", async () => {
    const out = await dispatchAgentsRpc("agents.ghost", { file: "auth.ts" }, ctxWithFederation());
    expect(out.kind).toBe("hit");
  });

  it("agents.conflicts validates the file param", async () => {
    await expect(
      dispatchAgentsRpc("agents.conflicts", {}, ctxWithFederation()),
    ).rejects.toThrow();
  });

  it("agents.huddle works with no file param", async () => {
    const out = await dispatchAgentsRpc("agents.huddle", { sinceMs: 1000 }, ctxWithFederation());
    expect(out.kind).toBe("hit");
  });

  it("agents.ghost without federation deps still returns a brief (degraded)", async () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 38);
    const out = await dispatchAgentsRpc("agents.ghost", { file: "auth.ts" }, { db, notify: () => {} });
    expect(out.kind).toBe("hit");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/ipc/agents-rpc.test.ts`
Expected: FAIL — methods not handled / context fields unknown.

- [ ] **Step 3: Extend `agents-rpc.ts`**

In `packages/gateway/src/ipc/agents-rpc.ts`, extend imports and the context type:

```ts
import type { BoxKeypair } from "./lan-crypto.ts";
import type { sendFederatedOverWire } from "./lan-client.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { emitGhostBrief } from "../agents/ghost.ts";
import { emitConflictsBrief } from "../agents/conflicts.ts";
import { emitHuddleBrief } from "../agents/huddle.ts";

export type AgentsRpcContext = {
  db: Database;
  llm?: SynthesizerLlm;
  notify: (method: string, params: unknown) => void;
  configDir?: string;
  index?: LocalIndex;
  selfIdentity?: BoxKeypair;
  sendOverWire?: typeof sendFederatedOverWire;
};
```

Add a shared param validator and the three handlers (place near `requireImpactParams`):

```ts
const MAX_NAMESPACE_LEN = 256;

function parseNamespaces(p: { namespace?: unknown; namespaces?: unknown }): string[] {
  const raw = p.namespaces ?? p.namespace;
  if (raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_NAMESPACE_LEN) {
      throw new AgentsRpcError(-32602, `namespace must be a non-empty string up to ${MAX_NAMESPACE_LEN} chars`);
    }
    out.push(v.trim());
  }
  return out;
}

function requireFileParam(params: unknown): { file: string; namespaces: string[] } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "requires { file: string }");
  }
  const p = params as { file?: unknown; namespace?: unknown; namespaces?: unknown };
  if (typeof p.file !== "string" || p.file.trim().length < MIN_FILE_LEN || p.file.length > MAX_FILE_LEN) {
    throw new AgentsRpcError(-32602, `file must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars`);
  }
  return { file: p.file.trim(), namespaces: parseNamespaces(p) };
}

function federationDeps(ctx: AgentsRpcContext) {
  if (ctx.index === undefined || ctx.selfIdentity === undefined) return undefined;
  const deps: {
    index: LocalIndex;
    selfIdentity: BoxKeypair;
    store: KnownNamespaceStore;
    sendOverWire?: typeof sendFederatedOverWire;
  } = { index: ctx.index, selfIdentity: ctx.selfIdentity, store: new KnownNamespaceStore(ctx.db) };
  if (ctx.sendOverWire !== undefined) deps.sendOverWire = ctx.sendOverWire;
  return deps;
}

async function handleGhost(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireFileParam(params);
  const sessionId = `ghost_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  const deps = federationDeps(ctx);
  if (deps === undefined) {
    // Federation off: emit a degraded brief via a no-peer index + identity stub is impossible,
    // so route through emitGhostBrief with an empty index path by reporting a gap. Use the same
    // emitter with a minimal in-memory index/identity so the brief still emits with a gap note.
    return await emitGhostBrief(input, {
      db: ctx.db,
      index: emptyIndex(ctx.db),
      selfIdentity: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
      store: new KnownNamespaceStore(ctx.db),
      notify: ctx.notify,
      sessionId,
      ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
    });
  }
  return await emitGhostBrief(input, {
    db: ctx.db,
    ...deps,
    notify: ctx.notify,
    sessionId,
    ...(ctx.llm === undefined ? {} : { llm: ctx.llm }),
  });
}
```

> NOTE: `emptyIndex(ctx.db)` is just `new LocalIndex(ctx.db)` — a LocalIndex with no paired peers
> yields `listLanPeers() === []`, so the agent emits a "no paired peers" gap and an empty brief
> without any wire call. Define a one-line local helper `function emptyIndex(db: Database) { return new LocalIndex(db); }`
> or inline `new LocalIndex(ctx.db)`. Mirror `handleGhost` for `handleConflicts` (using
> `emitConflictsBrief`) and `handleHuddle` (using `emitHuddleBrief` + `requireHuddleParams`):

```ts
function requireHuddleParams(params: unknown): { sinceMs?: number; namespaces: string[] } {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.huddle requires an object payload");
  }
  const p = params as { sinceMs?: unknown; namespace?: unknown; namespaces?: unknown };
  const out: { sinceMs?: number; namespaces: string[] } = { namespaces: parseNamespaces(p) };
  if (p.sinceMs !== undefined) {
    if (typeof p.sinceMs !== "number" || !Number.isInteger(p.sinceMs) || p.sinceMs < 0 || p.sinceMs > MAX_SINCE_MS) {
      throw new AgentsRpcError(-32602, `sinceMs must be a non-negative integer up to ${MAX_SINCE_MS} ms`);
    }
    out.sinceMs = p.sinceMs;
  }
  return out;
}
```

Register the three methods in `dispatchAgentsRpc`:

```ts
  return dispatchByMethod<AgentsRpcContext>(method, params, ctx, {
    "agents.expert": handleExpert,
    "agents.impact": handleImpact,
    "agents.catchup": handleCatchup,
    "agents.ghost": handleGhost,
    "agents.conflicts": handleConflicts,
    "agents.huddle": handleHuddle,
  });
```

- [ ] **Step 4: Thread federation deps in `dispatchers.ts`**

In `packages/gateway/src/ipc/server/dispatchers.ts`, the `dispatchAgentsRpc` call (line ~112) gains
the asker-side deps. Use the same `ctx.options.federationIdentity` already used for federation-rpc
(line ~231) and `ctx.options.localIndex`:

```ts
    const out = await dispatchAgentsRpc(method, params, {
      db: ctx.options.localIndex.getDatabase(),
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
      ...(ctx.options.configDir === undefined ? {} : { configDir: ctx.options.configDir }),
      index: ctx.options.localIndex,
      ...(ctx.options.federationIdentity === undefined
        ? {}
        : { selfIdentity: ctx.options.federationIdentity }),
    });
```

> NOTE: confirm the exact option name for the box identity in `ServerCtx.options` (read
> `dispatchers.ts:231` — it reads `ctx.options.federationIdentity`). If federation is disabled,
> `federationIdentity` is undefined and the agents degrade to a gap note (handled in Task 9 Step 3).

- [ ] **Step 5: Run tests + typecheck + commit**

Run: `cd packages/gateway && timeout 60 bun test src/ipc/agents-rpc.test.ts && bunx tsc --noEmit`
Expected: PASS

```bash
git add packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.test.ts \
  packages/gateway/src/ipc/server/dispatchers.ts
git commit -m "feat(ipc): agents.ghost/conflicts/huddle + asker-side deps"
```

---

## Task 10: Record-on-answered hook in `federation.ask`

So a plain `nimbus team query` (the existing `federation.ask`) also fills the cache, not just the
fan-out.

**Files:**

- Modify: `packages/gateway/src/ipc/federation-rpc.ts` (the `federation.ask` handler, line ~339)
- Modify: `packages/gateway/src/ipc/federation-rpc.test.ts` (or the existing federation-rpc test)

- [ ] **Step 1: Write the failing test**

Add to the federation-rpc test (mirror the existing `federation.ask` test setup — it injects a fake
`sendFederatedOverWire` and an `index`):

```ts
it("federation.ask records the namespace in the known-namespaces cache on success", async () => {
  // ... existing harness that builds ctx with a paired peer + fake wire returning { items: [] } ...
  await dispatchFederationRpc("federation.ask", { peerId: "peer:aa", namespace: "project:zurich", purpose: "p" }, ctx);
  const rows = ctx.db.query("SELECT namespace FROM federation_known_namespaces").all();
  expect(rows).toEqual([{ namespace: "project:zurich" }]);
});
```

> NOTE: read the existing `federation.ask` test in `federation-rpc.test.ts` first and reuse its
> exact context-builder; only the assertion above is new.

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/gateway && timeout 60 bun test src/ipc/federation-rpc.test.ts`
Expected: FAIL — no cache row written.

- [ ] **Step 3: Add the record hook**

In the `"federation.ask"` handler in `federation-rpc.ts`, after a successful
`sendFederatedOverWire` that does not return an error envelope, record the namespace. The handler
currently returns the wire result directly; capture it first:

```ts
    "federation.ask": async (p) => {
      const rec = asRecord(p);
      const { row, selfIdentity } = requireAskTarget(ctx, rec);
      const namespace = requireString(rec, "namespace");
      const body: Record<string, unknown> = {
        namespace,
        purpose: requireString(rec, "purpose"),
        ...(Array.isArray(rec["types"])
          ? { types: rec["types"].filter((t): t is string => typeof t === "string") }
          : {}),
      };
      const result = await sendFederatedOverWire(
        row.host_ip as string,
        row.host_port as number,
        selfIdentity,
        row.peer_pubkey,
        "federation.query",
        body,
      );
      // Asker-side cache: a returned result means the query was answered (errors throw).
      new KnownNamespaceStore(ctx.db).record(row.peer_id, namespace, Date.now());
      return result;
    },
```

Add the import at the top of `federation-rpc.ts`:

```ts
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
```

- [ ] **Step 4: Run to verify it passes + typecheck + commit**

Run: `cd packages/gateway && timeout 60 bun test src/ipc/federation-rpc.test.ts && bunx tsc --noEmit`
Expected: PASS

```bash
git add packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/ipc/federation-rpc.test.ts
git commit -m "feat(federation): record answered namespace in the asker-side cache"
```

---

## Task 11: CLI commands + registration

**Files:**

- Create: `packages/cli/src/commands/ghost.ts`, `conflicts.ts`, `huddle.ts`
- Create: `packages/cli/src/commands/ghost.test.ts` (parse + render unit tests)
- Modify: `packages/cli/src/types/agents.ts` (CLI brief types + guards)
- Modify: `packages/cli/src/index.ts` (`COMMAND_HANDLERS`)
- Modify: `packages/cli/src/registry.ts` (`COMMAND_NAMES`)

- [ ] **Step 1: Add CLI brief types in `types/agents.ts`**

Append CLI-side mirrors (these mirror the gateway `findings.ts` shapes — the CLI cannot import
gateway internals). Add `GhostBrief`/`ConflictBrief`/`HuddleBrief` interfaces + `isGhostBrief` /
`isConflictBrief` / `isHuddleBrief` guards, identical in shape to the gateway guards from Task 3
Step 3 (copy the field checks). Example for ghost:

```ts
export interface GhostBrief {
  kind: "ghost";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  gaps: Array<{ category: string; detail: string; remediation?: string }>;
  query: { file: string };
  startEntityId: string | null;
  findings: Array<{
    peerId: string;
    expert: string | null;
    rank: "high" | "medium" | "low" | "none";
    context: Array<{ title: string; snippet: string; service: string; modifiedAt: number }>;
    suggestedContact: string;
  }>;
}

export function isGhostBrief(x: unknown): x is GhostBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return (
    b["kind"] === "ghost" &&
    b["agentVersion"] === 1 &&
    Array.isArray(b["gaps"]) &&
    Array.isArray(b["findings"]) &&
    typeof b["generatedAt"] === "number" &&
    typeof b["latencyMs"] === "number" &&
    typeof b["query"] === "object" &&
    b["query"] !== null
  );
}
```

Add the equivalent `ConflictBrief` (`collisions` array) and `HuddleBrief` (`contributions` array,
`query: { sinceMs }`) with their guards.

- [ ] **Step 2: Write the failing CLI parse/render test**

Create `packages/cli/src/commands/ghost.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { parseGhostArgs } from "./ghost.ts";

describe("parseGhostArgs", () => {
  it("parses the file positional + --json + repeatable --namespace", () => {
    const a = parseGhostArgs(["src/auth.ts", "--json", "--namespace", "ns1", "--namespace", "ns2"]);
    expect(a.file).toBe("src/auth.ts");
    expect(a.json).toBe(true);
    expect(a.namespaces).toEqual(["ns1", "ns2"]);
  });

  it("throws when no file is given", () => {
    expect(() => parseGhostArgs(["--json"])).toThrow();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/cli && timeout 60 bun test src/commands/ghost.test.ts`
Expected: FAIL — `ghost.ts` not found.

- [ ] **Step 4: Implement `commands/ghost.ts`**

Create `packages/cli/src/commands/ghost.ts` (model on `commands/impact.ts`; the brief-wait /
notification plumbing is identical except for method names and the `--namespace` flag):

```ts
import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { type GhostBrief, isGhostBrief } from "../types/agents.ts";

export type GhostCliArgs = { file: string; json: boolean; namespaces: string[] };

export function parseGhostArgs(args: string[]): GhostCliArgs {
  const positional: string[] = [];
  let json = false;
  const namespaces: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--namespace") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0) throw new Error("--namespace requires a value");
      namespaces.push(v.trim());
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) positional.push(a);
  }
  const file = positional.join(" ").trim();
  if (file.length === 0) throw new Error('Usage: nimbus ghost "<file>" [--json] [--namespace <n>]');
  return { file, json, namespaces };
}

const TIMEOUT_MS = 30_000;

function awaitGhostBrief(
  client: IPCClient,
  onTimer: (t: ReturnType<typeof setTimeout>) => void,
): Promise<{ brief: string; findings: GhostBrief }> {
  return new Promise((resolve, reject) => {
    onTimer(setTimeout(() => reject(new Error("Agent timed out after 30 s")), TIMEOUT_MS));
    client.onNotification("ghost.briefReady", (params: unknown) => {
      const p = params as { brief?: string; findings?: unknown };
      if (typeof p.brief !== "string" || !isGhostBrief(p.findings)) {
        reject(new Error("Malformed ghost.briefReady payload"));
        return;
      }
      resolve({ brief: p.brief, findings: p.findings });
    });
    client.onNotification("ghost.briefError", (params: unknown) => {
      const p = params as { error?: string };
      reject(new Error(p.error ?? "Agent failed"));
    });
  });
}

export async function runGhostCli(args: string[]): Promise<void> {
  const parsed = parseGhostArgs(args);
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  registerInteractiveCliIpcHandlers(client);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const briefPromise = awaitGhostBrief(client, (t) => {
    timeout = t;
  });
  try {
    await client.call<{ sessionId: string }>("agents.ghost", {
      file: parsed.file,
      namespaces: parsed.namespaces,
    });
    const { brief, findings } = await briefPromise;
    if (parsed.json) process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    else process.stdout.write(`${brief}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.disconnect();
  }
}
```

Create `conflicts.ts` (same shape — method `agents.conflicts`, notifications
`conflicts.briefReady`/`conflicts.briefError`, guard `isConflictBrief`, usage string mentions
`<file>`) and `huddle.ts` (positional is OPTIONAL; flags `--since <ms>` → `sinceMs` and
`--namespace`; method `agents.huddle`; notifications `huddle.briefReady`/`huddle.briefError`; guard
`isHuddleBrief`). Repeat the full command body for each — do not abbreviate; the only differences
are the method/notification strings, the param object, and arg parsing.

- [ ] **Step 5: Register the commands**

In `packages/cli/src/index.ts`, add to `COMMAND_HANDLERS` (mirror the existing `impact` entry):

```ts
  ghost: runGhostCli,
  conflicts: runConflictsCli,
  huddle: runHuddleCli,
```

with the matching imports. In `packages/cli/src/registry.ts`, add `"ghost"`, `"conflicts"`,
`"huddle"` to `COMMAND_NAMES` alongside `"impact"`.

- [ ] **Step 6: Run tests + typecheck + commit**

Run: `cd packages/cli && timeout 60 bun test src/commands/ghost.test.ts && bunx tsc --noEmit`
Expected: PASS. Also add `conflicts.test.ts` + `huddle.test.ts` with the same parse-coverage shape.

```bash
cd ../.. && git add packages/cli/src/commands/ghost.ts packages/cli/src/commands/conflicts.ts \
  packages/cli/src/commands/huddle.ts packages/cli/src/commands/*.test.ts \
  packages/cli/src/types/agents.ts packages/cli/src/index.ts packages/cli/src/registry.ts
git commit -m "feat(cli): nimbus ghost / conflicts / huddle commands"
```

---

## Task 12: Tauri allowlist (read-only briefs)

**Files:**

- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS` + `allowlist_exact_size`)
- Modify: `packages/gateway/src/security-invariants.test.ts` (JS mirror count)

- [ ] **Step 1: Read the current count**

Run: `grep -nE "agents\.|allowlist_exact_size|ALLOWED_METHODS.len" packages/ui/src-tauri/src/gateway_bridge.rs`
Note the current `assert_eq!(ALLOWED_METHODS.len(), <N>)` value; the new value is `N + 3`.

- [ ] **Step 2: Add the three methods**

In `ALLOWED_METHODS` (beside `"agents.impact"` / `"agents.catchup"`), add:

```rust
    "agents.ghost",
    "agents.conflicts",
    "agents.huddle",
```

Bump the Rust count test: `assert_eq!(ALLOWED_METHODS.len(), N + 3);`

- [ ] **Step 3: Bump the JS mirror**

In `packages/gateway/src/security-invariants.test.ts`, find the assertion that regexes
`assert_eq!(ALLOWED_METHODS.len(), <N>)` out of the Rust source and update the expected count to
`N + 3`.

- [ ] **Step 4: Verify + commit**

Run: `cd packages/gateway && timeout 60 bun test src/security-invariants.test.ts`
Expected: PASS (the JS mirror matches the Rust count).
If Rust toolchain is available: `cd packages/ui/src-tauri && cargo test allowlist_exact_size`.

```bash
cd ../../.. && git add packages/ui/src-tauri/src/gateway_bridge.rs \
  packages/gateway/src/security-invariants.test.ts
git commit -m "feat(tauri): expose read-only agents.ghost/conflicts/huddle to the renderer"
```

---

## Task 13: Documentation

**Files:**

- Modify: `docs/architecture.md` (IPC `agent.*`/`agents.*` table + schema-reference V38 row)
- Modify: `docs/cli-reference.md` (3 commands under the agents section)
- Modify: `docs/CHANGELOG.md` (slice entry)
- Modify: `docs/roadmap.md` (check ghost / conflict-detection / huddle boxes; Slice 6 status line)
- Modify: `.claude/commands/nimbus-agent-patterns.md` (add the 3 federated agents)
- Modify: `.claude/commands/nimbus-federation-identity.md` (asker-side fan-out + cache note)

- [ ] **Step 1: Update each doc**

Add `agents.ghost` / `agents.conflicts` / `agents.huddle` (+ `<kind>.briefReady` notifications) to
the IPC catalogue; document the V38 `federation_known_namespaces` table in the schema reference;
add the three CLI commands with flags to `cli-reference.md`; add a Slice 6a CHANGELOG entry dated
2026-06-11; tick the three roadmap boxes (`Cross-user conflict detection`, `Ghost reviewers`, team
huddle) and update the Slice 6 status line to note 6a delivered (6b/6c pending); add the three
agents to the agent-patterns skill table and a fan-out/cache note to the federation skill.

- [ ] **Step 2: Lint the docs**

Run: `timeout 120 bunx markdownlint-cli2 "docs/**/*.md" ".claude/commands/*.md"`
Expected: 0 errors. Auto-fix nits with `bunx markdownlint-cli2 --fix <files>`.

Run the doc audits: `bun run audit:doc-refs && bun run audit:readme-cli`
Expected: PASS (the new CLI commands are registered in `registry.ts`, satisfying `audit:readme-cli`).

- [ ] **Step 3: Commit**

```bash
git add docs/ .claude/commands/nimbus-agent-patterns.md .claude/commands/nimbus-federation-identity.md
git commit -m "docs: Slice 6a cross-colleague read-only agents"
```

---

## Task 14: Preflight + Linux-authoritative coverage floor

**Files:** none (verification only) — plus a possible `scripts/coverage-floor/exclusions.ts` +
`sonar-project.properties` parity edit and a baseline reseed.

- [ ] **Step 1: Static + fast preflight**

Run: `bun run preflight:fast`
Expected: PASS (Biome, typecheck, structure audits incl. `check-nimbus-invariants.ts` — confirm D13
still passes: `peer-fanout.ts` must NOT import `item-list-query.ts`).

- [ ] **Step 2: Scoped test sweep**

Run: `cd packages/gateway && timeout 120 bun test src/agents src/federation/peer-fanout.test.ts src/index/known-namespace-store.test.ts src/ipc/agents-rpc.test.ts src/index/migrations/runner-v38.test.ts`
Expected: PASS. Then `cd packages/cli && timeout 60 bun test src/commands/`.

- [ ] **Step 3: Docker-Linux coverage floor (authoritative)**

Use the `nimbus-coverage-floor` agent (oven/bun:latest, the hardened `reseed-docker.sh` recipe).
Every new `.ts` must clear ≥80% line + branch. If a genuine glue/runner file falls short, add it to
BOTH `scripts/coverage-floor/exclusions.ts` and `sonar-project.properties`
`sonar.coverage.exclusions` (parity trap) with justification — but prefer adding tests (the CLI
command bodies are the likeliest gap; cover the parse/render branches and the no-gateway path with
an injectable client where practical).

- [ ] **Step 4: Open the PR, then reseed the baseline from the merge lcov**

Open the PR (CI runs the merge-with-main coverage). Expect one red coverage round from incidental
sibling coverage; reseed the committed baseline from the PR's own `coverage-lcov-merged` artifact
(not local Docker), per the True Coverage convention:

```bash
gh run download <pr-run-id> -n coverage-lcov-merged
cp <downloaded>/lcov.info coverage/lcov.info
bun run audit:coverage-floor:update-baseline
```

Commit the reseeded baseline; confirm the `Unit + Coverage — ubuntu-24.04` gate goes green.

- [ ] **Step 5: Final commit**

```bash
git add coverage/ scripts/coverage-floor/exclusions.ts sonar-project.properties
git commit -m "test(coverage): reseed baseline for Slice 6a from PR merge lcov"
```

---

## Self-Review notes (for the implementer)

- **Spec coverage:** §3 (3 agents + fan-out) → Tasks 4,6,7,8,9,11; §4 (fan-out + concurrency) →
  Task 4; §5 (brief schemas) → Task 3; §6 (V38 + cache + prune) → Tasks 1,2,10; §3.4 (match token)
  → Task 5; §7 (degradation) → handler guards in Tasks 6–9; §8 (surfaces) → Tasks 9,11,12; §10
  (docs) → Task 13; §9 (tests/coverage) → every task + Task 14.
- **Verify-before-code NOTES** are flagged inline where a signature must be confirmed against the
  live codebase (`addLanPeer` shape, `graph_entity` columns, `ServerCtx.options.federationIdentity`
  name, the existing `federation.ask` test harness). Confirm each before writing the test.
- **Type consistency:** `KnownNamespaceStore` methods (`record`/`prune`/`pruneAllForPeer`/`list`/
  `listForPeer`), `PeerFanoutDeps` (`index`/`selfIdentity`/`store`/`sendOverWire?`/`now?`), and the
  brief `kind` strings (`"ghost"`/`"conflict"`/`"huddle"`) are used consistently across tasks. Note
  the conflict brief `kind` is `"conflict"` (singular) while the IPC method/CLI command is
  `conflicts` (plural) — intentional, matches the `agents.conflicts` method name.
- **D13/I17:** `peer-fanout.ts` imports only `lan-client.ts` + `types.ts` — never
  `item-list-query.ts` or `query-gate.ts` — so the static invariant audit stays green.
