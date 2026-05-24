/**
 * Wiz cloud-security-platform GraphQL sync handler. Runs an
 * `Issues` GraphQL query at `WIZ_API_URL` (default
 * `https://api.app.wiz.io/graphql`) and upserts each open issue into
 * the unified `item` table as `service = "wiz", type = "issue"` via
 * {@link mapWizIssueToItem}.
 *
 * Auth: Wiz uses OAuth client_credentials. Each sync cycle fetches a
 * fresh access token from `WIZ_AUTH_URL` (default
 * `https://auth.app.wiz.io/oauth/token`) using `wiz.client_id` +
 * `wiz.client_secret` from the vault. Tokens live ~24 h; the
 * per-cycle fetch is wasteful (one extra round-trip every 10 min) but
 * keeps the code simple — no token caching across syncs, no expiry
 * tracking.
 *
 * Single-pass cursor model (matches snyk/sonarqube/semgrep): every
 * successful run emits a fresh `nimbus-wiz1:{pass: 1}` cursor. Wiz's
 * GraphQL endpoint exposes `pageInfo.endCursor` for forward pagination
 * within a single cycle; we cap pages per cycle to bound cost.
 */

import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { mapWizIssueToItem } from "./wiz-issue-mapping.ts";

const SERVICE_ID = "wiz";
const CURSOR_PREFIX = "nimbus-wiz1:";
const DEFAULT_API = "https://api.app.wiz.io/graphql";
const DEFAULT_AUTH = "https://auth.app.wiz.io/oauth/token";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CYCLE = 20;

const ISSUES_QUERY = `
query Issues($first: Int!, $after: String, $filterBy: IssueFilters) {
  issues(first: $first, after: $after, filterBy: $filterBy) {
    nodes {
      id
      sourceRule { id name }
      severity
      status
      type
      createdAt
      updatedAt
      resolvedAt
      description
      remediation
      entity { id name type }
      projects { id name slug }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

type WizCursorV1 = { pass: number };

function encodeCursor(c: WizCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

export type WizSyncableOptions = {
  ensureWizMcpRunning: () => Promise<void>;
};

interface WizCreds {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiUrl: string;
  readonly authUrl: string;
}

async function loadWizCreds(ctx: SyncContext): Promise<WizCreds | null> {
  const clientId = (await readConnectorSecret(ctx.vault, "wiz", "client_id"))?.trim() ?? "";
  const clientSecret = (await readConnectorSecret(ctx.vault, "wiz", "client_secret"))?.trim() ?? "";
  if (clientId === "" || clientSecret === "") {
    return null;
  }
  const apiUrlRaw = (await readConnectorSecret(ctx.vault, "wiz", "api_url"))?.trim() ?? "";
  const authUrlRaw = (await readConnectorSecret(ctx.vault, "wiz", "auth_url"))?.trim() ?? "";
  return {
    clientId,
    clientSecret,
    apiUrl: apiUrlRaw === "" ? DEFAULT_API : apiUrlRaw,
    authUrl: authUrlRaw === "" ? DEFAULT_AUTH : authUrlRaw,
  };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

async function fetchAccessToken(
  ctx: SyncContext,
  creds: WizCreds,
): Promise<{ token: string | null; bytes: number; kind: "ok" | "http_error" | "parse_error" }> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    audience: "wiz-api",
  });
  const res = await fetch(creds.authUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, status: res.status, path: "/oauth/token" },
      "wiz auth failed",
    );
    return { token: null, bytes: text.length, kind: "http_error" };
  }
  try {
    const parsed = JSON.parse(text) as { access_token?: string };
    if (typeof parsed.access_token !== "string" || parsed.access_token === "") {
      return { token: null, bytes: text.length, kind: "parse_error" };
    }
    return { token: parsed.access_token, bytes: text.length, kind: "ok" };
  } catch {
    return { token: null, bytes: text.length, kind: "parse_error" };
  }
}

async function wizGraphql(
  ctx: SyncContext,
  creds: WizCreds,
  token: string,
  variables: Record<string, unknown>,
): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(creds.apiUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: ISSUES_QUERY, variables }),
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status }, "wiz graphql failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    const parsed = JSON.parse(text) as { data?: unknown; errors?: unknown };
    if (parsed.errors !== undefined) {
      ctx.logger.warn({ serviceId: SERVICE_ID, errors: parsed.errors }, "wiz graphql errors");
      return { kind: "parse_error", bytes: text.length };
    }
    return { kind: "ok", parsed: parsed.data ?? {}, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractIssueNodes(parsed: unknown): {
  readonly nodes: unknown[];
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
} {
  const root = asRecord(parsed) ?? {};
  const issues = asRecord(root["issues"]) ?? {};
  const nodes = issues["nodes"];
  const pageInfo = asRecord(issues["pageInfo"]) ?? {};
  const endCursor = stringField(pageInfo, "endCursor") ?? null;
  const hasNextPageRaw = pageInfo["hasNextPage"];
  return {
    nodes: Array.isArray(nodes) ? nodes : [],
    endCursor,
    hasNextPage: hasNextPageRaw === true,
  };
}

function upsertWizIssues(
  ctx: SyncContext,
  creds: WizCreds,
  nodes: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const node of nodes) {
    const mapped = mapWizIssueToItem(node, { apiBaseUrl: creds.apiUrl, syncedAt: now });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createWizSyncable(options: WizSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureWizMcpRunning();
      const creds = await loadWizCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const authResult = await fetchAccessToken(ctx, creds);
      let totalBytes = authResult.bytes;
      if (authResult.kind === "http_error" || authResult.token === null) {
        return syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor());
      }
      if (authResult.kind === "parse_error") {
        return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const now = Date.now();
      let totalUpserted = 0;
      let pageCursor: string | null = null;
      for (let page = 0; page < MAX_PAGES_PER_CYCLE; page += 1) {
        const outcome = await wizGraphql(ctx, creds, authResult.token, {
          first: PAGE_SIZE,
          after: pageCursor,
          filterBy: { status: ["OPEN"] },
        });
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          break;
        }
        const { nodes, endCursor, hasNextPage } = extractIssueNodes(outcome.parsed);
        totalUpserted += upsertWizIssues(ctx, creds, nodes, now);
        if (!hasNextPage || endCursor === null || nodes.length < PAGE_SIZE) {
          break;
        }
        pageCursor = endCursor;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
