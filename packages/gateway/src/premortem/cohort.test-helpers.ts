import type { Database } from "bun:sqlite";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { itemPrimaryKey } from "../index/item-key.ts";
import { upsertIndexedItem } from "../index/item-store.ts";

/**
 * Seeds a closed Jira epic that `selectCohort` can discover, mirroring the
 * REAL production write shape `affectedServicesForEpic`/`affectedServicesForEpics`
 * query — see `epic-services.test.ts`, which this helper is deliberately kept
 * in lockstep with:
 *
 * - The epic itself: `type: "issue"`, `metadata.issue_type = "Epic"`,
 *   `metadata.status_category` (defaults to `"done"`), and
 *   `metadata.resolved_at_ms` — `cohort.ts`'s SQL reads this out of `metadata`
 *   via `json_extract`, exactly as `connectors/jira-sync.ts` writes it
 *   (never a real `item` column).
 * - One child issue PER requested service, `metadata.parent_key = key`,
 *   same `service` as the epic (the epic-services join scopes children to
 *   `child.service = epic.service` so two trackers can never collide on a
 *   bare key).
 * - One `pr`-type `graph_entity` per service, minted through the REAL
 *   `upsertGraphEntity` (never a hand-rolled `INSERT INTO graph_entity`,
 *   which hid three defects in PR A) so `graph_entity.id` is the same
 *   deterministic `sha256(type + "\0" + externalId)` hash production
 *   writes. `metadata.repo` is set to the service string itself, since
 *   `selectCohort`'s "service" and `affectedServicesForEpic`'s "service"
 *   are the same value: whatever `pr.metadata.repo` holds.
 * - The `resolves` edge from the PR entity to the child's `issue` entity,
 *   through `upsertGraphRelation` — the graph stores `PR --resolves--> issue`.
 */
export function seedEpicWithServices(
  db: Database,
  opts: {
    key: string;
    services: readonly string[];
    resolvedAtMs: number;
    createdAtMs?: number;
    statusCategory?: "done" | "canceled";
  },
): void {
  const statusCategory = opts.statusCategory ?? "done";
  const metadata: Record<string, unknown> = {
    issue_type: "Epic",
    status_category: statusCategory,
    resolved_at_ms: opts.resolvedAtMs,
  };
  if (opts.createdAtMs !== undefined) {
    metadata["created_at_ms"] = opts.createdAtMs;
  }

  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: opts.key,
    title: opts.key,
    metadata,
    modifiedAt: opts.resolvedAtMs,
    syncedAt: opts.resolvedAtMs,
  });

  opts.services.forEach((service, i) => {
    const childExternalId = `${opts.key}-C${i}`;
    upsertIndexedItem(db, {
      service: "jira",
      type: "issue",
      externalId: childExternalId,
      title: childExternalId,
      metadata: { parent_key: opts.key },
      modifiedAt: opts.resolvedAtMs,
      syncedAt: opts.resolvedAtMs,
    });
    const childItemId = itemPrimaryKey("jira", childExternalId);
    const issueEnt = upsertGraphEntity(db, {
      type: "issue",
      externalId: childItemId,
      label: childItemId,
      service: "github",
      metadata: null,
    });

    const prExternalId = `pr:${opts.key}:${service}:${i}`;
    const prEnt = upsertGraphEntity(db, {
      type: "pr",
      externalId: prExternalId,
      label: prExternalId,
      service: "github",
      metadata: { repo: service },
    });

    upsertGraphRelation(db, prEnt, issueEnt, "resolves", opts.resolvedAtMs);
  });
}
