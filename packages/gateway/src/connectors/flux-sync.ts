import { FLUX_KINDS, trimTrailingSlash } from "@nimbus-dev/sdk";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { mapFluxResourceToItem } from "./flux-resource-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "flux";
const CURSOR_PREFIX = "nimbus-flux1:";

type FluxCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies FluxCursorV1);
}

export type FluxSyncableOptions = {
  ensureFluxMcpRunning: () => Promise<void>;
};

interface FluxCreds {
  readonly apiUrl: string;
  readonly token: string;
}

async function loadCreds(ctx: SyncContext): Promise<FluxCreds | null> {
  const apiUrl = (await ctx.getSecret("api_url"))?.trim() ?? "";
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (apiUrl === "" || token === "") {
    return null;
  }
  return { apiUrl: trimTrailingSlash(apiUrl), token };
}

function agGet(ctx: SyncContext, creds: FluxCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${creds.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
}

function extractItems(parsed: unknown): unknown[] {
  const items = asRecord(parsed)?.["items"];
  return Array.isArray(items) ? items : [];
}

export function createFluxSyncable(options: FluxSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureFluxMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;

      // One read-only GET per Flux kind. FLUX_KINDS is a small, fixed SDK list of independent
      // endpoints, so they are fetched concurrently. The outcomes are then handled in FLUX_KINDS
      // order, so the index writes and this loop's per-kind warnings land exactly as a
      // one-at-a-time walk leaves them; only `connectorFetch`'s own per-request failure log
      // follows completion order.
      const fetched = await Promise.all(
        FLUX_KINDS.map(async (entry) => {
          const path = `/apis/${entry.group}/${entry.version}/${entry.plural}`;
          return { entry, path, outcome: await agGet(ctx, creds, path) };
        }),
      );

      for (const { entry, path, outcome } of fetched) {
        totalBytes += outcome.bytes;
        if (outcome.kind !== "ok") {
          ctx.logger.warn(
            { serviceId: SERVICE_ID, kind: entry.kind, path },
            "flux GET failed; skipping kind",
          );
          continue;
        }
        for (const raw of extractItems(outcome.parsed)) {
          const mapped = mapFluxResourceToItem(raw, { kind: entry.kind, syncedAt: now });
          if (mapped === null) {
            continue;
          }
          ctx.upsertItem(mapped);
          totalUpserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
