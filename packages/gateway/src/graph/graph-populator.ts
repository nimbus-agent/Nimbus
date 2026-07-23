import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { itemPrimaryKey } from "../index/item-key.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import { extractCommitShas, extractIssueRefs, type IssueRefs } from "./graph-refs.ts";
import {
  ensureGraphEntity,
  isItemLinkedGraphType,
  upsertGraphEntity,
  upsertGraphRelation,
} from "./relationship-graph.ts";

export type IndexedItemGraphInput = {
  id: string;
  service: string;
  type: string;
  title: string;
  bodyPreview: string | null;
  authorId: string | null;
  metadata: Record<string, unknown>;
};

/**
 * Matches `SyncContext["resolveServiceId"]` (`sync/types.ts`). Threaded down
 * to `syncTimelineEventGraph` only — every other populator branch keys off
 * `metadata.repo`/`metadata.channel`/etc, not a service-identity binding.
 */
export type ResolveServiceId = (item: {
  readonly service: string;
  readonly type: string;
  readonly metadata: Record<string, unknown>;
}) => string | undefined;

function stringField(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function stringArrayField(meta: Record<string, unknown>, key: string): string[] {
  const v = meta[key];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
    : [];
}

function repoPathFromMetadata(meta: Record<string, unknown>): string | undefined {
  return stringField(meta, "repo") ?? stringField(meta, "project");
}

/**
 * Relation types whose two endpoints come from *different* items' syncs.
 * The blanket clear below must not touch them: the entity being cleared is
 * only one endpoint, and the other side is authoritative for the edge.
 * Each emitting sync function clears its own outgoing edges of these types
 * via `clearOutgoingRelationsOfType` immediately before re-emitting them.
 */
const CROSS_ITEM_RELATION_TYPES: readonly string[] = Object.freeze([
  "resolves",
  "mentions",
  "correlates_with",
]);

function clearRelationsTouchingEntity(db: Database, entityId: string): void {
  const placeholders = CROSS_ITEM_RELATION_TYPES.map(() => "?").join(", ");
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE (from_id = ? OR to_id = ?)
        AND type NOT IN (${placeholders})`,
    [entityId, entityId, ...CROSS_ITEM_RELATION_TYPES],
  );
}

/**
 * Clear one entity's outgoing edges of a single cross-item relation type.
 * Call this from the *emitting* side before re-emitting, so a reference
 * removed from a PR body or message body disappears from the graph.
 * `clearRelationsTouchingEntity` deliberately skips these types (Task 1),
 * so this is the only thing that retires them.
 */
function clearOutgoingRelationsOfType(db: Database, fromId: string, relationType: string): void {
  dbRun(db, "DELETE FROM graph_relation WHERE from_id = ? AND type = ?", [fromId, relationType]);
}

/**
 * The mirror of `clearOutgoingRelationsOfType`, for a cross-item edge whose
 * *target* decides whether the edge still belongs: an incident that moves in
 * time or changes service must drop the correlations pointing at it, and only
 * the incident's own sync knows that.
 */
function clearIncomingRelationsOfType(db: Database, toId: string, relationType: string): void {
  dbRun(db, "DELETE FROM graph_relation WHERE to_id = ? AND type = ?", [toId, relationType]);
}

/**
 * Resolve a PR/message reference to an existing `issue` graph entity.
 * Numeric refs are scoped to the referring item's own repo and service —
 * `#4` means a different issue in a different repo. Ticket keys are
 * service-agnostic, since the tracker is usually not the forge.
 *
 * Numeric refs are matched primarily against the referenced item's own
 * `metadata.number` + `metadata.repo` (a sub-select/join against `item`,
 * since `graph_entity` itself carries no item metadata) rather than by
 * reconstructing an `externalId` string: PRs and issues share GitHub's
 * number space, so a forge-agnostic `<repo>#<n>` guess collides with the
 * `<repo>#issue-<n>` shape github-sync.ts actually indexes issues under
 * (see github-sync.ts `upsertFromIssue`/`upsertFromPullRequest`). The old
 * exact-`external_id` lookup is kept as a fallback so any item indexed
 * under that flat shape keeps resolving.
 */
function findIssueEntityIds(
  db: Database,
  service: string,
  repoFull: string | undefined,
  refs: IssueRefs,
): string[] {
  const ids: string[] = [];

  if (repoFull !== undefined) {
    for (const n of refs.numeric) {
      const metaRow = db
        .query(
          `SELECT e.id AS id
             FROM graph_entity e
             JOIN item i ON i.id = e.external_id
            WHERE e.type = 'issue'
              AND e.service = ?
              AND json_extract(i.metadata, '$.number') = ?
              AND json_extract(i.metadata, '$.repo') = ?
            LIMIT 1`,
        )
        .get(service, n, repoFull) as { id?: string } | null;
      if (metaRow?.id !== undefined) {
        ids.push(metaRow.id);
        continue;
      }

      const ext = itemPrimaryKey(service, `${repoFull}#${n}`);
      const row = db
        .query("SELECT id FROM graph_entity WHERE type = 'issue' AND external_id = ? LIMIT 1")
        .get(ext) as { id?: string } | null;
      if (row?.id !== undefined) ids.push(row.id);
    }
  }

  for (const key of refs.ticketKeys) {
    // If two different trackers both use the ticket key (e.g. two services
    // each with a "NIM-88"), `id` is a SHA-256 hash, so `ORDER BY id ASC`
    // picks a winner arbitrarily rather than by any meaningful precedence.
    //
    // The `LIKE '%:' || ?` pattern is injection-safe only because
    // `TICKET_KEY_RE` (graph-refs.ts) cannot emit `%` or `_` — its charset
    // is `[A-Z][A-Z0-9]{1,9}-\d+`. If that regex is ever loosened to allow
    // those characters, this LIKE clause would silently start producing
    // false matches.
    const row = db
      .query(
        `SELECT id FROM graph_entity
          WHERE type = 'issue' AND (external_id = ? OR external_id LIKE '%:' || ?)
          ORDER BY id ASC LIMIT 1`,
      )
      .get(key, key) as { id?: string } | null;
    if (row?.id !== undefined) ids.push(row.id);
  }

  return Array.from(new Set(ids));
}

function personDisplayName(db: Database, personId: string): string | null {
  const row = db.query("SELECT display_name FROM person WHERE id = ?").get(personId) as
    | { display_name: string | null }
    | null
    | undefined;
  const trimmed = row?.display_name?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : null;
}

function syncPrGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const repoFull = repoPathFromMetadata(row.metadata);
  const prEntityId = upsertGraphEntity(db, {
    type: "pr",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { repo: repoFull },
  });
  clearRelationsTouchingEntity(db, prEntityId);

  if (repoFull !== undefined) {
    const repoExt = `${row.service}:${repoFull}`;
    const repoId = upsertGraphEntity(db, {
      type: "repo",
      externalId: repoExt,
      label: repoFull,
      service: row.service,
    });
    upsertGraphRelation(db, prEntityId, repoId, "targets", now);
  }

  if (row.authorId !== null && row.authorId !== "") {
    const label =
      personDisplayName(db, row.authorId) ?? stringField(row.metadata, "user") ?? row.authorId;
    const personEntityId = upsertGraphEntity(db, {
      type: "person",
      externalId: row.authorId,
      label,
      service: row.service,
    });
    upsertGraphRelation(db, personEntityId, prEntityId, "authored", now);
  }

  const merged = row.metadata["merged"] === true;
  const mergeSha = stringField(row.metadata, "merge_commit_sha");
  if (merged && mergeSha !== undefined && mergeSha.length > 0) {
    const commitEntityId = upsertGraphEntity(db, {
      type: "commit",
      externalId: `${row.service}:${mergeSha}`,
      label: mergeSha.slice(0, 12),
      service: row.service,
      metadata: { sha: mergeSha },
    });
    upsertGraphRelation(db, prEntityId, commitEntityId, "merged_as", now);
  }

  clearOutgoingRelationsOfType(db, prEntityId, "resolves");
  const refs = extractIssueRefs(`${row.title}\n${row.bodyPreview ?? ""}`);
  for (const issueId of findIssueEntityIds(db, row.service, repoFull, refs)) {
    upsertGraphRelation(db, prEntityId, issueId, "resolves", now);
  }
}

function syncIssueGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const repoFull = repoPathFromMetadata(row.metadata);
  const issueEntityId = upsertGraphEntity(db, {
    type: "issue",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { repo: repoFull },
  });
  clearRelationsTouchingEntity(db, issueEntityId);

  if (repoFull !== undefined) {
    const repoExt = `${row.service}:${repoFull}`;
    const repoId = upsertGraphEntity(db, {
      type: "repo",
      externalId: repoExt,
      label: repoFull,
      service: row.service,
    });
    upsertGraphRelation(db, issueEntityId, repoId, "belongs_to", now);
  }

  if (row.authorId !== null && row.authorId !== "") {
    const label =
      personDisplayName(db, row.authorId) ?? stringField(row.metadata, "user") ?? row.authorId;
    const personEntityId = upsertGraphEntity(db, {
      type: "person",
      externalId: row.authorId,
      label,
      service: row.service,
    });
    upsertGraphRelation(db, personEntityId, issueEntityId, "opened", now);
  }
}

function syncGitCommitGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const repoRoot = stringField(row.metadata, "repoRoot");
  const sha = stringField(row.metadata, "sha");
  if (sha === undefined) {
    return;
  }
  const commitEntityId = upsertGraphEntity(db, {
    type: "commit",
    externalId: `${row.service}:${sha}`,
    label: row.title,
    service: row.service,
    metadata: { sha, repoRoot: repoRoot ?? null },
  });
  clearRelationsTouchingEntity(db, commitEntityId);
  if (repoRoot !== undefined) {
    const wsExt = `filesystem:${repoRoot}`;
    const wsId = upsertGraphEntity(db, {
      type: "workspace",
      externalId: wsExt,
      label: repoRoot,
      service: "filesystem",
    });
    upsertGraphRelation(db, commitEntityId, wsId, "in_repo", now);
  }
}

function syncDependencyGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const repoRoot = stringField(row.metadata, "repoRoot");
  const pkg = stringField(row.metadata, "packageName");
  const ver = stringField(row.metadata, "version");
  if (pkg === undefined || ver === undefined) {
    return;
  }
  const depEntityId = upsertGraphEntity(db, {
    type: "package",
    externalId: `npm:${pkg}@${ver}`,
    label: `${pkg}@${ver}`,
    service: row.service,
    metadata: { packageName: pkg, version: ver },
  });
  clearRelationsTouchingEntity(db, depEntityId);
  if (repoRoot !== undefined) {
    const wsExt = `filesystem:${repoRoot}`;
    const wsId = upsertGraphEntity(db, {
      type: "workspace",
      externalId: wsExt,
      label: repoRoot,
      service: "filesystem",
    });
    upsertGraphRelation(db, wsId, depEntityId, "depends_on", now);
  }
}

function syncApiEndpointGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const serviceName = stringField(row.metadata, "service_name") ?? "unknown";
  const apiEndpointEntityId = upsertGraphEntity(db, {
    type: "api_endpoint",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { service_name: serviceName },
  });
  clearRelationsTouchingEntity(db, apiEndpointEntityId);

  const serviceExtId = `openapi:service:${serviceName}`;
  const serviceEntityId = upsertGraphEntity(db, {
    type: "service",
    externalId: serviceExtId,
    label: serviceName,
    service: row.service,
  });
  upsertGraphRelation(db, apiEndpointEntityId, serviceEntityId, "targets", now);
}

function syncObsidianNoteGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const vaultId = stringField(row.metadata, "vault_id") ?? "unknown";
  const noteEntityId = upsertGraphEntity(db, {
    type: "obsidian_note",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { vault_id: vaultId },
  });
  clearRelationsTouchingEntity(db, noteEntityId);

  const resolved = row.metadata["resolved_wikilink_ids"];
  if (Array.isArray(resolved)) {
    for (const target of resolved) {
      if (typeof target !== "string" || target === "") {
        continue;
      }
      const tgt = db
        .query("SELECT id FROM graph_entity WHERE type = 'obsidian_note' AND external_id = ?")
        .get(target) as { id: string } | null;
      if (tgt === null) {
        continue;
      }
      upsertGraphRelation(db, noteEntityId, tgt.id, "backlinks", now);
    }
  }
}

function syncCodeSymbolGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const file = stringField(row.metadata, "file");
  const name = stringField(row.metadata, "name");
  const repoRoot = stringField(row.metadata, "repoRoot");
  if (file === undefined || name === undefined) {
    return;
  }
  const symId = upsertGraphEntity(db, {
    type: "symbol",
    externalId: row.id,
    label: `${name} — ${file}`,
    service: row.service,
    metadata: { file, name, repoRoot: repoRoot ?? null },
  });
  clearRelationsTouchingEntity(db, symId);
  if (repoRoot !== undefined) {
    const fileExt = `file:${repoRoot}:${file}`;
    const fileEntityId = upsertGraphEntity(db, {
      type: "source_file",
      externalId: fileExt,
      label: file,
      service: "filesystem",
    });
    upsertGraphRelation(db, symId, fileEntityId, "defined_in", now);
    const wsExt = `filesystem:${repoRoot}`;
    const wsId = upsertGraphEntity(db, {
      type: "workspace",
      externalId: wsExt,
      label: repoRoot,
      service: "filesystem",
    });
    upsertGraphRelation(db, fileEntityId, wsId, "in_repo", now);
  }
}

/**
 * Resolve commit SHAs to `commit` entities by their `<service>:<sha>` external id.
 *
 * The extracted string is treated as a PREFIX of the stored SHA, anchored to the
 * start of the SHA portion. This is load-bearing: commits are indexed with full
 * 40-character SHAs, but people cite them in chat as 7-character short SHAs — the
 * exact case `COMMIT_SHA_RE`'s `{7,40}` bound exists to catch. An exact-suffix
 * match (`LIKE '%:' || ?`) matches only full-length SHAs and silently emits
 * nothing for every realistic short-SHA mention.
 *
 * When a short prefix is ambiguous across services the tie-break is arbitrary,
 * the same limitation `findIssueEntityIds` carries for duplicate ticket keys.
 */
function findCommitEntityIds(db: Database, shas: readonly string[]): string[] {
  const ids: string[] = [];
  for (const sha of shas) {
    const row = db
      .query(
        `SELECT id FROM graph_entity
          WHERE type = 'commit'
            AND substr(external_id, instr(external_id, ':') + 1) LIKE ? || '%'
          ORDER BY id ASC LIMIT 1`,
      )
      .get(sha) as { id?: string } | null;
    if (row?.id !== undefined) ids.push(row.id);
  }
  return ids;
}

function syncMessageGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const msgEntityId = upsertGraphEntity(db, {
    type: "message",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: {},
  });
  clearRelationsTouchingEntity(db, msgEntityId);

  if (row.authorId !== null && row.authorId !== "") {
    const label =
      personDisplayName(db, row.authorId) ?? stringField(row.metadata, "user") ?? row.authorId;
    const personEntityId = upsertGraphEntity(db, {
      type: "person",
      externalId: row.authorId,
      label,
      service: row.service,
    });
    upsertGraphRelation(db, personEntityId, msgEntityId, "posted", now);
  }

  const channel = stringField(row.metadata, "channel");
  if (channel !== undefined) {
    const chExt = `${row.service}:${channel}`;
    const chId = upsertGraphEntity(db, {
      type: "channel",
      externalId: chExt,
      label: channel,
      service: row.service,
    });
    upsertGraphRelation(db, msgEntityId, chId, "belongs_to", now);
  }

  clearOutgoingRelationsOfType(db, msgEntityId, "mentions");
  const text = `${row.title}\n${row.bodyPreview ?? ""}`;
  const mentioned = new Set<string>([
    ...findIssueEntityIds(db, row.service, undefined, extractIssueRefs(text)),
    ...findCommitEntityIds(db, extractCommitShas(text)),
  ]);
  for (const targetId of mentioned) {
    upsertGraphRelation(db, msgEntityId, targetId, "mentions", now);
  }
}

function syncDataModelGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const key = stringField(row.metadata, "dataModelKey") ?? row.id;
  const modelId = upsertGraphEntity(db, {
    type: "data_model",
    externalId: key,
    label: row.title,
    service: row.service,
  });
  // Clear only the derived_from edges THIS handler owns (from_id = modelId).
  // Do NOT call clearRelationsTouchingEntity — the data_model node is SHARED
  // across connectors, and upstream_refs (written by syncDashboardGraph) and
  // monitors (written by syncDataQualityTestGraph) edges must not be deleted.
  dbRun(db, "DELETE FROM graph_relation WHERE from_id = ? AND type = 'derived_from'", [modelId]);
  for (const upstream of stringArrayField(row.metadata, "derivedFromKeys")) {
    const upId = ensureGraphEntity(db, {
      type: "data_model",
      externalId: upstream,
      label: upstream,
      service: null,
    });
    upsertGraphRelation(db, modelId, upId, "derived_from", now);
  }
}

function syncDashboardGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const dashId = upsertGraphEntity(db, {
    type: "dashboard",
    externalId: row.id,
    label: row.title,
    service: row.service,
  });
  clearRelationsTouchingEntity(db, dashId);
  for (const upstream of stringArrayField(row.metadata, "upstreamDataModelKeys")) {
    // Use ensureGraphEntity so a tableau/powerbi reference stub does NOT
    // overwrite the service/label of a real snowflake data_model node.
    const modelId = ensureGraphEntity(db, {
      type: "data_model",
      externalId: upstream,
      label: upstream,
      service: null,
    });
    upsertGraphRelation(db, modelId, dashId, "upstream_refs", now);
  }
}

function syncDataQualityTestGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const dqId = upsertGraphEntity(db, {
    type: "data_quality_test",
    externalId: row.id,
    label: row.title,
    service: row.service,
  });
  clearRelationsTouchingEntity(db, dqId);
  for (const table of stringArrayField(row.metadata, "monitoredDataModelKeys")) {
    // Use ensureGraphEntity so a montecarlo/bigeye reference stub does NOT
    // overwrite the service/label of a real snowflake data_model node.
    const modelId = ensureGraphEntity(db, {
      type: "data_model",
      externalId: table,
      label: table,
      service: null,
    });
    upsertGraphRelation(db, dqId, modelId, "monitors", now);
  }
}

/** An incident this long after a deploy of the same service is treated as related. */
const CORRELATION_WINDOW_MS = 2 * 60 * 60 * 1000;

type TimelineRow = { id: string; occurred_at: number };

/**
 * Counterparts within the window, ordered NEAREST-FIRST so `LIMIT 20` keeps the
 * most plausibly causal ones.
 *
 * The direction of "nearest" differs per side, which is why it is a parameter
 * rather than a constant. A deployment looks FORWARD (`[D, D+W]`), so nearest is
 * the earliest incident — `ASC`. An incident looks BACKWARD (`[I-W, I]`), so
 * nearest is the latest deployment — `DESC`. Using `ASC` for both silently keeps
 * the 20 most temporally DISTANT deploys before an incident and drops the ones
 * immediately preceding it.
 *
 * The `id` tie-break makes the ordering deterministic when two entities share a
 * timestamp; SQLite is stable in practice but does not guarantee it.
 */
function timelineCounterparts(
  db: Database,
  counterpartType: "incident" | "deployment",
  affectedService: string,
  windowFrom: number,
  windowTo: number,
  nearestFirst: "ASC" | "DESC",
): TimelineRow[] {
  const order = nearestFirst === "ASC" ? "ASC" : "DESC";
  return db
    .query(
      `SELECT id,
              CAST(json_extract(metadata, '$.occurredAt') AS INTEGER) AS occurred_at
         FROM graph_entity
        WHERE type = ?
          AND json_extract(metadata, '$.affectedService') = ?
          AND CAST(json_extract(metadata, '$.occurredAt') AS INTEGER) BETWEEN ? AND ?
        ORDER BY occurred_at ${order}, id ASC
        LIMIT 20`,
    )
    .all(counterpartType, affectedService, windowFrom, windowTo) as TimelineRow[];
}

/**
 * Incidents and deployments are timeline anchors: the graph needs them as
 * entities so a change can be correlated with what it responded to or
 * caused. `occurredAt` is the item's `modified_at`, which every connector
 * sets to the event time.
 */
function syncTimelineEventGraph(
  db: Database,
  row: IndexedItemGraphInput,
  entityType: "incident" | "deployment",
  occurredAt: number,
  now: number,
  resolveServiceId: ResolveServiceId | undefined,
): void {
  const affectedService = resolveServiceId?.(row) ?? stringField(row.metadata, "service");
  const entityId = upsertGraphEntity(db, {
    type: entityType,
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { occurredAt, affectedService: affectedService ?? null },
  });
  clearRelationsTouchingEntity(db, entityId);

  // Retire first, unconditionally. These clears MUST precede the
  // `affectedService === undefined` bail-out: an entity that previously had a
  // service (and so emitted edges) and is re-synced without one would otherwise
  // return before retiring them, leaving the graph asserting "this deploy caused
  // that incident" while the deploy itself no longer claims any service.
  //
  // The pair is load-bearing because `clearRelationsTouchingEntity` skips
  // `correlates_with` entirely. Each side owns one direction: a deployment owns
  // its outgoing edges, an incident its incoming ones, and only that entity's
  // own sync knows its current window and service.
  if (entityType === "deployment") {
    clearOutgoingRelationsOfType(db, entityId, "correlates_with");
  } else {
    clearIncomingRelationsOfType(db, entityId, "correlates_with");
  }

  // A null service correlates with nothing. Bail out only AFTER the clears.
  if (affectedService === undefined) return;

  if (entityType === "deployment") {
    for (const inc of timelineCounterparts(
      db,
      "incident",
      affectedService,
      occurredAt,
      occurredAt + CORRELATION_WINDOW_MS,
      "ASC", // forward window: nearest incident is the earliest after the deploy
    )) {
      upsertGraphRelation(db, entityId, inc.id, "correlates_with", now);
    }
    return;
  }

  // An incident syncing after its deploy must still create the edge, and the
  // edge is always directed deployment -> incident.
  for (const dep of timelineCounterparts(
    db,
    "deployment",
    affectedService,
    occurredAt - CORRELATION_WINDOW_MS,
    occurredAt,
    "DESC", // backward window: nearest deploy is the latest before the incident
  )) {
    upsertGraphRelation(db, dep.id, entityId, "correlates_with", now);
  }
}

/**
 * Read the item's event time back from the row written immediately before this
 * populator call. `upsertIndexedItem` inserts and then calls the populator
 * synchronously on the same handle, so the row is always present on the
 * production path.
 *
 * A missing row therefore means the caller reached the populator without
 * writing the item — a programming error, and the only way to get here is a
 * direct `syncGraphFromIndexedItem` call that skipped the insert (an idiom six
 * sibling test files already use for other item types). Throw rather than
 * default: the correlation task correlates deployments to incidents on this
 * timestamp, so a fabricated `Date.now()` would yield a confidently WRONG
 * correlation instead of an obvious failure.
 */
function occurredAtForItem(db: Database, itemId: string): number {
  const row = db.query("SELECT modified_at FROM item WHERE id = ?").get(itemId) as {
    modified_at: number;
  } | null;
  if (row === null) {
    throw new Error(
      `occurredAtForItem: no item row for "${itemId}" — the populator was called without ` +
        "writing the item first; the timeline entity would carry a fabricated timestamp.",
    );
  }
  return row.modified_at;
}

export function syncGraphFromIndexedItem(
  db: Database,
  row: IndexedItemGraphInput,
  resolveServiceId?: ResolveServiceId,
): void {
  if (readIndexedUserVersion(db) < 7) {
    return;
  }
  if (!isItemLinkedGraphType(row.type)) {
    return;
  }

  const now = Date.now();

  if (row.type === "pr") {
    syncPrGraph(db, row, now);
    return;
  }
  if (row.type === "issue") {
    syncIssueGraph(db, row, now);
    return;
  }
  if (row.type === "message") {
    syncMessageGraph(db, row, now);
    return;
  }
  if (row.type === "git_commit") {
    syncGitCommitGraph(db, row, now);
    return;
  }
  if (row.type === "dependency") {
    syncDependencyGraph(db, row, now);
    return;
  }
  if (row.type === "api_endpoint") {
    syncApiEndpointGraph(db, row, now);
    return;
  }
  if (row.type === "code_symbol") {
    syncCodeSymbolGraph(db, row, now);
    return;
  }
  if (row.type === "obsidian_note") {
    syncObsidianNoteGraph(db, row, now);
    return;
  }
  if (row.type === "data_model") {
    syncDataModelGraph(db, row, now);
    return;
  }
  if (row.type === "dashboard") {
    syncDashboardGraph(db, row, now);
    return;
  }
  if (row.type === "data_quality_test") {
    syncDataQualityTestGraph(db, row, now);
    return;
  }
  if (row.type === "incident") {
    syncTimelineEventGraph(
      db,
      row,
      "incident",
      occurredAtForItem(db, row.id),
      now,
      resolveServiceId,
    );
    return;
  }
  if (row.type === "deployment") {
    syncTimelineEventGraph(
      db,
      row,
      "deployment",
      occurredAtForItem(db, row.id),
      now,
      resolveServiceId,
    );
  }
}
