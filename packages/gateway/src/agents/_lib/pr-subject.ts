import type { Database } from "bun:sqlite";

import { resolveItemByUrl } from "../../index/resolve-by-url.ts";
import type { WhyChangeSubject } from "./findings.ts";

export type PrResolveMiss = {
  readonly ok: false;
  readonly reason: "not_indexed" | "ambiguous" | "not_a_pr" | "unresolvable_url";
};

export type PrResolveHit = { readonly ok: true; readonly subject: WhyChangeSubject };

/**
 * Resolve a pull-request URL to the indexed item and `pr` graph entity behind it.
 *
 * DELIBERATELY PARSE-FREE. `agents.impact` used to rebuild the identity from a
 * URL — `${service}:${owner}/${repo}#${num}` — which fails three independent
 * ways: the regex was GitHub-shaped, the service was guessed from the hostname
 * (so every self-hosted instance missed), and GitLab merge requests are keyed
 * with a BANG (`gitlabMrExternalId`), not a hash. None of that can be fixed by a
 * better pattern, because the pattern is the mistake.
 *
 * Instead: ask the index. `resolveItemByUrl` already matches every forge and
 * every self-hosted host through its canonical-url ladder, and `syncPrGraph`
 * writes the `pr` entity's `external_id` AS the item's primary key
 * (`graph-populator.ts`), so the entity is one equality join away.
 */
export function resolvePrSubject(db: Database, url: string): PrResolveHit | PrResolveMiss {
  const resolved = resolveItemByUrl(db, url);
  if (!resolved.found) {
    return { ok: false, reason: resolved.reason };
  }
  if (resolved.item.type !== "pr") {
    return { ok: false, reason: "not_a_pr" };
  }

  // `graph_entity` declares UNIQUE(type, external_id) (`graph-v7-sql.ts:9`), so
  // this can match at most one row: the LIMIT 1 is belt-and-braces, not a
  // tiebreak between candidates. The join is safe on casing for the same reason
  // the design rests on — `syncPrGraph` writes `externalId: row.id`, so both
  // sides of `i.id = e.external_id` are the same string from the same write.
  const row = db
    .query(
      `SELECT e.id                                  AS entity_id,
              e.label                               AS label,
              json_extract(e.metadata, '$.repo')    AS entity_repo,
              json_extract(i.metadata, '$.repo')    AS item_repo,
              CAST(json_extract(i.metadata, '$.number') AS INTEGER) AS number
         FROM graph_entity e
         JOIN item i ON i.id = e.external_id
        WHERE e.type = 'pr' AND e.external_id = ?
        LIMIT 1`,
    )
    .get(resolved.item.id) as {
    entity_id: string;
    label: string;
    entity_repo: string | null;
    item_repo: string | null;
    number: number | null;
  } | null;

  // An indexed `pr` item without its graph entity does not arise from ordinary
  // sync — `item-store.ts` calls `syncGraphFromIndexedItem` on the same write —
  // but reporting it as a miss is honest, where asserting it cannot happen is not.
  if (row === null) {
    return { ok: false, reason: "not_indexed" };
  }

  return {
    ok: true,
    subject: {
      itemId: resolved.item.id,
      entityId: row.entity_id,
      // `repo` is non-nullable in the SDK type but its source is not; the entity
      // label is the last resort rather than an empty string, which would read as
      // "a repo named nothing".
      repo: row.item_repo ?? row.entity_repo ?? row.label,
      number: row.number,
      // Likewise `url`: the caller's own URL is the honest fallback — it is what
      // they asked about, and it is never null.
      url: resolved.item.url ?? url,
      title: resolved.item.title,
      modifiedAt: resolved.item.modified_at,
    },
  };
}
