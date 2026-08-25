import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../../sync/pass-cursor-sync-result.ts";
import type { Provider } from "../../sync/rate-limiter.ts";
import { type SyncContext, type SyncResult, syncNoopResult } from "../../sync/types.ts";
import { connectorFetch } from "./fetch-outcome.ts";

/** The row shape accepted by {@link upsertIndexedItemForSync}. */
type SyncUpsertRow = Parameters<SyncContext["upsertItem"]>[0];

/**
 * Spec for a "list apps → for each app fetch builds" HTTP sync pattern.
 * Used by Bitrise, Codemagic, and TestFlight connectors.
 *
 * @template C - credentials type (token string, JWT params, etc.)
 */
export interface PerAppPollSpec<C> {
  /** Rate-limiter provider id (e.g. "bitrise"). */
  readonly serviceId: Provider;
  /** Start the connector's MCP process if needed. */
  readonly ensureRunning: () => Promise<void>;
  /** Load credentials, or null when unconfigured → noop result. */
  readonly loadCreds: (ctx: SyncContext) => Promise<C | null>;
  /** The pass-1 cursor string to persist on every terminal result. */
  readonly pass1Cursor: () => string;
  /** Build the apps-list URL. */
  readonly appsUrl: () => string;
  /** Build request headers for a given credential (called once per top-level fetch and once per build fetch). */
  readonly makeHeaders: (creds: C) => Record<string, string>;
  /**
   * Extract the apps array from a successfully-parsed apps-list response.
   * Different connectors use different top-level keys ("data", "applications").
   */
  readonly extractApps: (parsed: unknown) => Record<string, unknown>[];
  /**
   * Get the app's ID from an app row; return undefined to skip builds fetch for this app.
   */
  readonly getAppId: (appRow: Record<string, unknown>) => string | undefined;
  /**
   * Build the builds URL for a given app ID.
   */
  readonly buildsUrl: (appId: string) => string;
  /**
   * Extract the builds array from a successfully-parsed builds response.
   */
  readonly extractBuilds: (parsed: unknown) => Record<string, unknown>[];
  /**
   * Map an app row to an upsert row, or null to skip.
   */
  readonly mapApp: (appRow: Record<string, unknown>, now: number) => SyncUpsertRow | null;
  /**
   * Map a build row to an upsert row, or null to skip.
   * Receives the parent `appRow` so connectors can pull extra context (e.g. appName).
   */
  readonly mapBuild: (
    buildRow: Record<string, unknown>,
    appRow: Record<string, unknown>,
    appId: string,
    now: number,
  ) => SyncUpsertRow | null;
}

/**
 * Run a single "list apps → fetch builds per app" sync pass.
 *
 * Skeleton shared by Bitrise, Codemagic, and TestFlight:
 *   ensure-running → load creds (noop if missing) →
 *   fetch apps (http/parse error → empty pass cursor) →
 *   for each app: map+upsert app, get id, fetch builds (non-ok → continue),
 *   map+upsert builds → pass-1 success.
 */
export async function runPerAppPollSync<C>(
  ctx: SyncContext,
  cursor: string | null,
  spec: PerAppPollSpec<C>,
): Promise<SyncResult> {
  const t0 = performance.now();
  await spec.ensureRunning();
  const creds = await spec.loadCreds(ctx);
  if (creds === null) {
    return syncNoopResult(cursor, t0);
  }

  const headers = spec.makeHeaders(creds);

  const appsOutcome = await connectorFetch(ctx, spec.serviceId, spec.appsUrl(), { headers });
  if (appsOutcome.kind === "http_error") {
    return syncPassCursorHttpEmpty(t0, appsOutcome.bytes, cursor, spec.pass1Cursor());
  }
  if (appsOutcome.kind === "parse_error") {
    return syncPassCursorParseEmpty(t0, appsOutcome.bytes, spec.pass1Cursor());
  }

  const apps = spec.extractApps(appsOutcome.parsed);
  const now = Date.now();
  let upserted = 0;
  let totalBytes = appsOutcome.bytes;

  for (const appRow of apps) {
    const mappedApp = spec.mapApp(appRow, now);
    if (mappedApp !== null) {
      ctx.upsertItem(mappedApp);
      upserted += 1;
    }
    const appId = spec.getAppId(appRow);
    if (appId === undefined) {
      continue;
    }
    const buildsOutcome = await connectorFetch(ctx, spec.serviceId, spec.buildsUrl(appId), {
      headers,
    });
    totalBytes += buildsOutcome.bytes;
    if (buildsOutcome.kind !== "ok") {
      continue;
    }
    for (const buildRow of spec.extractBuilds(buildsOutcome.parsed)) {
      const mapped = spec.mapBuild(buildRow, appRow, appId, now);
      if (mapped === null) {
        continue;
      }
      ctx.upsertItem(mapped);
      upserted += 1;
    }
  }

  return syncPassCursorSuccess(t0, totalBytes, spec.pass1Cursor(), upserted);
}
