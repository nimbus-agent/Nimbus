import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import type { PersonSyncHints } from "../people/person-types.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { msFromIso, normalizeLinearStateType, TICKET_META_VERSION } from "./ticket-depth.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "linear";
const CURSOR_PREFIX = "nimbus-lnr1:";
const LINEAR_GQL = "https://api.linear.app/graphql";

const SYNC_QUERY = `
query LinearSync($first: Int!, $after: String, $gt: DateTimeOrDuration!) {
  issues(first: $first, after: $after, filter: { updatedAt: { gt: $gt } }, orderBy: updatedAt) {
    nodes {
      id
      identifier
      title
      description
      updatedAt
      url
      creator {
        id
        name
        email
      }
      createdAt
      completedAt
      canceledAt
      dueDate
      state {
        name
        type
      }
      parent {
        identifier
      }
      project {
        id
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

type LinearSyncCursorV1 = { since: string };

function encodeCursor(c: LinearSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): LinearSyncCursorV1 | null {
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (parsed === undefined) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const since = rec["since"];
  return typeof since === "string" && since !== "" ? { since } : null;
}

type SyncPage = {
  issues: {
    nodes: ReadonlyArray<Record<string, unknown>>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type GqlEnvelope = {
  data?: SyncPage;
  errors?: ReadonlyArray<{ message: string }>;
};

async function linearPost(
  apiKey: string,
  body: string,
): Promise<{ ok: boolean; status: number; json: GqlEnvelope | null; text: string }> {
  const res = await fetch(LINEAR_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body,
  });
  const text = await res.text();
  let json: GqlEnvelope | null = null;
  try {
    json = JSON.parse(text) as GqlEnvelope;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

function maxIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function linearRequireIssuesData(
  ctx: SyncContext,
  res: { ok: boolean; status: number; json: GqlEnvelope | null; text: string },
): SyncPage {
  if (res.status === 429) {
    ctx.rateLimiter.penalise("linear", 60_000);
    throw new Error("Linear sync: rate limited");
  }
  if (!res.ok || res.json === null) {
    throw new Error(`Linear sync HTTP ${String(res.status)}: ${res.text.slice(0, 200)}`);
  }
  const env = res.json;
  if (env.errors !== undefined && env.errors.length > 0) {
    const msg = env.errors.map((e) => e.message).join("; ");
    throw new Error(`Linear sync: ${msg.slice(0, 200)}`);
  }
  const data = env.data;
  if (data === undefined) {
    throw new Error("Linear sync: missing data");
  }
  return data;
}

function resolveLinearIssueAuthorId(
  ctx: SyncContext,
  creatorEmail: string | undefined,
  creatorId: string | undefined,
  creatorName: string | undefined,
): string | null {
  if (creatorEmail !== undefined && creatorEmail !== "") {
    const hints: PersonSyncHints = {
      canonicalEmail: creatorEmail,
      displayName: creatorName ?? creatorEmail,
    };
    if (creatorId !== undefined) {
      hints.linearMemberId = creatorId;
    }
    return resolvePersonForSync(ctx.db, hints);
  }
  if (creatorId !== undefined && creatorId !== "") {
    return resolvePersonForSync(ctx.db, {
      linearMemberId: creatorId,
      displayName: creatorName ?? creatorId,
    });
  }
  return null;
}

/**
 * Same key names as `jiraDepthMetadata` in `jira-sync.ts` — the contract is
 * shared so no consumer branches on service. `project_id` is Linear-only:
 * Linear has no Epic issue type, so a project is its epic-shaped grouping.
 * `parent_key` is independent of it and both may be present.
 */
function linearDepthMetadata(row: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = { meta_v: TICKET_META_VERSION };

  const state = asRecord(row["state"]);
  const stateName = state === undefined ? undefined : stringField(state, "name");
  if (stateName !== undefined && stateName !== "") {
    meta["status"] = stateName;
  }
  const stateType = state === undefined ? undefined : stringField(state, "type");
  if (stateType !== undefined && stateType !== "") {
    meta["status_category_raw"] = stateType;
  }
  meta["status_category"] = normalizeLinearStateType(stateType);

  const created = msFromIso(stringField(row, "createdAt"));
  if (created !== undefined) {
    meta["created_at_ms"] = created;
  }
  // A canceled issue is resolved too — it left the board. `completedAt` wins
  // when both are set; `status_category` carries which outcome it was.
  const resolved =
    msFromIso(stringField(row, "completedAt")) ?? msFromIso(stringField(row, "canceledAt"));
  if (resolved !== undefined) {
    meta["resolved_at_ms"] = resolved;
  }
  const due = msFromIso(stringField(row, "dueDate"));
  if (due !== undefined) {
    meta["due_at_ms"] = due;
  }

  const parent = asRecord(row["parent"]);
  const parentKey = parent === undefined ? undefined : stringField(parent, "identifier");
  if (parentKey !== undefined && parentKey !== "") {
    meta["parent_key"] = parentKey;
  }

  const project = asRecord(row["project"]);
  const projectId = project === undefined ? undefined : stringField(project, "id");
  if (projectId !== undefined && projectId !== "") {
    meta["project_id"] = projectId;
  }

  return meta;
}

function linearUpsertSingleIssue(
  ctx: SyncContext,
  row: Record<string, unknown>,
  syncTime: number,
  maxUpdatedIn: string,
): { count: number; maxUpdated: string } {
  const id = stringField(row, "id");
  const identifier = stringField(row, "identifier");
  if (id === undefined || identifier === undefined) {
    return { count: 0, maxUpdated: maxUpdatedIn };
  }
  const title = stringField(row, "title") ?? identifier;
  const desc = stringField(row, "description");
  const updatedAt = stringField(row, "updatedAt");
  const url = stringField(row, "url");
  const modified = updatedAt === undefined || updatedAt === "" ? syncTime : Date.parse(updatedAt);
  let maxUpdated = maxUpdatedIn;
  if (updatedAt !== undefined && updatedAt !== "") {
    maxUpdated = maxIso(maxUpdated, updatedAt);
  }
  const creator = asRecord(row["creator"]);
  const creatorId = creator === undefined ? undefined : stringField(creator, "id");
  const creatorEmail = creator === undefined ? undefined : stringField(creator, "email");
  const creatorName = creator === undefined ? undefined : stringField(creator, "name");
  const authorId = resolveLinearIssueAuthorId(ctx, creatorEmail, creatorId, creatorName);
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: "issue",
    externalId: identifier,
    title: title.length > 512 ? title.slice(0, 512) : title,
    body: desc ?? "",
    url: url ?? null,
    canonicalUrl: url ?? null,
    modifiedAt: Number.isFinite(modified) ? modified : syncTime,
    authorId,
    metadata: { linearId: id, identifier, ...linearDepthMetadata(row) },
    pinned: false,
    syncedAt: syncTime,
  });
  return { count: 1, maxUpdated };
}

function linearUpsertIssueNodes(
  ctx: SyncContext,
  nodes: ReadonlyArray<Record<string, unknown>>,
  maxUpdatedIn: string,
): { count: number; maxUpdated: string } {
  let count = 0;
  let maxUpdated = maxUpdatedIn;
  const syncTime = Date.now();
  for (const node of nodes) {
    const row = asRecord(node);
    if (row === undefined) {
      continue;
    }
    const r = linearUpsertSingleIssue(ctx, row, syncTime, maxUpdated);
    count += r.count;
    maxUpdated = r.maxUpdated;
  }
  return { count, maxUpdated };
}

export type LinearSyncableOptions = {
  ensureLinearMcpRunning: () => Promise<void>;
};

export function createLinearSyncable(options: LinearSyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 60 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureLinearMcpRunning();
      const apiKey = await readConnectorSecret(ctx.vault, "linear", "api_key");
      if (apiKey === null || apiKey === "") {
        return syncNoopResult(cursor, t0);
      }

      const prev = decodeCursor(cursor);
      const now = Date.now();
      const floorMs = now - initialSyncDepthDays * 86_400_000;
      const sinceGt = prev?.since ?? new Date(floorMs).toISOString();

      await ctx.rateLimiter.acquire("linear");

      let pageAfter: string | null = null;
      let upserted = 0;
      let bytesTransferred = 0;
      let maxUpdated = prev?.since ?? sinceGt;

      for (;;) {
        const variables: Record<string, unknown> = {
          first: 50,
          gt: sinceGt,
        };
        if (pageAfter !== null) {
          variables["after"] = pageAfter;
        }
        const payload = JSON.stringify({
          query: SYNC_QUERY,
          variables,
        });
        const res = await linearPost(apiKey, payload);
        bytesTransferred += res.text.length;

        const data = linearRequireIssuesData(ctx, res);
        const { nodes, pageInfo } = data.issues;
        const batch = linearUpsertIssueNodes(ctx, nodes, maxUpdated);
        upserted += batch.count;
        maxUpdated = batch.maxUpdated;

        if (pageInfo.hasNextPage && pageInfo.endCursor !== null && pageInfo.endCursor !== "") {
          pageAfter = pageInfo.endCursor;
          continue;
        }
        break;
      }

      const nextCursor = encodeCursor({ since: maxUpdated });

      return {
        cursor: nextCursor,
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred,
      };
    },
  };
}
