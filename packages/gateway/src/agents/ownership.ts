import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { AgentCoordinator, type SubTask } from "../engine/coordinator.ts";
import { resolveItemByUrl } from "../index/resolve-by-url.ts";
import {
  findDirectoryEntity,
  findFileEntity,
  findServiceEntity,
  listBoundServices,
  type OwnershipCoverage,
  type OwnershipEntity,
  ownersOf,
  readOwnershipCoverage,
  serviceForItemEntity,
  serviceForRoot,
} from "../ownership/ownership-store.ts";
import { resolveOwnershipPath } from "../ownership/ownership-target.ts";
import { emitBriefWithSynthesis } from "./_lib/emit-brief.ts";
import type { GapNote } from "./_lib/findings.ts";
import type {
  OwnershipBrief,
  OwnershipInput,
  OwnershipTargetView,
} from "./_lib/ownership-types.ts";
import { decode, subAgent } from "./_lib/sub-agent.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";

export type OwnershipContext = {
  db: Database;
  /** The COMPLETE git-aware root set, resolved by the caller via `ownershipRoots`. */
  roots: readonly string[];
  notify: (method: string, params: unknown) => void;
  sessionId: string;
  runner?: SynthesisRunner;
};

function toView(
  db: Database,
  kind: OwnershipTargetView["kind"],
  displayPath: string,
  entity: OwnershipEntity | null,
): OwnershipTargetView | null {
  if (entity === null) return null;
  return {
    kind,
    displayPath,
    owners: ownersOf(db, entity.id),
    ownerCount: entity.counts.ownerCount,
    ownersAboveFloor: entity.counts.ownersAboveFloor,
    truncated: entity.counts.truncated,
  };
}

/** The parent directory of a root-relative path, or null when the path IS the root. */
function parentDirOf(relPath: string): string | null {
  if (relPath === "") return null;
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

function displayDir(relPath: string): string {
  return relPath === "" ? "(repository root)" : relPath;
}

/**
 * Gap notes. Every conditional note is gated on the counter that proves it bit, so a
 * fully-covered, fully-bound root says nothing about coverage. Only the authorship limit
 * is unconditional — a standing disclaimer readers learn to skip is worse than none.
 */
function buildGaps(args: {
  readonly rootsConfigured: number;
  readonly coverage: OwnershipCoverage;
  readonly resolved: boolean;
  readonly requestedPath: string | null;
  readonly target: OwnershipTargetView | null;
  readonly unresolvedOwners: number;
  readonly serviceRequested: string | null;
}): GapNote[] {
  const gaps: GapNote[] = [];

  if (args.rootsConfigured === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "There are no git-aware filesystem roots configured, so no ownership can be derived.",
      remediation:
        "Add a `[[filesystem.roots]]` block with `git_aware = true`, or run `nimbus index add <path>`.",
    });
  } else if (args.serviceRequested !== null) {
    // Lane 1 prioritizes `service` over `path` — it looks up ONLY the service
    // when one is given, ignoring `path` entirely. A null target here is
    // therefore a service-lookup miss, never a path-lookup miss, even when
    // both were supplied in the same request. Attributing the gap to `path`
    // in that combined case would name the wrong culprit — the path may well
    // have ownership data; the service id is what didn't resolve.
    //
    // The zero-bound case (no service is bound to ANY repository) is reported
    // by the unconditional `servicesBound === 0` check below instead, so this
    // branch only fires when the requested id specifically doesn't match one
    // of the services that ARE bound — never both, so never double-reported.
    if (args.target === null && args.coverage.servicesBound > 0) {
      gaps.push({
        category: "missing_entity_type",
        detail:
          `\`${args.serviceRequested}\` does not name a bound service ` +
          `(${String(args.coverage.servicesBound)} service(s) are bound).`,
        remediation:
          "Run `nimbus owners` with no arguments to see the bound-service count, or check " +
          "`[ci.service.<id>]` in `nimbus.toml` for the exact ids.",
      });
    }
  } else if (args.requestedPath !== null && !args.resolved) {
    gaps.push({
      category: "missing_connector",
      detail: `\`${args.requestedPath}\` is outside every configured root (${String(args.rootsConfigured)} configured).`,
      remediation:
        "Pass a path inside a configured root, or register it with `nimbus index add <path>`.",
    });
  } else if (args.requestedPath !== null && args.target === null) {
    gaps.push({
      category: "missing_entity_type",
      detail:
        `\`${args.requestedPath}\` resolved to a configured root but has no ownership node. ` +
        "It may be excluded by `[ownership].ignore_globs`, not yet blamed, or deleted and reaped.",
      remediation: "Run `nimbus owners --refresh`, then check `[ownership].ignore_globs`.",
    });
  }

  if (args.coverage.lastPassAt === null) {
    gaps.push({
      category: "missing_connector",
      detail: "The ownership pass has not run yet.",
      remediation: "Run `nimbus owners --refresh`, or wait for the next connector sync.",
    });
  }

  if (args.coverage.filesExcluded > 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail:
        `${String(args.coverage.filesExcluded)} file(s) were excluded from aggregation by ` +
        "`[ownership].ignore_globs`. Vendored, generated and lock files otherwise inflate " +
        "whoever last ran the generator.",
    });
  }

  if (args.coverage.rootsCovered < args.coverage.rootsTotal) {
    gaps.push({
      category: "missing_connector",
      detail:
        `${String(args.coverage.rootsCovered)} of ${String(args.coverage.rootsTotal)} root(s) ` +
        "were covered by the last pass; the rest are not git repositories or hit the " +
        "per-tick blame bound. Coverage is partial, not complete.",
    });
  }

  if (args.serviceRequested !== null && args.coverage.servicesBound === 0) {
    gaps.push({
      category: "missing_relation_emit",
      detail:
        "No service is bound to a repository, so service ownership cannot be derived. " +
        "A binding needs BOTH a `[ci.service.<id>]` declaration AND a matching origin remote.",
    });
  }

  if (args.unresolvedOwners > 0) {
    gaps.push({
      category: "missing_user_identity",
      detail:
        `${String(args.unresolvedOwners)} owner(s) did not match a known person and are shown ` +
        "by git email. Their lines still count toward every share.",
    });
  }

  gaps.push({
    category: "missing_relation_emit",
    detail:
      "Blame measures who wrote lines, not who is accountable. There is no CODEOWNERS and no " +
      "on-call rotation in the index, and reviewer data (`reviewed` edges from GitHub PR " +
      "reviews) is not factored into this ranking — so this is authorship-derived ownership.",
    remediation: "Treat the ranking as a starting point for who to ask, not as an approval list.",
  });

  return gaps;
}

/**
 * An item URL resolved toward the service it rolls up to.
 *
 * A DISCRIMINATED result, not a bare `string | null`. The three ways this fails are three
 * different situations with three different remediations, and collapsing them to null
 * would leave `buildGaps` unable to say which happened — the caller would get the generic
 * coverage summary for an unindexed URL, a Confluence page and an unbound repo alike.
 */
type ItemServiceResolution =
  | { readonly ok: true; readonly service: string }
  | { readonly ok: false; readonly reason: "not_indexed" | "no_entity" | "no_service" };

function serviceForItemUrl(db: Database, itemUrl: string): ItemServiceResolution {
  const resolved = resolveItemByUrl(db, itemUrl);
  if (!resolved.found) return { ok: false, reason: "not_indexed" };
  const item = resolved.item;
  const entity = db
    .query("SELECT id FROM graph_entity WHERE external_id = ? AND type = ? LIMIT 1")
    .get(item.id, item.type) as { id?: string } | null;
  if (entity?.id === undefined) return { ok: false, reason: "no_entity" };
  const service = serviceForItemEntity(db, entity.id);
  return service === null ? { ok: false, reason: "no_service" } : { ok: true, service };
}

/** One gap per item-resolution failure, naming what is missing and what would fix it. */
function itemGapFor(itemUrl: string, reason: "not_indexed" | "no_entity" | "no_service"): GapNote {
  if (reason === "not_indexed") {
    return {
      category: "missing_entity_type",
      detail: `\`${itemUrl}\` does not resolve to an indexed item.`,
      remediation: "Sync the connector that owns it, then ask again.",
    };
  }
  if (reason === "no_entity") {
    return {
      category: "missing_entity_type",
      detail: `\`${itemUrl}\` is indexed but has no graph entity, so it rolls up to nothing.`,
      remediation:
        "Some indexed types carry no graph entity at all — a Confluence page, a CI run. Ask about the service directly instead.",
    };
  }
  return {
    category: "missing_relation_emit",
    detail: `\`${itemUrl}\` reaches no service: its repository is not bound to one.`,
    remediation:
      "A binding needs BOTH a `[ci.service.<id>]` declaration AND a matching origin remote on the repository this item belongs to.",
  };
}

export async function runOwnership(
  input: OwnershipInput,
  ctx: OwnershipContext,
  exists: (p: string) => boolean = existsSync,
): Promise<OwnershipBrief> {
  const start = performance.now();
  const now = Date.now();
  const requestedPath = input.path ?? null;
  const requestedItemUrl = input.itemUrl ?? null;

  // The item arm resolves to a SERVICE and then takes the service lane unchanged: no new
  // target kind, no second ranking path. An item-scoped answer and a service-scoped one
  // are the same answer, and routing them through one lane is what stops them drifting.
  const itemResolution =
    requestedItemUrl === null ? null : serviceForItemUrl(ctx.db, requestedItemUrl);
  const requestedService =
    input.service ?? (itemResolution?.ok === true ? itemResolution.service : null);

  const resolved =
    requestedPath === null ? null : resolveOwnershipPath(ctx.roots, requestedPath, exists);

  const coordinator = new AgentCoordinator({
    sessionId: ctx.sessionId,
    parentId: `ownership:${ctx.sessionId}`,
    depth: 1,
    toolCallCount: { value: 0 },
  });

  const tasks: SubTask[] = [
    // Lane 1 — the requested target.
    subAgent(() => {
      if (requestedService !== null) {
        return toView(
          ctx.db,
          "service",
          requestedService,
          findServiceEntity(ctx.db, requestedService),
        );
      }
      if (resolved === null) return null;
      const file = findFileEntity(ctx.db, resolved.repoRoot, resolved.relPath);
      if (file !== null) return toView(ctx.db, "source_file", resolved.relPath, file);
      const dir = findDirectoryEntity(ctx.db, resolved.repoRoot, resolved.relPath);
      return toView(ctx.db, "directory", displayDir(resolved.relPath), dir);
    }),
    // Lane 2 — the parent directory, so a one-committer file still routes somewhere.
    subAgent(() => {
      if (resolved === null) return null;
      const parent = parentDirOf(resolved.relPath);
      if (parent === null) return null;
      return toView(
        ctx.db,
        "directory",
        displayDir(parent),
        findDirectoryEntity(ctx.db, resolved.repoRoot, parent),
      );
    }),
    // Lane 3 — the service this root rolls up to.
    subAgent(() => (resolved === null ? null : { id: serviceForRoot(ctx.db, resolved.repoRoot) })),
    // Lane 4 — coverage + the bound-service list.
    subAgent(() => ({
      coverage: readOwnershipCoverage(ctx.db),
      services: listBoundServices(ctx.db),
    })),
  ];
  const results = await coordinator.run(tasks);

  const target = decode<OwnershipTargetView | null>(results[0]?.text, null);
  const parentDirectory = decode<OwnershipTargetView | null>(results[1]?.text, null);
  const svc = decode<{ id: string | null } | null>(results[2]?.text, null);
  // An all-zero literal, not `readOwnershipCoverage(ctx.db)`: that fallback argument is
  // evaluated eagerly on every call (redundant DB read on the success path), and if lane 4
  // failed because the DB is unhealthy, the fallback read would throw too.
  const lane4 = decode<{ coverage: OwnershipCoverage; services: string[] }>(results[3]?.text, {
    coverage: {
      lastPassAt: null,
      lastDurationMs: 0,
      rootsTotal: 0,
      rootsCovered: 0,
      rootsWithRemote: 0,
      filesCovered: 0,
      filesExcluded: 0,
      servicesBound: 0,
      ownersEmitted: 0,
      entitiesReaped: 0,
    },
    services: [],
  });

  const unresolvedOwners = (target?.owners ?? []).filter((o) => !o.resolved).length;

  return {
    kind: "ownership",
    agentVersion: 1,
    generatedAt: now,
    latencyMs: Math.round(performance.now() - start),
    gaps: [
      // The item-resolution gap leads, and is separate from `buildGaps`: it explains why
      // there is no service to ask about at all, which the coverage notes cannot — from
      // their point of view no service was ever requested, so they would answer an
      // unindexed URL, a page with no graph entity and an unbound repo identically.
      ...(itemResolution !== null && !itemResolution.ok && requestedItemUrl !== null
        ? [itemGapFor(requestedItemUrl, itemResolution.reason)]
        : []),
      ...buildGaps({
        rootsConfigured: ctx.roots.length,
        coverage: lane4.coverage,
        resolved: resolved !== null,
        requestedPath,
        target,
        unresolvedOwners,
        serviceRequested: requestedService,
      }),
    ],
    query: { path: requestedPath, service: requestedService, itemUrl: requestedItemUrl },
    target,
    parentDirectory,
    service: svc?.id === null || svc?.id === undefined ? null : { id: svc.id },
    coverage: lane4.coverage,
  };
}

export function emitOwnershipBrief(
  input: OwnershipInput,
  ctx: OwnershipContext,
): Promise<{ sessionId: string }> {
  return emitBriefWithSynthesis({
    sessionId: ctx.sessionId,
    briefReadyMethod: "ownership.briefReady",
    briefErrorMethod: "ownership.briefError",
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    buildBrief: () => runOwnership(input, ctx),
  });
}
