import type { Database } from "bun:sqlite";

import type { NimbusOwnershipToml } from "../config/nimbus-toml.ts";
import { dbExec, dbRun } from "../db/write.ts";
import {
  ensureGraphEntity,
  upsertGraphEntityNamespaced,
  upsertGraphRelation,
} from "../graph/relationship-graph.ts";
import { aggregateBlameForRoot, type FileAuthorWeight } from "./blame-aggregate.ts";
import { isBotAuthor, resolveOwner } from "./owner-identity.ts";
import { type RemoteSpawn, resolveRepoRemote } from "./repo-remote.ts";

export type OwnershipPassSummary = {
  readonly rootsTotal: number;
  readonly rootsCovered: number;
  readonly rootsWithRemote: number;
  readonly filesCovered: number;
  readonly filesExcluded: number;
  readonly servicesBound: number;
  readonly ownersEmitted: number;
  readonly entitiesReaped: number;
  readonly durationMs: number;
};

export type OwnershipPassOptions = {
  readonly nowMs: number;
  readonly roots: readonly string[];
  readonly config: NimbusOwnershipToml;
  readonly serviceRepoUrns: ReadonlyMap<string, readonly string[]>;
  readonly spawn?: RemoteSpawn;
};

/** Every ancestor directory of a root-relative path, nearest first, with the
 * repo root itself represented as `""`. */
export function directoryAncestors(filePath: string): string[] {
  const parts = filePath.split("/").filter((s) => s !== "");
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i -= 1) {
    out.push(parts.slice(0, i).join("/"));
  }
  out.push("");
  return out;
}

/**
 * Weighted totals → emitted shares.
 *
 * The input is a map of weighted line TOTALS, never of per-file shares, and the
 * division happens once here at the end. That ordering is the whole point of a
 * rollup: averaging a directory's per-file shares would give a 3-line file the
 * same say as a 3,000-line one, so a one-line typo fix in a stub could out-vote
 * the author of the module beside it.
 *
 * `totalOwners` is the count BEFORE thresholding and capping, so truncation is
 * reportable rather than silent. Ties break on external id ascending, which is
 * uniform because every id is TEXT — `person.id` is `TEXT PRIMARY KEY`
 * (`index/unified-item-v3-sql.ts`) and the fallback is `git:<email>`.
 */
export function rankOwners(
  weights: ReadonlyMap<string, number>,
  minShare: number,
  maxOwners: number,
): {
  readonly emitted: { externalId: string; share: number }[];
  readonly totalOwners: number;
  readonly aboveFloor: number;
  readonly totalWeight: number;
} {
  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;
  const totalOwners = weights.size;
  if (totalWeight <= 0) return { emitted: [], totalOwners, aboveFloor: 0, totalWeight: 0 };

  // `aboveFloor` is captured BETWEEN the floor and the cap, and that ordering is the
  // whole fix. Reporting `emitted.length < totalOwners` as truncation conflated two
  // unrelated facts: owners excluded by `min_share` (a policy the reader chose) and
  // owners dropped by `max_owners_per_path` (a display cap the reader did not).
  const survivors = [...weights.entries()]
    .map(([externalId, w]) => ({ externalId, share: w / totalWeight }))
    .filter((e) => e.share >= minShare)
    .sort((a, b) =>
      b.share !== a.share ? b.share - a.share : a.externalId.localeCompare(b.externalId),
    );

  return {
    emitted: survivors.slice(0, Math.max(0, maxOwners)),
    totalOwners,
    aboveFloor: survivors.length,
    totalWeight,
  };
}

/**
 * The owner-count facts recorded on every ownable entity (`source_file`, `directory`,
 * `service`).
 *
 * One constructor for all three sites on purpose. `truncated` means the CAP bound —
 * `max_owners_per_path` dropped someone who cleared the floor — and NOTHING else. Its
 * predecessor compared against `totalOwners`, so it also fired whenever `min_share`
 * excluded a contributor, which made "showing top N of M" a claim the data did not
 * support. Two call sites computed that independently and both were wrong the same way.
 */
function ownerCountsMetadata(ranked: ReturnType<typeof rankOwners>): {
  ownerCount: number;
  ownersAboveFloor: number;
  truncated: boolean;
  totalWeightedLines: number;
} {
  return {
    ownerCount: ranked.totalOwners,
    ownersAboveFloor: ranked.aboveFloor,
    truncated: ranked.emitted.length < ranked.aboveFloor,
    totalWeightedLines: ranked.totalWeight,
  };
}

function fileExternalId(root: string, path: string): string {
  return `file:${root}:${path}`;
}
function dirExternalId(root: string, path: string): string {
  return `dir:${root}:${path}`;
}

/** Temp table holding one root's in-scope `source_file` ids for the duration of
 * that root's clear/re-emit/reap cycle. See `collectFileScopeForRoot`. */
const FILE_SCOPE_TABLE = "ownership_file_scope";

/**
 * Materialize this root's `source_file` scope from OUR OWN `contains` edges.
 *
 * We cannot scope files by `graph_entity.service`. `source_file` entities are
 * SHARED with `syncCodeSymbolGraph`, which builds the byte-identical external id
 * `file:<repoRoot>:<path>` (`graph/graph-populator.ts`) — the convergence is
 * deliberate, so that ownership edges land on the same node as `defined_in` /
 * `in_repo` and a reader can walk symbol → file → owners in one traversal. But
 * `upsertGraphEntityNamespaced` — like the flat `upsertGraphEntity` it replaced
 * on this type — overwrites `service` unconditionally (only `metadata` is
 * namespaced; `label` and `service` stay last-writer-wins by decision D3), so a
 * code-symbol sync flips our marker back to `filesystem`; a `service`-scoped clear would
 * then stop matching the row and leave a `person --owns--> source_file` edge
 * standing with no blame behind it. We therefore write `service: "filesystem"`
 * on files, matching that populator exactly so neither side churns the other's
 * column, and derive file scope from `contains` edges instead — those are
 * exclusively ours, because nothing outside `ownership/` creates a `directory`
 * entity.
 *
 * Collected BEFORE any `contains` edge is deleted, because the clear destroys
 * the very set the reap needs: a file whose blame vanished has no `contains`
 * edge left by reap time and would never be recognised as a candidate.
 *
 * A TEMP TABLE rather than an `IN (?,?,…)` list: a large root can hold tens of
 * thousands of files, which would blow SQLite's bound-variable ceiling. This
 * keeps the clear and the reap as single bulk statements at any repo size.
 */
function collectFileScopeForRoot(db: Database, rootMarker: string): void {
  dbExec(db, `CREATE TEMP TABLE IF NOT EXISTS ${FILE_SCOPE_TABLE} (id TEXT PRIMARY KEY)`);
  dbRun(db, `DELETE FROM ${FILE_SCOPE_TABLE}`);
  dbRun(
    db,
    `INSERT OR IGNORE INTO ${FILE_SCOPE_TABLE} (id)
       SELECT r.to_id FROM graph_relation r
         JOIN graph_entity d ON d.id = r.from_id
         JOIN graph_entity f ON f.id = r.to_id
        WHERE r.type = 'contains'
          AND d.type = 'directory'
          AND d.service = ?1
          AND f.type = 'source_file'`,
    [rootMarker],
  );
}

/**
 * Retire this root's ownership edges.
 *
 * Directory scoping is an EXACT EQUALITY on
 * `graph_entity.service = 'ownership:<root>'`, never a `LIKE 'dir:<root>:%'`
 * prefix — a `repoRoot` containing `%` or `_` would silently widen a prefix
 * pattern across roots, retiring a NEIGHBOURING root's edges while this root's
 * pass reports success. The marker is safe on directories specifically because
 * this pass is their sole writer.
 *
 * Two statements, because the two entity classes are scoped differently. Every
 * `contains` edge and every directory `owns` edge is anchored to an in-scope
 * `directory`; file `owns` edges are anchored to the pre-collected file scope.
 */
function clearOwnershipEdgesForRoot(db: Database, rootMarker: string): void {
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE type IN ('owns','contains')
        AND (from_id IN (SELECT id FROM graph_entity WHERE type = 'directory' AND service = ?1)
          OR   to_id IN (SELECT id FROM graph_entity WHERE type = 'directory' AND service = ?1))`,
    [rootMarker],
  );
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE type = 'owns' AND to_id IN (SELECT id FROM ${FILE_SCOPE_TABLE})`,
  );
}

/**
 * Retire this root's `workspace --tracks_remote--> repo` edge.
 *
 * Scoped by the workspace's EXACT external id (`filesystem:<root>`), which this
 * pass derives from the root path itself, so a re-pointed origin retires the old
 * edge instead of accumulating beside it — a workspace that claims to track two
 * remotes at once is a wrong answer that never self-corrects, and one an
 * edge-COUNT check cannot see, because the new edge is an INSERT rather than an
 * upsert of the old row.
 *
 * `clearOwnershipEdgesForRoot` cannot reach this edge: neither endpoint is a
 * `directory` and neither is in the file scope, and the relation type is not
 * `owns`/`contains`.
 *
 * Called for EVERY root, deliberately OUTSIDE the `remote !== null` branch that
 * re-emits it: a root that loses its remote entirely (`origin` removed, git gone
 * from PATH) must have the edge retired, and that root by definition never
 * enters the branch. Scoping by relation type + the workspace id, rather than by
 * a currently-known repo, is what makes that reachable.
 *
 * The `type = 'tracks_remote'` predicate makes this exclusively ours — the type
 * is introduced by V51 and this pass is its only writer — while the external-id
 * equality keeps one root's clear off every OTHER root's edge.
 */
function clearRemoteTrackingEdgeForRoot(db: Database, root: string): void {
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE type = 'tracks_remote'
        AND from_id IN (SELECT id FROM graph_entity
                         WHERE type = 'workspace' AND external_id = ?1)`,
    [`filesystem:${root}`],
  );
}

/**
 * Retire EVERY `repo --belongs_to--> service` edge, unconditionally, once per
 * pass — the structural twin of `clearServiceOwnershipEdges` below, and it exists
 * for exactly the same reason: remove a `[ci.service.<id>]` binding and the
 * service disappears from `serviceRepoUrns`, so no per-service loop would ever
 * visit it, and the graph would keep asserting the binding forever.
 *
 * BOTH endpoint types are pinned, because `belongs_to` is NOT ours alone:
 * `graph/graph-populator.ts` emits `issue --belongs_to--> repo` and
 * `message --belongs_to--> channel`. A clear on the relation type alone would
 * destroy another populator's edges wholesale. The `repo → service` direction is
 * emitted only here, so pinning both ends makes the delete exclusively ours.
 *
 * Runs ONCE before the root loop rather than per root, because the edge is keyed
 * on the remote repo, not on the root: a root that re-points from repo A to repo
 * B leaves A's edge behind, and no root-scoped predicate can name A.
 */
function clearRepoServiceEdges(db: Database): void {
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE type = 'belongs_to'
        AND from_id IN (SELECT id FROM graph_entity WHERE type = 'repo')
        AND to_id   IN (SELECT id FROM graph_entity WHERE type = 'service')`,
  );
}

/**
 * Retire EVERY `person --owns--> service` edge, unconditionally, once per pass.
 *
 * The root-scoped clear above cannot reach these: a service-ownership edge has a
 * `person` endpoint (`service = 'filesystem'`) and a `service` endpoint
 * (`service = 'nimbus'`), so neither side carries an `ownership:<root>` marker.
 * Left alone the edge survives forever with its last computed share, and the
 * graph keeps asserting someone owns a service long after they stopped touching
 * any of its code — a wrong answer that never self-corrects, and one an
 * edge-COUNT check cannot see, because the re-emit upserts the same row.
 *
 * Wholesale clear-then-re-emit is safe because this pass is the ONLY writer of
 * this edge class, so it owns it outright — the same discipline the root-scoped
 * clear uses.
 *
 * Being UNCONDITIONAL, rather than folded into the per-service emission loop, is
 * load-bearing: it must also retire edges for a service whose config binding was
 * REMOVED, and that service is by definition absent from `serviceWeights`, so
 * the loop would never visit it. Scoping by TARGET ENTITY TYPE rather than by a
 * list of currently-known service ids is what makes that reachable.
 */
function clearServiceOwnershipEdges(db: Database): void {
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE type = 'owns'
        AND to_id IN (SELECT id FROM graph_entity WHERE type = 'service')`,
  );
}

/**
 * Delete this root's `source_file` / `directory` entities that now have NO
 * relations at all. Two statements, because the two types are scoped
 * differently (see `collectFileScopeForRoot`); returns the summed `changes`.
 *
 * The degree-0 test spans EVERY relation type, not just this pass's. A
 * `source_file` may still carry `defined_in` edges from `syncCodeSymbolGraph`,
 * which owns them — and `graph_relation` declares `ON DELETE CASCADE` on both
 * endpoints (`index/graph-v7-sql.ts`), so deleting such an entity either
 * cascades that foreign edge away (whenever `foreign_keys` is ON, as
 * `db/repair.ts` turns it) or leaves a dangling relation row that the repair
 * pass then flags. Both outcomes are another subsystem's data destroyed by a
 * pass that has no claim on it. A degree-0 entity has nothing to cascade,
 * which makes the delete inert beyond the row itself.
 *
 * `NOT EXISTS` rather than `NOT IN`: both are correct here only because
 * `from_id`/`to_id` are `TEXT NOT NULL` (`index/graph-v7-sql.ts`) — a single
 * NULL in a `NOT IN` subquery makes the whole predicate never match, silently
 * reaping nothing. `NOT EXISTS` is immune to that and uses the existing
 * `idx_graph_relation_from` / `_to` indexes.
 */
function reapOrphansForRoot(db: Database, rootMarker: string): number {
  const dirs = dbRun(
    db,
    `DELETE FROM graph_entity
      WHERE service = ?1
        AND type = 'directory'
        AND NOT EXISTS (SELECT 1 FROM graph_relation r WHERE r.from_id = graph_entity.id)
        AND NOT EXISTS (SELECT 1 FROM graph_relation r WHERE r.to_id   = graph_entity.id)`,
    [rootMarker],
  );
  // Files are scoped by the pre-collected set, not by `service` — see
  // `collectFileScopeForRoot` for why that column is unreliable for this type.
  const files = dbRun(
    db,
    `DELETE FROM graph_entity
      WHERE type = 'source_file'
        AND id IN (SELECT id FROM ${FILE_SCOPE_TABLE})
        AND NOT EXISTS (SELECT 1 FROM graph_relation r WHERE r.from_id = graph_entity.id)
        AND NOT EXISTS (SELECT 1 FROM graph_relation r WHERE r.to_id   = graph_entity.id)`,
  );
  return dirs.changes + files.changes;
}

/**
 * Fold one root's blame rows into per-file and per-directory owner weights.
 *
 * Split out of `runOwnershipPass` for cognitive complexity (Sonar S3776) — that
 * function scored 55, and this fold plus `bindRootRemote` were the two
 * self-contained regions in it. Extracting them leaves the caller as what it
 * actually is: a per-root sequence of clear → aggregate → accumulate → bind →
 * emit.
 *
 * Pure accumulation, no graph writes. `resolveOwner` reads the person table,
 * which is why `db` is still needed here.
 */
function accumulateOwnerWeights(
  db: Database,
  rows: readonly FileAuthorWeight[],
): {
  fileWeights: Map<string, Map<string, number>>;
  dirWeights: Map<string, Map<string, number>>;
  ownerLabels: Map<string, string>;
} {
  // file -> ownerExternalId -> weight ; and dir -> ownerExternalId -> weight
  const fileWeights = new Map<string, Map<string, number>>();
  const dirWeights = new Map<string, Map<string, number>>();
  const ownerLabels = new Map<string, string>();

  for (const r of rows) {
    // NOTE the argument order: `isBotAuthor(name, email)` is the REVERSE of
    // `resolveOwner(db, email, name)`. Both take two strings, so a swap here
    // would compile.
    if (isBotAuthor(r.authorName, r.authorEmail)) continue;
    const owner = resolveOwner(db, r.authorEmail, r.authorName);
    ownerLabels.set(owner.entityExternalId, owner.label);

    const fw = fileWeights.get(r.filePath) ?? new Map<string, number>();
    fw.set(owner.entityExternalId, (fw.get(owner.entityExternalId) ?? 0) + r.weightedLines);
    fileWeights.set(r.filePath, fw);

    for (const dir of directoryAncestors(r.filePath)) {
      const dw = dirWeights.get(dir) ?? new Map<string, number>();
      dw.set(owner.entityExternalId, (dw.get(owner.entityExternalId) ?? 0) + r.weightedLines);
      dirWeights.set(dir, dw);
    }
  }
  return { fileWeights, dirWeights, ownerLabels };
}

/**
 * Write the workspace → repo → service bridge for a root that has a remote, and
 * return the service id it binds to (or `undefined` when the remote maps to no
 * configured service).
 *
 * The `tracks_remote` edge is written whether or not a service match exists —
 * knowing which repo a workspace tracks is useful on its own, and is what
 * `--service` lookups traverse once a binding does appear. `servicesSeen` is
 * mutated rather than returned because the caller accumulates it across roots.
 */
function bindRootRemote(
  db: Database,
  args: {
    root: string;
    remote: { service: string; ownerName: string };
    urnToService: ReadonlyMap<string, string>;
    nowMs: number;
    servicesSeen: Set<string>;
  },
): string | undefined {
  const { root, remote, urnToService, nowMs, servicesSeen } = args;
  // Both entities are co-owned with `graph/graph-populator.ts`, which writes the same
  // `filesystem:<repoRoot>` and `<service>:<owner>/<name>` external ids from its commit,
  // dependency, code-symbol, PR and issue syncs. No ownership facts belong on either node —
  // owner counts land on `source_file`/`directory`/`service`, not on the workspace or repo —
  // so `metadata: {}` clears this writer's own "ownership" namespace and leaves siblings
  // untouched; it is not a no-op.
  const wsId = upsertGraphEntityNamespaced(db, {
    type: "workspace",
    externalId: `filesystem:${root}`,
    label: root,
    service: "filesystem",
    writer: "ownership",
    metadata: {},
  });
  const repoId = upsertGraphEntityNamespaced(db, {
    type: "repo",
    externalId: `${remote.service}:${remote.ownerName}`,
    label: remote.ownerName,
    service: remote.service,
    writer: "ownership",
    metadata: {},
  });
  upsertGraphRelation(db, wsId, repoId, "tracks_remote", nowMs);

  const boundServiceId = urnToService.get(`${remote.service}:${remote.ownerName}`);
  if (boundServiceId !== undefined) {
    // No owner-count facts to record here — those land later in `emitServiceRollup`,
    // within the same pass, for every service this write can possibly touch (see that
    // function's doc comment). `metadata: {}` clears our own "ownership" namespace to
    // `{}` and leaves siblings untouched; it does not survive as the final state.
    const svcId = upsertGraphEntityNamespaced(db, {
      type: "service",
      externalId: `service:${boundServiceId}`,
      label: boundServiceId,
      service: "nimbus",
      writer: "ownership",
      metadata: {},
    });
    upsertGraphRelation(db, repoId, svcId, "belongs_to", nowMs);
    servicesSeen.add(boundServiceId);
  }
  return boundServiceId;
}

/**
 * Everything the per-path emitters need that does not vary within one root.
 * Bundled so the emitters below take two arguments instead of seven.
 */
type EmitCtx = {
  readonly root: string;
  readonly rootMarker: string;
  readonly ownerLabels: ReadonlyMap<string, string>;
  readonly cfg: { readonly minShare: number; readonly maxOwnersPerPath: number };
  readonly nowMs: number;
};

/** `person --owns--> target` for each ranked owner. Returns how many it wrote. */
function emitOwnersFor(
  db: Database,
  targetEntityId: string,
  weights: Map<string, number>,
  ctx: EmitCtx,
): number {
  const ranked = rankOwners(weights, ctx.cfg.minShare, ctx.cfg.maxOwnersPerPath);
  for (const e of ranked.emitted) {
    // No owner-count facts recorded on the person entity itself — a person's share is
    // carried on the `owns` edge weight below, not on the node.
    const personId = upsertGraphEntityNamespaced(db, {
      type: "person",
      externalId: e.externalId,
      label: ctx.ownerLabels.get(e.externalId) ?? e.externalId,
      service: "filesystem",
      writer: "ownership",
      metadata: {},
    });
    upsertGraphRelation(db, personId, targetEntityId, "owns", ctx.nowMs, e.share);
  }
  return ranked.emitted.length;
}

/** `source_file` nodes, their owner edges, and the `contains` link from the nearest directory. */
function emitFileOwnership(
  db: Database,
  fileWeights: ReadonlyMap<string, Map<string, number>>,
  ctx: EmitCtx,
): number {
  let emitted = 0;
  for (const [path, weights] of fileWeights) {
    const ranked = rankOwners(weights, ctx.cfg.minShare, ctx.cfg.maxOwnersPerPath);
    // `service: "filesystem"` MATCHES `syncCodeSymbolGraph` exactly. We share
    // this entity with it by design (same external id, so ownership edges land
    // on the same node as `defined_in`/`in_repo` and the graph converges), and
    // an upsert overwrites `service` unconditionally — so if the two writers
    // disagreed on this value they would churn it back and forth forever.
    //
    // Owner-count metadata itself no longer collides with a code-symbol sync:
    // both writers go through `upsertGraphEntityNamespaced`, which merges into
    // its own namespace (`"ownership"` here, `"symbols"` there) and leaves the
    // other writer's namespace untouched.
    const fileId = upsertGraphEntityNamespaced(db, {
      type: "source_file",
      externalId: fileExternalId(ctx.root, path),
      label: path,
      service: "filesystem",
      writer: "ownership",
      metadata: ownerCountsMetadata(ranked),
    });
    emitted += emitOwnersFor(db, fileId, weights, ctx);

    const nearest = directoryAncestors(path)[0];
    if (nearest !== undefined) {
      // `ensureGraphEntity` (create-if-absent), NOT `upsertGraphEntity`: this
      // is a purely STRUCTURAL reference to a directory that the directory
      // emitter writes authoritatively, metadata included. An upsert here would
      // NULL that metadata, because this call site has none to pass.
      const dirId = ensureGraphEntity(db, {
        type: "directory",
        externalId: dirExternalId(ctx.root, nearest),
        label: nearest === "" ? ctx.root : nearest,
        service: ctx.rootMarker,
      });
      upsertGraphRelation(db, dirId, fileId, "contains", ctx.nowMs);
    }
  }
  return emitted;
}

/** `directory` nodes, their owner edges, and the parent `contains` skeleton. */
function emitDirectoryOwnership(
  db: Database,
  dirWeights: ReadonlyMap<string, Map<string, number>>,
  ctx: EmitCtx,
): number {
  let emitted = 0;
  for (const [dir, weights] of dirWeights) {
    const ranked = rankOwners(weights, ctx.cfg.minShare, ctx.cfg.maxOwnersPerPath);
    const dirId = upsertGraphEntityNamespaced(db, {
      type: "directory",
      externalId: dirExternalId(ctx.root, dir),
      label: dir === "" ? ctx.root : dir,
      service: ctx.rootMarker,
      writer: "ownership",
      metadata: ownerCountsMetadata(ranked),
    });
    emitted += emitOwnersFor(db, dirId, weights, ctx);

    const parent = dir === "" ? undefined : directoryAncestors(dir)[0];
    if (parent !== undefined) {
      // Structural again — create-if-absent. With two or more top-level
      // directories the repo-root node is reached from several children, and
      // an upsert here would NULL the metadata its own iteration wrote. That
      // node feeds the service rollup, so losing its metadata is not cosmetic.
      const parentId = ensureGraphEntity(db, {
        type: "directory",
        externalId: dirExternalId(ctx.root, parent),
        label: parent === "" ? ctx.root : parent,
        service: ctx.rootMarker,
      });
      upsertGraphRelation(db, parentId, dirId, "contains", ctx.nowMs);
    }
  }
  return emitted;
}

/**
 * What one root contributed. A VALUE, not a set of side effects on the caller's
 * counters — and that distinction is the whole point of this shape.
 *
 * `runOwnershipPass` used to carry eight mutable accumulators and merge into
 * them inside the loop, which is why extracting helpers never moved its
 * cognitive-complexity score much: each helper still handed results back for
 * in-place merging, so the loop body stayed a junction of everything. Making a
 * root produce a value turns the loop into a map and the accounting into a fold
 * (`foldRootOutcomes`), and neither half branches on the other's state.
 */
type RootOutcome = {
  readonly covered: boolean;
  readonly hasRemote: boolean;
  readonly boundServiceId: string | undefined;
  readonly filesCovered: number;
  readonly filesExcluded: number;
  readonly ownersEmitted: number;
  readonly entitiesReaped: number;
  /**
   * The ROOT directory's weighted totals (`dirWeights.get("")`) — the sum of
   * every file under the root, not an average of per-directory shares, so two
   * repos bound to one service compose by volume of surviving code.
   */
  readonly rootTotals: ReadonlyMap<string, number> | undefined;
  readonly ownerLabels: ReadonlyMap<string, string>;
};

/**
 * Derive and write one root's slice of the ownership graph.
 *
 * Strictly synchronous: it runs inside the `db.transaction` callback, which
 * cannot `await`. Every subprocess call (`resolveRepoRemote`) is prefetched by
 * the caller for exactly that reason.
 */
function processRoot(
  db: Database,
  root: string,
  deps: {
    readonly cfg: NimbusOwnershipToml;
    readonly nowMs: number;
    readonly remote: Awaited<ReturnType<typeof resolveRepoRemote>>;
    readonly urnToService: ReadonlyMap<string, string>;
    readonly servicesSeen: Set<string>;
  },
): RootOutcome {
  const { cfg, nowMs, remote, urnToService, servicesSeen } = deps;
  const rootMarker = `ownership:${root}`;

  // MUST precede the clear — it reads the `contains` edges the clear deletes.
  collectFileScopeForRoot(db, rootMarker);
  clearOwnershipEdgesForRoot(db, rootMarker);
  // Outside the `remote !== null` branch below, on purpose: a root that LOST
  // its remote must still have its stale `tracks_remote` edge retired.
  clearRemoteTrackingEdgeForRoot(db, root);

  const agg = aggregateBlameForRoot(db, root, {
    nowMs,
    halfLifeDays: cfg.halfLifeDays,
    ignoreGlobs: cfg.ignoreGlobs,
  });
  const { fileWeights, dirWeights, ownerLabels } = accumulateOwnerWeights(db, agg.rows);

  const boundServiceId =
    remote === null
      ? undefined
      : bindRootRemote(db, { root, remote, urnToService, nowMs, servicesSeen });

  const ctx: EmitCtx = { root, rootMarker, ownerLabels, cfg, nowMs };
  const ownersEmitted =
    emitFileOwnership(db, fileWeights, ctx) + emitDirectoryOwnership(db, dirWeights, ctx);

  return {
    covered: agg.rows.length > 0,
    hasRemote: remote !== null,
    boundServiceId,
    filesCovered: agg.filesCovered,
    filesExcluded: agg.filesExcluded,
    ownersEmitted,
    entitiesReaped: reapOrphansForRoot(db, rootMarker),
    rootTotals: dirWeights.get(""),
    ownerLabels,
  };
}

/** The cross-root accounting, folded from per-root outcomes. Pure — no `db`. */
type PassTotals = {
  rootsCovered: number;
  rootsWithRemote: number;
  filesCovered: number;
  filesExcluded: number;
  ownersEmitted: number;
  entitiesReaped: number;
  /** serviceId -> owner externalId -> weighted lines, accumulated across roots. */
  serviceWeights: Map<string, Map<string, number>>;
  /**
   * Owner labels must survive the per-root loop because the service rollup
   * upserts the SAME `person` entities again, and `upsertGraphEntityNamespaced`
   * writes `label = excluded.label` unconditionally. Passing the external id there
   * would overwrite a resolved display name with `git:<email>`.
   */
  ownerLabelsAcrossRoots: Map<string, string>;
};

function foldRootOutcomes(outcomes: readonly RootOutcome[]): PassTotals {
  const totals: PassTotals = {
    rootsCovered: 0,
    rootsWithRemote: 0,
    filesCovered: 0,
    filesExcluded: 0,
    ownersEmitted: 0,
    entitiesReaped: 0,
    serviceWeights: new Map(),
    ownerLabelsAcrossRoots: new Map(),
  };
  for (const o of outcomes) {
    if (o.covered) totals.rootsCovered += 1;
    if (o.hasRemote) totals.rootsWithRemote += 1;
    totals.filesCovered += o.filesCovered;
    totals.filesExcluded += o.filesExcluded;
    totals.ownersEmitted += o.ownersEmitted;
    totals.entitiesReaped += o.entitiesReaped;

    // Only a BOUND root contributes to the service rollup and to the surviving
    // label map — an unbound root has no service to roll up into, and its
    // labels are already written on its own file/directory edges.
    if (o.boundServiceId === undefined) continue;
    const sw = totals.serviceWeights.get(o.boundServiceId) ?? new Map<string, number>();
    if (o.rootTotals !== undefined) {
      for (const [owner, w] of o.rootTotals) sw.set(owner, (sw.get(owner) ?? 0) + w);
    }
    totals.serviceWeights.set(o.boundServiceId, sw);
    for (const [owner, label] of o.ownerLabels) totals.ownerLabelsAcrossRoots.set(owner, label);
  }
  return totals;
}

/** `person --owns--> service` for every bound service. Returns edges written. */
function emitServiceRollup(
  db: Database,
  totals: PassTotals,
  cfg: NimbusOwnershipToml,
  nowMs: number,
): number {
  let emitted = 0;
  for (const [serviceId, weights] of totals.serviceWeights) {
    // Ranked BEFORE the upsert so the same counts that drive emission also land on
    // the entity. A service's owner list is capped exactly like a file's, and until
    // now carried nothing to say so — leaving `--service`, the one lookup the whole
    // workspace -> repo -> service bridge exists to serve, unable to report its own
    // truncation.
    const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
    const svcId = upsertGraphEntityNamespaced(db, {
      type: "service",
      externalId: `service:${serviceId}`,
      label: serviceId,
      service: "nimbus",
      writer: "ownership",
      metadata: ownerCountsMetadata(ranked),
    });
    for (const e of ranked.emitted) {
      const personId = upsertGraphEntityNamespaced(db, {
        type: "person",
        externalId: e.externalId,
        label: totals.ownerLabelsAcrossRoots.get(e.externalId) ?? e.externalId,
        service: "filesystem",
        writer: "ownership",
        metadata: {},
      });
      upsertGraphRelation(db, personId, svcId, "owns", nowMs, e.share);
      emitted += 1;
    }
  }
  return emitted;
}

function persistPassState(db: Database, nowMs: number, summary: OwnershipPassSummary): void {
  dbRun(
    db,
    `INSERT INTO ownership_pass_state
       (id, last_pass_at, last_duration_ms, roots_total, roots_covered, roots_with_remote,
        files_covered, files_excluded, services_bound, owners_emitted, entities_reaped)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       last_pass_at = excluded.last_pass_at,
       last_duration_ms = excluded.last_duration_ms,
       roots_total = excluded.roots_total,
       roots_covered = excluded.roots_covered,
       roots_with_remote = excluded.roots_with_remote,
       files_covered = excluded.files_covered,
       files_excluded = excluded.files_excluded,
       services_bound = excluded.services_bound,
       owners_emitted = excluded.owners_emitted,
       entities_reaped = excluded.entities_reaped`,
    [
      nowMs,
      summary.durationMs,
      summary.rootsTotal,
      summary.rootsCovered,
      summary.rootsWithRemote,
      summary.filesCovered,
      summary.filesExcluded,
      summary.servicesBound,
      summary.ownersEmitted,
      summary.entitiesReaped,
    ],
  );
}

/**
 * Derive the ownership graph for `opts.roots` and persist the pass summary.
 *
 * `opts.roots` MUST be the COMPLETE set of git-aware roots, not a subset.
 * `clearServiceOwnershipEdges` retires every `person --owns--> service` edge and
 * `clearRepoServiceEdges` every `repo --belongs_to--> service` edge, each in one
 * statement, and only services reachable from `opts.roots` are re-emitted — so
 * calling this with a partial root set silently erases both edge classes for
 * every service the omitted roots would have bound. The wholesale clears are
 * what make a REMOVED config binding retirable at all (see those functions), so
 * this is a caller contract rather than something the pass can defend against
 * internally.
 */
export async function runOwnershipPass(
  db: Database,
  opts: OwnershipPassOptions,
): Promise<OwnershipPassSummary> {
  const t0 = performance.now();
  const cfg = opts.config;
  const servicesSeen = new Set<string>();

  // "github:owner/name" -> serviceId
  const urnToService = new Map<string, string>();
  for (const [serviceId, urns] of opts.serviceRepoUrns) {
    for (const u of urns) urnToService.set(u, serviceId);
  }

  // Resolve every root's remote UP FRONT and in parallel. Two effects, the
  // second being the real reason: it removes the serial spawn cost across
  // roots, and — more importantly — it lifts all subprocess I/O out of the
  // per-root loop, leaving that loop as uninterrupted SQLite work. Interleaving
  // `await`ed spawns with graph writes is what would make wrapping the loop in
  // a transaction impossible.
  const remoteByRoot = new Map<string, Awaited<ReturnType<typeof resolveRepoRemote>>>();
  await Promise.all(
    opts.roots.map(async (root) => {
      remoteByRoot.set(root, await resolveRepoRemote(root, opts.spawn));
    }),
  );

  // ATOMIC. Each root CLEARS destructively before re-emitting, and
  // `clearServiceOwnershipEdges` wipes every service edge before the rollup.
  // `dbRun` is a bare `db.run`, so every statement autocommits on its own — a
  // throw between a clear and its re-emit would leave the graph permanently
  // worse than before the pass ran. The remote prefetch above is deliberately
  // OUTSIDE this body: a `db.transaction` callback is synchronous and must
  // never `await`, which is the reason all subprocess I/O was hoisted there.
  const totals = db.transaction((): PassTotals => {
    // BEFORE the loop, not inside it: the edge is keyed on the remote repo, so a
    // root that re-points cannot name the repo it used to be bound to. Same
    // wholesale-clear-then-re-emit discipline as `clearServiceOwnershipEdges`,
    // and it carries the same caller contract on `opts.roots` completeness.
    clearRepoServiceEdges(db);

    const outcomes = opts.roots.map((root) =>
      processRoot(db, root, {
        cfg,
        nowMs: opts.nowMs,
        remote: remoteByRoot.get(root) ?? null,
        urnToService,
        servicesSeen,
      }),
    );
    const folded = foldRootOutcomes(outcomes);

    clearServiceOwnershipEdges(db);
    folded.ownersEmitted += emitServiceRollup(db, folded, cfg, opts.nowMs);
    return folded;
  })();

  const summary: OwnershipPassSummary = {
    rootsTotal: opts.roots.length,
    rootsCovered: totals.rootsCovered,
    rootsWithRemote: totals.rootsWithRemote,
    filesCovered: totals.filesCovered,
    filesExcluded: totals.filesExcluded,
    servicesBound: servicesSeen.size,
    ownersEmitted: totals.ownersEmitted,
    entitiesReaped: totals.entitiesReaped,
    durationMs: Math.round(performance.now() - t0),
  };

  persistPassState(db, opts.nowMs, summary);

  return summary;
}
