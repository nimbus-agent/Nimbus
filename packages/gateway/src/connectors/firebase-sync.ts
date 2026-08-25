import {
  type GoogleServiceAccount,
  mintGoogleAccessToken,
  parseServiceAccountJson,
} from "@nimbus-dev/sdk";

import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { type FirebaseMappedRow, mapFirebaseReleaseToItem } from "./firebase-release-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "firebase";
const CURSOR_PREFIX = "nimbus-firebase1:";
const APP_DISTRIBUTION_API = "https://firebaseappdistribution.googleapis.com";
const RELEASES_PAGE_SIZE = 50;

type FirebaseCursorV1 = { pass: number };

function pass1Cursor(): string {
  const cursor: FirebaseCursorV1 = { pass: 1 };
  return encodeNimbusJsonCursor(CURSOR_PREFIX, cursor);
}

/**
 * Token minter, injected so tests can supply a deterministic token without a
 * real network round-trip to the Google token endpoint.
 */
export type FirebaseTokenMinter = (sa: GoogleServiceAccount) => Promise<string | null>;

export interface FirebaseSyncableOptions {
  readonly ensureFirebaseMcpRunning: () => Promise<void>;
  /** Override the OAuth2 token mint (default: real JWT-bearer exchange). */
  readonly mintToken?: FirebaseTokenMinter;
}

interface FirebaseConfig {
  readonly serviceAccount: GoogleServiceAccount;
  readonly appIds: string[];
}

async function readConfig(ctx: SyncContext): Promise<FirebaseConfig | null> {
  const saJson = (await ctx.getSecret("service_account_json")) ?? "";
  const appIdsRaw = (await ctx.getSecret("app_ids")) ?? "";
  if (saJson.trim() === "" || appIdsRaw.trim() === "") {
    return null;
  }
  const serviceAccount = parseServiceAccountJson(saJson);
  if (serviceAccount === null) {
    return null;
  }
  const appIds = appIdsRaw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (appIds.length === 0) {
    return null;
  }
  return { serviceAccount, appIds };
}

/** The project number is the 2nd colon-segment of a Firebase app id. */
function projectNumberFromAppId(appId: string): string | null {
  const segment = appId.split(":")[1];
  return segment !== undefined && segment !== "" ? segment : null;
}

function releasesUrl(appId: string): string | null {
  const projectNumber = projectNumberFromAppId(appId);
  if (projectNumber === null) {
    return null;
  }
  return `${APP_DISTRIBUTION_API}/v1/projects/${encodeURIComponent(projectNumber)}/apps/${encodeURIComponent(appId)}/releases?pageSize=${String(RELEASES_PAGE_SIZE)}`;
}

function extractReleases(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed) ?? {};
  const releases = root["releases"];
  if (!Array.isArray(releases)) {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const entry of releases) {
    const row = asRecord(entry);
    if (row !== undefined) {
      rows.push(row);
    }
  }
  return rows;
}

export function createFirebaseSyncable(options: FirebaseSyncableOptions): Syncable {
  const mintToken: FirebaseTokenMinter = options.mintToken ?? ((sa) => mintGoogleAccessToken(sa));
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureFirebaseMcpRunning();
      const config = await readConfig(ctx);
      if (config === null) {
        return syncNoopResult(cursor, t0);
      }

      const accessToken = await mintToken(config.serviceAccount);
      if (accessToken === null) {
        return syncPassCursorSuccess(t0, 0, pass1Cursor(), 0);
      }
      const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };

      const now = Date.now();
      let upserted = 0;
      let totalBytes = 0;

      for (const appId of config.appIds) {
        const url = releasesUrl(appId);
        if (url === null) {
          continue;
        }
        const outcome = await connectorFetch(ctx, SERVICE_ID, url, { headers });
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          continue;
        }
        for (const release of extractReleases(outcome.parsed)) {
          const mapped = mapFirebaseReleaseToItem(release, now);
          if (mapped === null) {
            continue;
          }
          upsertItem(ctx, mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), upserted);
    },
  };
}

function upsertItem(ctx: SyncContext, mapped: FirebaseMappedRow): void {
  ctx.upsertItem(mapped);
}
