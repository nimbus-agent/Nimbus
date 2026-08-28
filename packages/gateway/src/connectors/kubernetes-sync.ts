import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { spawnCapture } from "../platform/spawn-capture.ts";
import { syncPassCursorParseEmpty } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "kubernetes";
const CURSOR_PREFIX = "nimbus-k8s1:";

type K8sCursorV1 = { resourceVersion: string };

function encodeCursor(c: K8sCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function zeroRvCursor(): string {
  return encodeCursor({ resourceVersion: "0" });
}

async function syncKubernetesDeploymentsList(
  ctx: SyncContext,
  cursor: string | null,
  kc: string,
  kctx: string | null,
  t0: number,
): Promise<SyncResult> {
  const res = await kubectlDeploymentsJson(kc, kctx);
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID }, "kubernetes sync: kubectl get deployments failed");
    return {
      cursor: cursor ?? zeroRvCursor(),
      itemsUpserted: 0,
      itemsDeleted: 0,
      hasMore: false,
      durationMs: Math.round(performance.now() - t0),
      bytesTransferred: res.text.length,
    };
  }
  let root: unknown;
  try {
    root = JSON.parse(res.text) as unknown;
  } catch {
    return syncPassCursorParseEmpty(t0, res.text.length, zeroRvCursor());
  }
  const rec = asRecord(root);
  let rv: string | undefined;
  let items: unknown[] = [];
  if (rec !== undefined) {
    const listMeta = asRecord(rec["metadata"]);
    if (listMeta !== undefined) {
      rv = stringField(listMeta, "resourceVersion");
    }
    const rawItems = rec["items"];
    if (Array.isArray(rawItems)) {
      items = rawItems;
    }
  }
  const now = Date.now();
  let upserted = 0;
  for (const item of items) {
    const row = asRecord(item);
    if (row === undefined) {
      continue;
    }
    const meta = asRecord(row["metadata"]);
    if (meta === undefined) {
      continue;
    }
    const ns = stringField(meta, "namespace");
    const name = stringField(meta, "name");
    if (ns === undefined || name === undefined) {
      continue;
    }
    const extId = `deploy:${ns}/${name}`;
    ctx.upsertItem({
      service: SERVICE_ID,
      type: "k8s_workload",
      externalId: extId,
      title: `${ns}/${name}`,
      bodyPreview: "deployment",
      url: null,
      canonicalUrl: null,
      modifiedAt: now,
      authorId: null,
      metadata: { namespace: ns, name, kind: "Deployment" },
      pinned: false,
      syncedAt: now,
    });
    upserted += 1;
  }

  return {
    cursor: encodeCursor({ resourceVersion: rv ?? "0" }),
    itemsUpserted: upserted,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
    bytesTransferred: res.text.length,
  };
}

async function kubectlDeploymentsJson(
  kubeconfig: string,
  context: string | null,
): Promise<{ ok: boolean; text: string }> {
  const args = ["kubectl"];
  if (context !== null && context.trim() !== "") {
    args.push("--context", context.trim());
  }
  args.push("get", "deployments", "-A", "-o", "json");
  // `spawnCapture`, not `Bun.spawn`: the Gateway runs detached, so on Windows an unhidden
  // console-subsystem child pops a visible window on every sync tick. See
  // `platform/spawn-capture.ts`.
  const r = await spawnCapture(args, {
    env: extensionProcessEnv({ KUBECONFIG: kubeconfig }),
  });
  return { ok: r.ok, text: r.stdout };
}

export type KubernetesSyncableOptions = {
  ensureKubernetesMcpRunning: () => Promise<void>;
};

export function createKubernetesSyncable(options: KubernetesSyncableOptions): Syncable {
  const initialSyncDepthDays = 1;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 120 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureKubernetesMcpRunning();
      const kubePath = await ctx.getSecret("kubeconfig");
      if (kubePath === null || kubePath.trim() === "") {
        return syncNoopResult(cursor, t0);
      }
      const kc = kubePath.trim();
      const ctxNameRaw = await ctx.getSecret("context");
      const kctx = ctxNameRaw !== null && ctxNameRaw.trim() !== "" ? ctxNameRaw.trim() : null;

      await ctx.rateLimiter.acquire("kubernetes");
      return syncKubernetesDeploymentsList(ctx, cursor, kc, kctx, t0);
    },
  };
}
