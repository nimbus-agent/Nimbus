import type { Database } from "bun:sqlite";
import type { ResolveServiceId } from "../graph/graph-populator.ts";
import { syncGraphFromIndexedItem } from "../graph/graph-populator.ts";

type ItemRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  author_id: string | null;
  metadata: string | null;
};

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Graphs a CI-annotated deployment (Phase 10 IC2). `annotateDeployment` writes its own `item` row and
 * `deployment_items` row and never goes through `upsertIndexedItem`, so no `deployment` graph entity
 * existed until `nimbus index regraph` ran, and the deployment could not correlate with an incident, alert
 * or error. This reads the row it just wrote back and runs the same populator `upsertIndexedItem` runs.
 *
 * Called by the HTTP route and the RPC after the annotate transaction has committed, behind a seam that
 * fails soft: the annotation is the CI caller's contract and must not fail because the graph did.
 * `resolveServiceId` is optional (a malformed or absent config gives none), in which case the deployment is
 * bound through `metadata.nimbus_service_id` only if the populator's own fallback finds it, and `nimbus
 * index regraph` repairs the rest. Idempotent: a re-annotation rebuilds the same entity and edges.
 */
export function graphAnnotatedDeployment(
  db: Database,
  itemId: string,
  resolveServiceId?: ResolveServiceId,
): void {
  const row = db
    .query(
      "SELECT id, service, type, title, body_preview, author_id, metadata FROM item WHERE id = ?",
    )
    .get(itemId) as ItemRow | null;
  if (row === null) return;
  syncGraphFromIndexedItem(
    db,
    {
      id: row.id,
      service: row.service,
      type: row.type,
      title: row.title,
      bodyPreview: row.body_preview,
      authorId: row.author_id,
      metadata: parseMetadata(row.metadata),
    },
    resolveServiceId,
  );
}
