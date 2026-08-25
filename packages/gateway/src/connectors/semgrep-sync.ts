import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSemgrepFindingToItem } from "./semgrep-finding-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "semgrep";
const CURSOR_PREFIX = "nimbus-semgrep1:";
const SEMGREP_API = "https://semgrep.dev/api/v1";
const PAGE_SIZE = 100;
const MAX_PAGES_PER_CYCLE = 20;
type SemgrepCursorV1 = { pass: number };

function encodeCursor(c: SemgrepCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function pass1Cursor(): string {
  return encodeCursor({ pass: 1 });
}

export type SemgrepSyncableOptions = {
  ensureSemgrepMcpRunning: () => Promise<void>;
};

function semgrepGet(ctx: SyncContext, token: string, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${SEMGREP_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

function firstDeploymentSlug(parsed: unknown): string | null {
  const root = asRecord(parsed) ?? {};
  const deployments = root["deployments"];
  if (!Array.isArray(deployments)) {
    return null;
  }
  for (const d of deployments) {
    const row = asRecord(d);
    if (row === undefined) {
      continue;
    }
    const slug = stringField(row, "slug");
    if (slug !== undefined && slug !== "") {
      return slug;
    }
  }
  return null;
}

function extractFindings(parsed: unknown): unknown[] {
  const root = asRecord(parsed) ?? {};
  const findings = root["findings"];
  return Array.isArray(findings) ? findings : [];
}

function extractCursor(parsed: unknown): string | null {
  const root = asRecord(parsed) ?? {};
  const cursor = root["cursor"];
  return typeof cursor === "string" && cursor !== "" ? cursor : null;
}

interface SemgrepCreds {
  readonly token: string;
  readonly deploymentSlug: string | null;
}

async function loadSemgrepCreds(ctx: SyncContext): Promise<SemgrepCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const slugRaw = await ctx.getSecret("deployment_slug");
  const slug = (slugRaw ?? "").trim();
  return { token, deploymentSlug: slug === "" ? null : slug };
}

async function resolveDeploymentSlug(
  ctx: SyncContext,
  token: string,
): Promise<{ slug: string | null; bytes: number; kind: "ok" | "http_error" | "parse_error" }> {
  const outcome = await semgrepGet(ctx, token, "/deployments");
  if (outcome.kind !== "ok") {
    return { slug: null, bytes: outcome.bytes, kind: outcome.kind };
  }
  return { slug: firstDeploymentSlug(outcome.parsed), bytes: outcome.bytes, kind: "ok" };
}

function buildFindingsPath(slug: string, cursor: string | null): string {
  const params = new URLSearchParams({
    statuses: "open",
    page_size: String(PAGE_SIZE),
  });
  if (cursor !== null) {
    params.set("cursor", cursor);
  }
  return `/deployments/${encodeURIComponent(slug)}/findings?${params.toString()}`;
}

function upsertSemgrepFindings(
  ctx: SyncContext,
  slug: string,
  findings: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const f of findings) {
    const mapped = mapSemgrepFindingToItem(f, {
      deploymentSlug: slug,
      syncedAt: now,
    });
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
  }
  return upserted;
}

export function createSemgrepSyncable(options: SemgrepSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSemgrepMcpRunning();
      const creds = await loadSemgrepCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      let totalBytes = 0;
      let slug = creds.deploymentSlug;
      if (slug === null) {
        const resolved = await resolveDeploymentSlug(ctx, creds.token);
        totalBytes += resolved.bytes;
        if (resolved.kind === "http_error") {
          return syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor());
        }
        if (resolved.kind === "parse_error") {
          return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
        }
        if (resolved.slug === null) {
          return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), 0);
        }
        slug = resolved.slug;
      }

      const now = Date.now();
      let totalUpserted = 0;
      let pageCursor: string | null = null;
      for (let page = 0; page < MAX_PAGES_PER_CYCLE; page += 1) {
        const outcome = await semgrepGet(ctx, creds.token, buildFindingsPath(slug, pageCursor));
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          break;
        }
        const findings = extractFindings(outcome.parsed);
        totalUpserted += upsertSemgrepFindings(ctx, slug, findings, now);
        const next = extractCursor(outcome.parsed);
        if (next === null || findings.length < PAGE_SIZE) {
          break;
        }
        pageCursor = next;
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
