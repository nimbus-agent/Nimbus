import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapFluxResourceToItem } from "./flux-resource-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord } from "./unknown-record.ts";

const SERVICE_ID = "flux";
const CURSOR_PREFIX = "nimbus-flux1:";

type FluxCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies FluxCursorV1);
}

interface FluxKindEntry {
  readonly kind: string;
  readonly group: string;
  readonly version: string;
  readonly plural: string;
}

const FLUX_KINDS: readonly FluxKindEntry[] = [
  {
    kind: "kustomization",
    group: "kustomize.toolkit.fluxcd.io",
    version: "v1",
    plural: "kustomizations",
  },
  { kind: "helm_release", group: "helm.toolkit.fluxcd.io", version: "v2", plural: "helmreleases" },
  {
    kind: "git_repository",
    group: "source.toolkit.fluxcd.io",
    version: "v1",
    plural: "gitrepositories",
  },
  {
    kind: "oci_repository",
    group: "source.toolkit.fluxcd.io",
    version: "v1",
    plural: "ocirepositories",
  },
  {
    kind: "helm_repository",
    group: "source.toolkit.fluxcd.io",
    version: "v1",
    plural: "helmrepositories",
  },
  { kind: "bucket", group: "source.toolkit.fluxcd.io", version: "v1", plural: "buckets" },
  {
    kind: "image_repository",
    group: "image.toolkit.fluxcd.io",
    version: "v1beta2",
    plural: "imagerepositories",
  },
  {
    kind: "image_policy",
    group: "image.toolkit.fluxcd.io",
    version: "v1beta2",
    plural: "imagepolicies",
  },
  {
    kind: "image_update_automation",
    group: "image.toolkit.fluxcd.io",
    version: "v1beta1",
    plural: "imageupdateautomations",
  },
];

export type FluxSyncableOptions = {
  ensureFluxMcpRunning: () => Promise<void>;
};

interface FluxCreds {
  readonly apiUrl: string;
  readonly token: string;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

async function loadCreds(ctx: SyncContext): Promise<FluxCreds | null> {
  const apiUrl = (await readConnectorSecret(ctx.vault, "flux", "api_url"))?.trim() ?? "";
  const token = (await readConnectorSecret(ctx.vault, "flux", "token"))?.trim() ?? "";
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

      for (const entry of FLUX_KINDS) {
        const path = `/apis/${entry.group}/${entry.version}/${entry.plural}`;
        const outcome = await agGet(ctx, creds, path);
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
          upsertIndexedItemForSync(ctx, mapped);
          totalUpserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
