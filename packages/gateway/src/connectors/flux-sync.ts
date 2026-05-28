import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
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

/**
 * Flux CRD walk table — the GitOps-Toolkit Custom Resources we index. The user
 * chose "everything incl. image-automation". Duplicated (intentionally) in the
 * MCP server (`packages/mcp-connectors/flux/src/server.ts`) so neither side
 * depends on the other.
 */
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

/**
 * Both `flux.api_url` and `flux.token` are required and have no defaults —
 * Flux is self-hosted (the Kubernetes API server), so there is no SaaS host to
 * fall back to. The connector no-ops unless both are non-empty after trim.
 */
async function loadCreds(ctx: SyncContext): Promise<FluxCreds | null> {
  const apiUrl = (await readConnectorSecret(ctx.vault, "flux", "api_url"))?.trim() ?? "";
  const token = (await readConnectorSecret(ctx.vault, "flux", "token"))?.trim() ?? "";
  if (apiUrl === "" || token === "") {
    return null;
  }
  return { apiUrl: trimTrailingSlash(apiUrl), token };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "error"; bytes: number };

async function agGet(ctx: SyncContext, creds: FluxCreds, path: string): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  // FLUX_TOKEN is a read-only Kubernetes ServiceAccount JWT.
  const res = await fetch(`${creds.apiUrl}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    return { kind: "error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "error", bytes: text.length };
  }
}

/** A Kubernetes List response carries `{ items: [...] }`; coerce defensively. */
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

      // Walk each CRD kind. A non-ok outcome (CRD group not installed,
      // version drift, transient 5xx) is non-fatal — log and continue to the
      // next kind. A fully-unreachable API just yields 0 upserts.
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
