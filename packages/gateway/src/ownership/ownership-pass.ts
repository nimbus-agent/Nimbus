import type { Database } from "bun:sqlite";

import type { NimbusOwnershipToml } from "../config/nimbus-toml.ts";
import { dbRun } from "../db/write.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { aggregateBlameForRoot } from "./blame-aggregate.ts";
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
  readonly totalWeight: number;
} {
  let totalWeight = 0;
  for (const w of weights.values()) totalWeight += w;
  const totalOwners = weights.size;
  if (totalWeight <= 0) return { emitted: [], totalOwners, totalWeight: 0 };

  const ranked = [...weights.entries()]
    .map(([externalId, w]) => ({ externalId, share: w / totalWeight }))
    .filter((e) => e.share >= minShare)
    .sort((a, b) =>
      b.share !== a.share ? b.share - a.share : a.externalId.localeCompare(b.externalId),
    )
    .slice(0, Math.max(0, maxOwners));

  return { emitted: ranked, totalOwners, totalWeight };
}

function fileExternalId(root: string, path: string): string {
  return `file:${root}:${path}`;
}
function dirExternalId(root: string, path: string): string {
  return `dir:${root}:${path}`;
}

/**
 * Retire this root's ownership edges in ONE statement.
 *
 * Scoping is an EXACT EQUALITY on `graph_entity.service = 'ownership:<root>'`,
 * never a `LIKE 'file:<root>:%'` prefix — a `repoRoot` containing `%` or `_`
 * would silently widen a prefix pattern across roots, retiring a NEIGHBOURING
 * root's edges while this root's pass reports success. Equality on a dedicated
 * marker column carries none of that hazard while still being a single query,
 * so there is no need to materialize a candidate id set first.
 */
function clearOwnershipEdgesForRoot(db: Database, rootMarker: string): void {
  dbRun(
    db,
    `DELETE FROM graph_relation
      WHERE type IN ('owns','contains')
        AND (from_id IN (SELECT id FROM graph_entity WHERE service = ?1)
          OR   to_id IN (SELECT id FROM graph_entity WHERE service = ?1))`,
    [rootMarker],
  );
}

/**
 * Delete this root's `source_file` / `directory` entities that now have NO
 * relations at all, in one statement. Returns the row count via `changes`.
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
  const res = dbRun(
    db,
    `DELETE FROM graph_entity
      WHERE service = ?1
        AND type IN ('source_file','directory')
        AND NOT EXISTS (SELECT 1 FROM graph_relation r WHERE r.from_id = graph_entity.id)
        AND NOT EXISTS (SELECT 1 FROM graph_relation r WHERE r.to_id   = graph_entity.id)`,
    [rootMarker],
  );
  return res.changes;
}

export async function runOwnershipPass(
  db: Database,
  opts: OwnershipPassOptions,
): Promise<OwnershipPassSummary> {
  const t0 = performance.now();
  const cfg = opts.config;
  let rootsCovered = 0;
  let rootsWithRemote = 0;
  let filesCovered = 0;
  let filesExcluded = 0;
  let ownersEmitted = 0;
  let entitiesReaped = 0;
  const servicesSeen = new Set<string>();

  // serviceId -> owner externalId -> weighted lines, accumulated across roots.
  const serviceWeights = new Map<string, Map<string, number>>();
  // Owner labels survive the per-root loop because the service rollup below
  // upserts the SAME `person` entities again, and `upsertGraphEntity` writes
  // `label = excluded.label` unconditionally. Passing the external id there
  // would overwrite a resolved display name with `git:<email>`.
  const ownerLabelsAcrossRoots = new Map<string, string>();
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
  // a transaction impossible later.
  const remoteByRoot = new Map<string, Awaited<ReturnType<typeof resolveRepoRemote>>>();
  await Promise.all(
    opts.roots.map(async (root) => {
      remoteByRoot.set(root, await resolveRepoRemote(root, opts.spawn));
    }),
  );

  for (const root of opts.roots) {
    const rootMarker = `ownership:${root}`;
    clearOwnershipEdgesForRoot(db, rootMarker);

    const agg = aggregateBlameForRoot(db, root, {
      nowMs: opts.nowMs,
      halfLifeDays: cfg.halfLifeDays,
      ignoreGlobs: cfg.ignoreGlobs,
    });
    filesCovered += agg.filesCovered;
    filesExcluded += agg.filesExcluded;
    if (agg.rows.length > 0) rootsCovered += 1;

    // file -> ownerExternalId -> weight ; and dir -> ownerExternalId -> weight
    const fileWeights = new Map<string, Map<string, number>>();
    const dirWeights = new Map<string, Map<string, number>>();
    const ownerLabels = new Map<string, string>();

    for (const r of agg.rows) {
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

    const remote = remoteByRoot.get(root) ?? null;
    let boundServiceId: string | undefined;
    if (remote !== null) {
      rootsWithRemote += 1;
      const wsId = upsertGraphEntity(db, {
        type: "workspace",
        externalId: `filesystem:${root}`,
        label: root,
        service: "filesystem",
      });
      const repoId = upsertGraphEntity(db, {
        type: "repo",
        externalId: `${remote.service}:${remote.ownerName}`,
        label: remote.ownerName,
        service: remote.service,
      });
      upsertGraphRelation(db, wsId, repoId, "tracks_remote", opts.nowMs);

      boundServiceId = urnToService.get(`${remote.service}:${remote.ownerName}`);
      if (boundServiceId !== undefined) {
        const svcId = upsertGraphEntity(db, {
          type: "service",
          externalId: `service:${boundServiceId}`,
          label: boundServiceId,
          service: "nimbus",
        });
        upsertGraphRelation(db, repoId, svcId, "belongs_to", opts.nowMs);
        servicesSeen.add(boundServiceId);
      }
    }

    const emitOwners = (targetEntityId: string, weights: Map<string, number>): void => {
      const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
      for (const e of ranked.emitted) {
        const personId = upsertGraphEntity(db, {
          type: "person",
          externalId: e.externalId,
          label: ownerLabels.get(e.externalId) ?? e.externalId,
          service: "filesystem",
        });
        upsertGraphRelation(db, personId, targetEntityId, "owns", opts.nowMs, e.share);
        ownersEmitted += 1;
      }
    };

    for (const [path, weights] of fileWeights) {
      const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
      const fileId = upsertGraphEntity(db, {
        type: "source_file",
        externalId: fileExternalId(root, path),
        label: path,
        service: rootMarker,
        metadata: {
          ownerCount: ranked.totalOwners,
          truncated: ranked.emitted.length < ranked.totalOwners,
          totalWeightedLines: ranked.totalWeight,
        },
      });
      emitOwners(fileId, weights);

      const nearest = directoryAncestors(path)[0];
      if (nearest !== undefined) {
        const dirId = upsertGraphEntity(db, {
          type: "directory",
          externalId: dirExternalId(root, nearest),
          label: nearest === "" ? root : nearest,
          service: rootMarker,
        });
        upsertGraphRelation(db, dirId, fileId, "contains", opts.nowMs);
      }
    }

    for (const [dir, weights] of dirWeights) {
      const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
      const dirId = upsertGraphEntity(db, {
        type: "directory",
        externalId: dirExternalId(root, dir),
        label: dir === "" ? root : dir,
        service: rootMarker,
        metadata: {
          ownerCount: ranked.totalOwners,
          truncated: ranked.emitted.length < ranked.totalOwners,
          totalWeightedLines: ranked.totalWeight,
        },
      });
      emitOwners(dirId, weights);

      const parents = directoryAncestors(dir);
      const parent = dir === "" ? undefined : parents[0];
      if (parent !== undefined) {
        const parentId = upsertGraphEntity(db, {
          type: "directory",
          externalId: dirExternalId(root, parent),
          label: parent === "" ? root : parent,
          service: rootMarker,
        });
        upsertGraphRelation(db, parentId, dirId, "contains", opts.nowMs);
      }
    }

    if (boundServiceId !== undefined) {
      const sw = serviceWeights.get(boundServiceId) ?? new Map<string, number>();
      // The service rollup adds the ROOT directory's weighted TOTALS, which are
      // themselves the sum of every file under the root — not an average of the
      // per-directory shares. Two repos bound to one service therefore compose
      // by volume of surviving code, as they should.
      const rootTotals = dirWeights.get("");
      if (rootTotals !== undefined) {
        for (const [owner, w] of rootTotals) sw.set(owner, (sw.get(owner) ?? 0) + w);
      }
      serviceWeights.set(boundServiceId, sw);
      for (const [owner, label] of ownerLabels) ownerLabelsAcrossRoots.set(owner, label);
    }

    entitiesReaped += reapOrphansForRoot(db, rootMarker);
  }

  for (const [serviceId, weights] of serviceWeights) {
    const svcId = upsertGraphEntity(db, {
      type: "service",
      externalId: `service:${serviceId}`,
      label: serviceId,
      service: "nimbus",
    });
    const ranked = rankOwners(weights, cfg.minShare, cfg.maxOwnersPerPath);
    for (const e of ranked.emitted) {
      const personId = upsertGraphEntity(db, {
        type: "person",
        externalId: e.externalId,
        label: ownerLabelsAcrossRoots.get(e.externalId) ?? e.externalId,
        service: "filesystem",
      });
      upsertGraphRelation(db, personId, svcId, "owns", opts.nowMs, e.share);
      ownersEmitted += 1;
    }
  }

  const summary: OwnershipPassSummary = {
    rootsTotal: opts.roots.length,
    rootsCovered,
    rootsWithRemote,
    filesCovered,
    filesExcluded,
    servicesBound: servicesSeen.size,
    ownersEmitted,
    entitiesReaped,
    durationMs: Math.round(performance.now() - t0),
  };

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
      opts.nowMs,
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

  return summary;
}
