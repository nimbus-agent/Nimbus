# Phase 6 Slice 6a — Cross-colleague Intelligence (read-only) — Design

**Status:** approved (brainstorm 2026-06-11)
**Slice:** Phase 6 Slice 6 → sub-slice **6a** (the read-only ambient-intelligence layer)
**Depends on:** Slice 1 Federation Core (I17 query gate, expertise routing, over-the-wire `federation.query` / `federation.expertise`), the shipped built-in agent pattern (`catchup` / `expert` / `impact`)

---

## 1. Context & decomposition

Roadmap Slice 6 ("Cross-colleague intelligence") bundles **six independent features**: ghost
reviewers, cross-user conflict detection, cross-team cloud janitor, team huddle briefing,
tribal-knowledge extraction, and cross-team blast-radius preflight. They are not one subsystem,
so the slice is cut into three sub-slices by the substrate they reuse and the structural surface
they introduce:

- **6a — Ambient read-only intelligence (this spec):** ghost reviewers + team huddle briefing +
  cross-user conflict detection. Pure asker-side orchestration over the shipped I17 federated-query
  path. No new invariant, no new over-the-wire method.
- **6b — Federated action requests:** cross-team cloud janitor + cross-team blast-radius preflight.
  Both introduce a peer asking another peer to perform a HITL-gated action; needs a new structural
  invariant (a federated action/preflight executes only behind the *local* owner's HITL gate).
- **6c — Tribal-knowledge extraction:** ChatOps-coupled (Slice 5) + write connectors; the most
  Phase-7-adjacent feature. Scoped down or deferred.

This spec covers **6a only**. 6b and 6c get their own spec → plan → implementation cycles.

## 2. Goals & non-goals

### Goals

- Three new on-demand built-in agents, each emitting one structured brief:
  - `nimbus ghost <file>` — surface ambient teammate context for a file ("who knows this, and what
    did they do here?").
  - `nimbus conflicts <file>` — warn of work-in-progress collisions before you start editing.
  - `nimbus huddle` — a team-scoped morning briefing aggregated across paired peers.
- One shared, testable fan-out primitive over the existing federation wire methods.
- A small asker-side cache of known remote namespaces so the agents can default to an "ambient"
  sweep without forcing the user to name a namespace every time.

### Non-goals (explicit out-of-scope)

- No write/HITL action. The ghost "draft a Slack message to the expert" half of the roadmap entry
  becomes a **suggested-contact string**; the actual draft/send belongs to 6b or reuses Slice 5
  ChatOps.
- No proactive watcher push. All three agents are **on-demand** (invoked via CLI/IPC), mirroring
  `impact` / `expert` / `catchup`.
- No new over-the-wire federation method, no new live-presence/beacon protocol, no
  namespace-discovery primitive.
- No new structural invariant.

## 3. Architecture

### 3.1 Module layout

```text
packages/gateway/src/
  federation/
    peer-fanout.ts          NEW  fanOutQuery / fanOutExpertise across all paired peers
  agents/
    ghost.ts                NEW  runGhost / emitGhostBrief        -> "ghost.briefReady"
    conflicts.ts            NEW  runConflicts / emitConflictsBrief -> "conflicts.briefReady"
    huddle.ts               NEW  runHuddle / emitHuddleBrief       -> "huddle.briefReady"
    _lib/findings.ts        EDIT add GhostBrief / ConflictBrief / HuddleBrief types
  ipc/
    agents-rpc.ts           EDIT agents.ghost / .conflicts / .huddle + param validation;
                                 AgentsRpcContext gains index? / selfIdentity? / sendOverWire?
    server/dispatchers.ts   EDIT thread asker-side deps into AgentsRpcContext
    federation-rpc.ts       EDIT record-on-answered hook into the known-namespaces cache
  index/
    known-namespaces*.ts    NEW  V38 table accessors (record / prune / list)
  db/migrations/
    <V38>.ts                NEW  federation_known_namespaces table

packages/cli/src/
  commands/ghost.ts         NEW  thin IPC-call shell (impact.ts pattern)
  commands/conflicts.ts     NEW
  commands/huddle.ts        NEW
  index.ts                  EDIT register in COMMAND_HANDLERS
  registry.ts               EDIT register in COMMAND_NAMES (both files required)

packages/ui/src-tauri/src/
  gateway_bridge.rs         EDIT add 3 read-only methods to ALLOWED_METHODS (+ count test)
```

### 3.2 Data flow (all three agents, on-demand)

1. CLI `nimbus ghost <file>` → `agents.ghost` IPC method.
2. `runGhost` resolves the file to a local graph entity (the `impact.resolveStartEntity` pattern).
3. The agent runs `fanOutExpertise` (who knows it) and/or `fanOutQuery` (what they did) across all
   paired peers via the shared fan-out helper. Each answering peer enforces grant + role + consent
   through the existing `answerFederatedQuery` (I17). Unreachable / denying / timing-out peers
   degrade to gap notes.
4. Local post-filtering: recency weighting; for ghost, **suppress** any finding whose referenced
   symbol no longer exists in the local graph.
5. `emitBriefWithSynthesis` emits the structured brief via the `<kind>.briefReady` notification
   (optional LLM synthesis, exactly as `impact` does).

### 3.3 Why no new structural invariant

- Every cross-machine read still terminates at `answerFederatedQuery` (I17) on the answering side —
  unchanged. The asker-side fan-out is structurally identical to the already-shipped
  `team.auditMerged` handler (iterate `listLanPeers()`, `sendFederatedOverWire(...)`, best-effort
  skip, aggregate).
- The agents consume only the leak-proof `FederatedItem` (`id` / `service` / `type` / `title` /
  `snippet` / `modifiedAt`) and `ExpertiseRank`. They never read `metadata`. The brief types are
  constrained to exactly those fields.
- `peer-fanout.ts` does not import the local item-list query path, so the D13/I17 static audit is
  unaffected (only `query-gate.ts` may import it; the asker uses the wire).
- All three `agents.*` methods are local-only (asker-side orchestration, never answered for a peer);
  `FORBIDDEN_OVER_LAN` is unchanged.

## 4. The fan-out primitive — `federation/peer-fanout.ts`

```ts
export interface PeerFanoutDeps {
  readonly index: LocalIndex;          // listLanPeers()
  readonly selfIdentity: BoxKeypair;   // NaCl box identity
  readonly sendOverWire?: typeof sendFederatedOverWire; // DI seam; defaults to the real impl
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
  readonly perPeer: readonly T[];      // only peers that answered
  readonly gaps: readonly GapNote[];   // one per skipped peer
}

export function fanOutQuery(
  deps: PeerFanoutDeps,
  req: { namespace: string; purpose: string; types?: readonly string[] },
): Promise<PeerFanoutOutcome<PeerQueryResult>>;

export function fanOutExpertise(
  deps: PeerFanoutDeps,
  req: { query: string; purpose: string },
): Promise<PeerFanoutOutcome<PeerExpertiseResult>>;
```

Behavior (mirrors `team.auditMerged`): iterate `listLanPeers()`, skip rows with
`host_ip === null`, call `sendOverWire(... "federation.query" | "federation.expertise" ...)` inside
try/catch. A throw — unreachable peer, transport error, or a federation business error
(`no_grant` / `consent_denied` / `timeout` arrive as a thrown wire error per the over-the-wire
contract) — becomes a `GapNote`, never fatal. On a successful `federation.query` answer the helper
records `(peerId, namespace)` into the known-namespaces cache; on `no_grant` it prunes that row.

## 5. Brief schemas (added to `agents/_lib/findings.ts`)

```ts
export interface GhostFinding {
  peerId: string;
  expert: string | null;             // teammate displayName
  rank: ExpertiseRank;               // from the expertise probe
  context: Array<{ title: string; snippet: string; service: string; modifiedAt: number }>;
  suggestedContact: string;          // e.g. "Ask Alice (high relevance) — touched this 3mo ago"
}

export interface GhostBrief {
  kind: "ghost";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  query: { file: string };
  startEntityId: string | null;
  findings: GhostFinding[];
  gaps: GapNote[];
}

export interface ConflictFinding {
  peerId: string;
  who: string | null;
  service: string;
  collisionType: "open_pr" | "assigned_ticket" | "recent_commit" | "open_branch";
  title: string;
  snippet: string;
  modifiedAt: number;
}

export interface ConflictBrief {
  kind: "conflict";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  query: { file: string };
  startEntityId: string | null;
  collisions: ConflictFinding[];
  gaps: GapNote[];
}

// A leak-proof projection of FederatedItem (no metadata), reused by the huddle buckets.
export interface FederatedItemLite {
  title: string;
  snippet: string;
  service: string;
  modifiedAt: number;
}

export interface HuddleContribution {
  peerId: string;
  who: string | null;
  prs: FederatedItemLite[];
  tickets: FederatedItemLite[];
  incidents: FederatedItemLite[];
}

export interface HuddleBrief {
  kind: "huddle";
  agentVersion: 1;
  generatedAt: number;
  latencyMs: number;
  query: { sinceMs: number };
  contributions: HuddleContribution[];
  gaps: GapNote[];
}
```

Deliberate choices:

- The ghost "still exists?" suppression is a **local** graph check on the asker (a
  `resolveStartEntity`-style lookup of the referenced symbol) — no extra wire calls.
- A conflict's `collisionType` is derived from the `FederatedItem.type` / `service` already on the
  wire (e.g. `type === "pr"` with a recent `modifiedAt` → `open_pr`), never from peer metadata.

## 6. New durable state — V38

```sql
CREATE TABLE federation_known_namespaces (
  peer_id       TEXT NOT NULL,
  namespace     TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL,
  PRIMARY KEY (peer_id, namespace)
);
```

- **Population:** recorded only when a federated query to `(peerId, namespace)` is actually
  answered — never on `no_grant` / `timeout` — so the cache never holds namespaces the asker cannot
  access. Hooked into the `federation.ask` success path and the fan-out helper.
- **Self-healing:** a later `no_grant` (grant revoked at the peer) prunes that row, so a default
  fan-out stops hitting dead namespaces within one use.
- **Namespace selection:** `--namespace <name>` (repeatable) overrides; if omitted, the default
  fan-out targets every `(peerId, namespace)` row in the cache; an empty cache yields a gap note
  `"no known namespaces — pass --namespace <name>"`.

This is the slice's only schema change: one append-only table, forward-only, `CURRENT_SCHEMA_VERSION`
→ 38.

## 7. Error handling & degradation (per-peer, best-effort)

| Condition | Result |
| --- | --- |
| No paired peers | brief with a single gap note; empty findings; never throws |
| Peer unreachable / transport error | skip peer → gap note `peer <name>: unreachable` |
| Peer `no_grant` / `consent_denied` / `timeout` | skip peer → gap note; prune cache row on `no_grant` |
| Local entity unresolved (ghost / conflicts) | `startEntityId: null` + gap note; expertise still runs on the raw file string |
| Federation disabled or asker deps absent | brief with a single gap note; never throws |
| LLM absent | synthesis omitted (`emitBriefWithSynthesis` already optional-LLM) |

## 8. Surfaces

- **CLI:** `nimbus ghost <file> [--namespace <n>]`, `nimbus conflicts <file> [--namespace <n>]`,
  `nimbus huddle [--since <duration>] [--namespace <n>]` — thin IPC-call shells; registered in both
  `cli/index.ts` (`COMMAND_HANDLERS`) and `cli/registry.ts` (`COMMAND_NAMES`).
- **IPC:** `agents.ghost` / `agents.conflicts` / `agents.huddle`, each returning `{ sessionId }` and
  emitting `<kind>.briefReady` / `<kind>.briefError`. Local-only (not LAN-admitted).
- **Tauri:** three read-only methods added to `ALLOWED_METHODS` in `gateway_bridge.rs`; bump the Rust
  `allowlist_exact_size` test and the JS mirror in `security-invariants.test.ts`.
- **Schema:** V38 (`federation_known_namespaces`).
- **Config:** none new — rides `[federation]` (must be enabled for the fan-out to reach peers).

## 9. Test plan (TDD)

All `bun test <path>` runs are wrapped in `timeout 60` (bun-test-on-Windows hang guard). No
`mock.module` — dependency injection only (`peer-fanout` `sendOverWire` seam; injectable CLI client).

| Test | Proves |
| --- | --- |
| `federation/peer-fanout.test.ts` | iterates peers, skips null-host, aggregates answered peers, turns each throw into a gap note; DI `sendOverWire` fake (no real socket); records-on-answered / prunes-on-`no_grant` |
| `agents/ghost.test.ts` | entity resolve + expertise rank + context pull; suppresses a finding whose symbol no longer exists locally; recency weighting; no-peers and unresolved-entity gaps |
| `agents/conflicts.test.ts` | `collisionType` classification from `FederatedItem.type` / `service`; recency rank; empty-result gap |
| `agents/huddle.test.ts` | per-peer PR / ticket / incident bucketing; `sinceMs` window; empty-cache gap |
| `agents/_lib/findings.test.ts` (extend) | new brief type shapes |
| `ipc/agents-rpc.test.ts` (extend) | param validation (bounds), dispatch of the three methods, asker-side deps threaded |
| `index/known-namespaces.test.ts` | V38 record-on-answered, prune-on-`no_grant`, default list |
| `cli/commands/{ghost,conflicts,huddle}.test.ts` | parse → IPC call → render; no-gateway / parse-error / happy branches (injectable client; `process.exit` stubbed) |
| `security-invariants.test.ts` (extend) | Tauri allowlist count JS mirror bump |

**Coverage-floor (Linux-authoritative, `oven/bun:latest`):** every new `.ts` targets ≥80% line +
branch. CLI shells stay testable via an injectable gateway client (don't exclude). Expect the
"incidental sibling coverage" round; reseed the committed baseline from the PR's own merge lcov
artifact, not local Docker (per the True Coverage program convention). Add any genuine glue/runner
file to both `scripts/coverage-floor/exclusions.ts` and `sonar-project.properties`
`sonar.coverage.exclusions` (parity trap).

## 10. Docs (markdownlint-gated)

- `docs/architecture.md` — IPC method table + schema-reference V38 row.
- `docs/cli-reference.md` — the three new commands.
- `docs/CHANGELOG.md` — slice delivery entry.
- `docs/roadmap.md` — check the ghost / conflict-detection / huddle boxes; update the Slice 6 status
  line to note 6a delivered.
- `.claude/commands/nimbus-agent-patterns.md` — add the three federated read-only agents.
- `.claude/commands/nimbus-federation-identity.md` — note the asker-side fan-out + known-namespaces
  cache.

## 11. Risks & open questions

- **Known-namespaces cold start.** Until the user runs at least one explicit `--namespace` query per
  namespace, the default sweep is empty (gap note guides them). Acceptable for v1; a true "all
  granted" default needs the 6b namespace-discovery primitive.
- **Fan-out latency.** Sequential per-peer wire calls (as `team.auditMerged` does today) bound the
  brief latency by the slowest reachable peer × peer count. Mitigation: bounded per-peer timeout
  (reuse the lan-client `DEFAULT_TIMEOUT_MS`); consider bounded concurrency in the plan if the peer
  count is large. Document the budget; do not silently cap.
- **Consent fatigue.** A peer with interactive (non-standing) consent will be prompted per fan-out
  query. The agents should query efficiently (one query per peer per agent run, not per finding).
