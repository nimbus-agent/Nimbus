import type { Database } from "bun:sqlite";

import type { DecisionEvidence } from "./decision-types.ts";

export type ServiceMatchRoute = "repo" | "ticket-key";

/**
 * `--service` resolves through two routes, neither of which is `service → team`
 * ownership — that graph is a separate, unbuilt S1 item.
 *
 * Route 2 exists because route 1 alone silently drops PROCESS decisions.
 * "Adopt trunk-based development" has no PR and never will, and a repo-only
 * filter would exclude exactly the class of decision hardest to recover any
 * other way.
 *
 * A third route — matching a Slack channel or Notion database NAME — is not
 * buildable today and is deliberately absent: `slack-sync` persists
 * `metadata.channel` as the channel ID, and `notion-sync` / `confluence-sync`
 * persist only page IDs. Nothing human-readable exists in the index to match
 * against, so a decision living only in a chat channel is reachable by
 * `--since` but not by `--service`, and the brief says so.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

/**
 * Resolves the repository of a corroborating PR/commit from the ITEM, not from
 * a graph edge.
 *
 * There is no `pr -> repository` edge to traverse. Verified in the tree:
 * `in_repo` is emitted only for `commit -> workspace` and `file -> workspace`
 * (`graph/graph-populator.ts:342,453`), the entity type is `repo` rather than
 * `repository`, and `agents/impact.ts` — the existing precedent — resolves
 * repos by LABEL lookup (`repoIdsForRepoLabel`, `type = 'repo'`), never by
 * walking an edge from a PR.
 *
 * So read what the connector actually wrote: `github-sync.ts:201` stores
 * `external_id` as `owner/repo#123`, and `graph-populator.ts:67` reads
 * `metadata.repo` / `metadata.project`. Prefer the metadata field, fall back to
 * the external-id prefix.
 */
function repoOfItem(db: Database, itemId: string): string | null {
  const row = db.query("SELECT external_id, metadata FROM item WHERE id = ?").get(itemId) as {
    external_id: string;
    metadata: string | null;
  } | null;
  if (row === null) return null;

  if (row.metadata !== null) {
    try {
      const m: unknown = JSON.parse(row.metadata);
      if (m !== null && typeof m === "object") {
        const rec = m as { repo?: unknown; project?: unknown };
        const v = typeof rec.repo === "string" ? rec.repo : rec.project;
        if (typeof v === "string" && v.length > 0) return v;
      }
    } catch {
      // fall through to the external-id form
    }
  }

  const hash = row.external_id.indexOf("#");
  return hash > 0 ? row.external_id.slice(0, hash) : null;
}

/** `--service billing` must match `acme/billing`, so compare the last segment too. */
function repoMatches(repoFull: string, service: string): boolean {
  const want = normalize(service);
  if (normalize(repoFull) === want) return true;
  const segment = repoFull.slice(repoFull.lastIndexOf("/") + 1);
  return normalize(segment) === want;
}

function matchesRepo(
  db: Database,
  evidence: readonly DecisionEvidence[],
  service: string,
): boolean {
  const itemIds = evidence
    .filter((e) => (e.kind === "pr" || e.kind === "commit") && e.itemId !== null)
    .map((e) => e.itemId as string);
  if (itemIds.length === 0) return false;

  for (const id of itemIds) {
    const repoFull = repoOfItem(db, id);
    if (repoFull !== null && repoMatches(repoFull, service)) return true;
  }
  return false;
}

/**
 * Jira's `metadata.key`, else Linear's `metadata.identifier`. No real item
 * carries both — the two connectors write disjoint metadata — so the
 * precedence only ever settles a case that cannot occur; it is spelled out
 * rather than left to a nested ternary so it stays settled.
 */
function ticketIdentifier(m: { key?: unknown; identifier?: unknown }): string | null {
  if (typeof m.key === "string") return m.key;
  if (typeof m.identifier === "string") return m.identifier;
  return null;
}

/** Jira stores `metadata.key`, Linear `metadata.identifier`; both look like `BILLING-123`. */
function matchesTicketKey(db: Database, sourceItemId: string, service: string): boolean {
  const row = db.query("SELECT service, metadata FROM item WHERE id = ?").get(sourceItemId) as {
    service: string;
    metadata: string | null;
  } | null;
  if (row?.metadata == null) return false;
  if (row.service !== "jira" && row.service !== "linear") return false;

  let raw: unknown;
  try {
    raw = JSON.parse(row.metadata);
  } catch {
    return false;
  }
  if (raw === null || typeof raw !== "object") return false;

  const ident = ticketIdentifier(raw as { key?: unknown; identifier?: unknown });
  if (ident === null) return false;

  const prefix = ident.split("-")[0] ?? "";
  return prefix.length > 0 && normalize(prefix) === normalize(service);
}

export function matchesService(
  db: Database,
  input: {
    readonly sourceItemId: string;
    readonly evidence: readonly DecisionEvidence[];
    readonly service: string;
  },
): ServiceMatchRoute | null {
  if (matchesRepo(db, input.evidence, input.service)) return "repo";
  if (matchesTicketKey(db, input.sourceItemId, input.service)) return "ticket-key";
  return null;
}
