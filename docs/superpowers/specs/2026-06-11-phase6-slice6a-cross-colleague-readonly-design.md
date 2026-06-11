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
2. `runGhost` resolves the file to a local graph entity (the `impact.resolveStartEntity` pattern)
   and derives a **machine-portable match token** — repo-relative path / file basename / symbol
   label — never the absolute local path (see §3.4).
3. The agent runs `fanOutExpertise(token)` (who knows it — `federation.expertise` takes a free-text
   query) and `fanOutQuery({ types })` (the peer's declared typed slice — `federation.query` takes
   **no** search term, so it returns the namespace slice bounded by `limit`). Each answering peer
   enforces grant + role + consent through the existing `answerFederatedQuery` (I17). Unreachable /
   denying / timing-out peers degrade to gap notes.
4. Local post-filtering on the asker: match each returned `FederatedItem` against the token
   (basename/symbol in `title`/`snippet`) — the wire cannot filter by file, so the asker does;
   recency weighting; for ghost, **suppress** any finding whose referenced symbol no longer exists
   in the local graph; rank/order suggested contacts by expertise rank then recency (one entry per
   peer — there is no author identity on the wire to dedupe further; see §3.5).
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

### 3.4 Cross-machine entity matching

A file lives at a different absolute path on every colleague's machine
(`C:\gitrep\Nimbus\src\main.ts` vs `/Users/bob/projects/Nimbus/src/main.ts`). The agents therefore
never put an absolute path on the wire. Resolution derives a **machine-portable match token**:

- Preferred: the **symbol / entity label** already in the local graph (`graph_entity.label`, which is
  service-relative, e.g. a repo-relative path or a code-symbol name) — the same labels
  `impact.resolveStartEntity` resolves against today.
- Fallback: the **file basename** (e.g. `main.ts`) when no graph entity resolves.

The token feeds `federation.expertise` (free-text ranking) directly. For the `federation.query`
path — which returns the namespace's declared typed slice with no search term — the asker **filters
the returned `FederatedItem`s locally** by matching the token against `title` / `snippet`. This
keeps matching machine-portable and leak-proof (the asker only ever sees declared-type items it
holds a grant on). A basename collision across unrelated repos is possible; it is a precision
limitation, surfaced as lower-confidence findings, not a leak.

### 3.5 Contact ranking (no cross-peer dedupe)

The leak-proof `FederatedItem` excludes `author_id`, and `federation.expertise` returns only a
coarse `rank` — there is **no email or author identity on the wire**. Each paired peer maps to
exactly one expert (its owner, via `lan_peers.display_name`). Ghost therefore ranks/orders
suggested contacts by `(rank, recency)` and emits one entry per peer; there is no further
cross-peer identity dedupe to perform (and none is possible without leaking author identity).

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

**Concurrency & timeout (resolved):** the fan-out runs peers in **bounded parallel** (default cap 5
in-flight via a tiny local promise-pool — no such helper exists in the gateway today) rather than
sequentially, so total latency ≈ the slowest reachable peer, not the sum. Each per-peer call uses
the lan-client wire timeout (`DEFAULT_TIMEOUT_MS` = 5s). This bounds a single AFK/slow peer to one
~5s window regardless of that peer's answerer-side 30s consent wait — the asker never blocks on a
human approving an interactive-consent prompt (see §7).

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
  fan-out stops hitting dead namespaces within one use. Unpairing a peer cascade-deletes its cache
  rows (hook on `LocalIndex.removeLanPeer`). Rows key on the stable `peer_id` (derived from the peer
  pubkey), so a peer IP change re-pairs without orphaning rows. No time-based TTL is added (YAGNI:
  the table is tiny and self-heals via the `no_grant` + unpair prunes).
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

**Consent stance for ambient sweeps.** Ambient features rely on **standing consent**: a teammate
who wants to participate grants the asker standing consent on the shared namespace (already
supported — `NamespaceGrant.standingConsent`), so no per-query prompt fires. A peer with only
interactive (non-standing) consent will not answer within the asker's 5s wire timeout (its owner
must approve a prompt the asker won't wait for) and degrades to a gap note — this is intended, not a
failure: ambient sweeps must never block on or pester a human. An answerer-side "ambient / no-prompt"
query flag (decline-fast instead of prompting) is a worthwhile follow-up but is **deferred out of
6a** because it would modify the answerer's consent path; 6a changes nothing on the answering side.

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

- **Known-namespaces cold start.** A federated query requires a namespace name. v1 discovery is
  **out-of-band**, identical to today's shipped `federation.ask`: the namespace owner (who runs
  `nimbus team namespace grant <ns> <peer>`) communicates the name to the grantee; the cache then
  auto-fills on the first answered query. Until then the default sweep is empty and emits a gap note
  guiding the user to pass `--namespace`. A true "all granted" default needs a namespace-discovery
  primitive (new wire surface + a leak-surface review of advertising namespace names) — **deferred
  to 6b**.
- **Fan-out latency — resolved.** Bounded-parallel fan-out (cap 5) + 5s per-peer wire timeout, so
  latency ≈ slowest reachable peer, and a single AFK peer is capped at one window (see §4). Document
  the budget; do not silently cap the peer set.
- **Match precision.** Local basename/symbol matching can collide across unrelated repos; surfaced
  as lower-confidence findings, never a leak (§3.4).

## 12. Review dispositions (2026-06-11)

Dispositions of the design-review file (`*-readonly-design-review.md`):

- **Q1 (cold-start / namespace discovery):** deferred to 6b + v1 out-of-band path documented (§6,
  §11). Conscious scope boundary — matches the chosen asker-side-cache approach over a discovery
  wire method.
- **Q2 (interactive-consent latency):** fixed via bounded parallel + 5s wire timeout; design stance
  = ambient features rely on standing consent, interactive-consent peers degrade to a gap note (§7).
  Verified the asker already caps at 5s regardless of the answerer's 30s consent wait.
- **Q3 (cross-machine entity resolution):** fixed — a real gap. Match via machine-portable token
  (symbol label / repo-relative path / basename), never the absolute path; `federation.query` has no
  search term so the asker filters the typed slice locally (§3.4, §3.2).
- **Q4 / S2 (concurrency):** fixed — bounded-parallel pool, cap 5 (§4).
- **S1 (cache eviction):** unpair-prune fixed (§6); 30-day TTL deferred as YAGNI (stable `peer_id`
  key + self-healing prunes).
- **S3 (contact dedupe):** pushed back — no `author_id` / email on the wire and expertise returns
  only a rank, so cross-peer email dedupe is neither possible nor needed; one expert per peer, ranked
  by `(rank, recency)` (§3.5).
