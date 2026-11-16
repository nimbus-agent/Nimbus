import type { SyncContext } from "../sync/types.ts";
import { msFromIso, normalizeLinearProjectState, TICKET_META_VERSION } from "./ticket-depth.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * Linear PROJECTS as `linear:project` items (Phase 10 PM2): the epic-shaped row `nimbus pre-mortem
 * linear:<project>` reads. Every field below was checked against Linear's published GraphQL schema
 * (`Project`, `ProjectStatus`, `ProjectConnection`, `PageInfo`, `Query.projects`); not a live account.
 *
 * Every write goes through `ctx.upsertItem` (the index-depth chokepoint) and `ctx.replaceItemSet`;
 * there is no `ctx.db` use (static D24).
 */

/** At most one project listing per interval; an ATTEMPT time in the cursor (`projAt`), success or not. */
export const PROJECTS_INTERVAL_MS = 30 * 60_000;
export const PROJECTS_PAGE_SIZE = 50;
export const PROJECTS_MAX_PAGES = 20;
/** The whole listing (all pages) stops here; a listing that stopped early deletes nothing. */
export const PROJECTS_BUDGET_MS = 45_000;

export const PROJECTS_QUERY = `
query LinearProjects($after: String) {
  projects(first: ${String(PROJECTS_PAGE_SIZE)}, after: $after, includeArchived: true) {
    nodes {
      id
      name
      description
      content
      slugId
      url
      createdAt
      updatedAt
      startedAt
      completedAt
      canceledAt
      archivedAt
      targetDate
      status {
        type
        name
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`;

export type ProjectsPage = {
  nodes: ReadonlyArray<Record<string, unknown>>;
  hasNextPage: boolean;
  endCursor: string | null;
};

/**
 * `data.projects`, or a thrown error when the shape is off. A node without a string `id` and `name`
 * fails the WHOLE page: a project we cannot key could otherwise be deleted by a "complete" listing.
 */
export function parseProjectsConnection(data: unknown): ProjectsPage {
  const conn = asRecord(asRecord(data)?.["projects"]);
  const nodes = conn?.["nodes"];
  const pageInfo = asRecord(conn?.["pageInfo"]);
  if (conn === undefined || !Array.isArray(nodes) || pageInfo === undefined) {
    throw new Error("Linear projects: unexpected response shape");
  }
  const hasNextPage = pageInfo["hasNextPage"];
  if (typeof hasNextPage !== "boolean") {
    throw new TypeError("Linear projects: pageInfo.hasNextPage is not a boolean");
  }
  const end = pageInfo["endCursor"];
  if (hasNextPage && (typeof end !== "string" || end === "")) {
    throw new TypeError("Linear projects: hasNextPage without an endCursor");
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const node of nodes) {
    const row = asRecord(node);
    const id = row === undefined ? undefined : stringField(row, "id");
    const name = row === undefined ? undefined : stringField(row, "name");
    if (row === undefined || id === undefined || id === "" || name === undefined) {
      throw new TypeError("Linear projects: a project has no id or name");
    }
    rows.push(row);
  }
  return {
    nodes: rows,
    hasNextPage,
    endCursor: typeof end === "string" && end !== "" ? end : null,
  };
}

/**
 * The project's metadata. The keys `status_category`, `created_at_ms` and `resolved_at_ms` are the
 * same names the issue and Jira writers use, so the pre-mortem cohort SQL needs no per-tracker
 * branch for them. `meta_v` is REQUIRED: the untyped `linear` rebody target would otherwise count
 * every project as pending forever. A project row carries no `project_id` and no `issue_type`.
 */
export function linearProjectMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = { meta_v: TICKET_META_VERSION };

  const id = stringField(row, "id");
  if (id !== undefined && id !== "") {
    meta["linearId"] = id;
  }
  const slug = stringField(row, "slugId");
  if (slug !== undefined && slug !== "") {
    meta["slug_id"] = slug;
  }

  const status = asRecord(row["status"]);
  const statusName = status === undefined ? undefined : stringField(status, "name");
  if (statusName !== undefined && statusName !== "") {
    meta["status"] = statusName;
  }
  const statusType = status === undefined ? undefined : stringField(status, "type");
  if (statusType !== undefined && statusType !== "") {
    meta["status_category_raw"] = statusType;
  }
  // An unrecognised or missing status is `unknown`: neither open nor closed, never in a cohort.
  meta["status_category"] = normalizeLinearProjectState(statusType);

  const created = msFromIso(stringField(row, "createdAt"));
  if (created !== undefined) {
    meta["created_at_ms"] = created;
  }
  // No `updatedAt` fallback by design: it moves on any later edit and would fabricate a closing date.
  const resolved =
    msFromIso(stringField(row, "completedAt")) ?? msFromIso(stringField(row, "canceledAt"));
  if (resolved !== undefined) {
    meta["resolved_at_ms"] = resolved;
  }
  const started = msFromIso(stringField(row, "startedAt"));
  if (started !== undefined) {
    meta["started_at_ms"] = started;
  }
  const due = msFromIso(stringField(row, "targetDate"));
  if (due !== undefined) {
    meta["due_at_ms"] = due;
  }
  return meta;
}

/** Writes one project through the chokepoint; returns its external id (the project UUID). */
export function upsertLinearProject(
  ctx: SyncContext,
  row: Record<string, unknown>,
  syncTime: number,
): string | undefined {
  const id = stringField(row, "id");
  if (id === undefined || id === "") {
    return undefined;
  }
  const name = stringField(row, "name") ?? id;
  const content = stringField(row, "content");
  const description = stringField(row, "description");
  const body = content !== undefined && content !== "" ? content : (description ?? "");
  const url = stringField(row, "url");
  const updatedAt = msFromIso(stringField(row, "updatedAt"));
  ctx.upsertItem({
    service: "linear",
    type: "project",
    externalId: id,
    title: name.length > 512 ? name.slice(0, 512) : name,
    body,
    url: url ?? null,
    canonicalUrl: url ?? null,
    modifiedAt: updatedAt ?? syncTime,
    authorId: null,
    metadata: linearProjectMetadata(row),
    pinned: false,
    syncedAt: syncTime,
  });
  return id;
}

/** One request for one page; the caller owns auth, the limiter and HTTP error mapping. */
export type FetchProjectsPage = (after: string | null, signal: AbortSignal) => Promise<unknown>;

/**
 * THE PARTIAL-LISTING RULE. Each page is parsed whole before anything of it is written; a parsed
 * page is upserted (one `writeBatch` per page) and stays even if a later page fails. A page that does
 * not parse, an error, the page cap or the time budget stops the pass with earlier pages kept and
 * NOTHING deleted. Only a COMPLETE listing (every page parsed, `hasNextPage` false within the cap)
 * replaces the set. Never throws: a project pass must not fail the issue sync.
 */
export async function runLinearProjectsPass(
  ctx: SyncContext,
  fetchPage: FetchProjectsPage,
  now: () => number = Date.now,
): Promise<{ upserted: number; complete: boolean }> {
  const startedAt = now();
  // A ref'd timer of our own (the work-snapshot pattern): the abort also cuts off a request that
  // ignores the signal, through the race below.
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), PROJECTS_BUDGET_MS);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("Linear projects: time budget")), {
      once: true,
    });
  });
  aborted.catch(() => undefined);
  const keep: string[] = [];
  let after: string | null = null;
  let complete = false;
  try {
    for (let page = 0; page < PROJECTS_MAX_PAGES; page += 1) {
      if (now() - startedAt > PROJECTS_BUDGET_MS) {
        break;
      }
      const parsed = parseProjectsConnection(
        await Promise.race([fetchPage(after, signal), aborted]),
      );
      const syncTime = now();
      ctx.writeBatch(() => {
        for (const row of parsed.nodes) {
          const id = upsertLinearProject(ctx, row, syncTime);
          if (id !== undefined) {
            keep.push(id);
          }
        }
      });
      if (!parsed.hasNextPage || parsed.endCursor === null) {
        complete = true;
        break;
      }
      after = parsed.endCursor;
    }
    if (complete) {
      ctx.replaceItemSet("project", keep);
    }
  } catch (err) {
    complete = false;
    ctx.logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Linear project listing stopped; earlier pages kept, nothing deleted",
    );
  }
  clearTimeout(timer);
  return { upserted: keep.length, complete };
}
