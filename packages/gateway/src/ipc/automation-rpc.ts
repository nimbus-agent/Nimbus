import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import {
  deleteExtensionById,
  type ExtensionRow,
  listExtensions,
  setExtensionEnabled,
} from "../automation/extension-store.ts";
import {
  countItemsMatchingGraphPredicate,
  listCandidateGraphRelations,
  parseGraphPredicate,
} from "../automation/graph-predicate.ts";
import { listWatcherHistory } from "../automation/watcher-history.ts";
import {
  deleteWatcher,
  insertWatcher,
  listWatchers,
  setWatcherEnabled,
} from "../automation/watcher-store.ts";
import { listWorkflowRuns } from "../automation/workflow-run-history.ts";
import {
  deleteWorkflowByName,
  listWorkflows,
  upsertWorkflowByName,
} from "../automation/workflow-store.ts";
import {
  PRE_T2_DISABLE_REASON,
  preT2DisabledIds,
  preT2DisableMessage,
} from "../extensions/hard-disable.ts";
import { installExtensionFromLocalDirectory } from "../extensions/install-from-local.ts";
import type { PublisherKeyFetcher } from "../extensions/registry-client.ts";
import { syncPublisherKeys } from "../extensions/sync.ts";
import type { NimbusVault } from "../vault/index.ts";
import { asRecord } from "./connector-rpc-shared.ts";

export class AutomationRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
    this.name = "AutomationRpcError";
  }
}

type Hit = { kind: "hit"; value: unknown };

function requireString(rec: Record<string, unknown> | undefined, key: string): string {
  if (rec === undefined) {
    throw new AutomationRpcError(-32602, `Missing or invalid ${key}`);
  }
  const v = rec[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new AutomationRpcError(-32602, `Missing or invalid ${key}`);
  }
  return v.trim();
}

function requireNumber(rec: Record<string, unknown> | undefined, key: string): number {
  if (rec === undefined) {
    throw new AutomationRpcError(-32602, `Missing or invalid ${key}`);
  }
  const v = rec[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new AutomationRpcError(-32602, `Missing or invalid ${key}`);
  }
  return v;
}

function handleValidateCondition(rec: Record<string, unknown> | undefined, db: Database): Hit {
  const graphPredicateJson = requireString(rec, "graphPredicateJson");
  const sinceMs = requireNumber(rec, "sinceMs");
  const parsed = parseGraphPredicate(graphPredicateJson);
  if (!parsed.ok) {
    throw new AutomationRpcError(-32602, parsed.error);
  }
  return {
    kind: "hit",
    value: {
      matchCount: countItemsMatchingGraphPredicate({ db, predicate: parsed.predicate, sinceMs }),
    },
  };
}

export interface AutomationRpcExtensionMeshHandle {
  stopExtensionClient(extensionId: string): Promise<void>;
}

interface AutomationCtx {
  db: Database;
  extensionsDir?: string;
  mesh?: AutomationRpcExtensionMeshHandle;
  /** I16 — vault for caching verified publisher pubkeys at install time. */
  vault?: NimbusVault;
  /** I16 — registry client used to fetch unknown publisher pubkeys. */
  fetcher?: PublisherKeyFetcher;
  /** I16 — when true, refuse install if vault cache or explicit key cannot satisfy. */
  enforceAirGap?: boolean;
}

type AutomationHandler = (
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
) => Hit | Promise<Hit>;

const AUTOMATION_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
  "watcher.list": (_rec, ctx) => ({
    kind: "hit",
    value: { watchers: listWatchers(ctx.db) },
  }),

  "watcher.create": (rec, ctx) => {
    const graphPredicateJson =
      rec !== undefined && typeof rec["graphPredicateJson"] === "string"
        ? rec["graphPredicateJson"]
        : null;
    const id = insertWatcher(ctx.db, {
      name: requireString(rec, "name"),
      enabled: 1,
      condition_type: requireString(rec, "conditionType"),
      condition_json: requireString(rec, "conditionJson"),
      action_type: requireString(rec, "actionType"),
      action_json: requireString(rec, "actionJson"),
      created_at: Date.now(),
      graph_predicate_json: graphPredicateJson,
    });
    return { kind: "hit", value: { id } };
  },

  "watcher.delete": (rec, ctx) => {
    deleteWatcher(ctx.db, requireString(rec, "id"));
    return { kind: "hit", value: { ok: true } };
  },

  "watcher.pause": (rec, ctx) => ({
    kind: "hit",
    value: { ok: setWatcherEnabled(ctx.db, requireString(rec, "id"), false) },
  }),

  "watcher.resume": (rec, ctx) => ({
    kind: "hit",
    value: { ok: setWatcherEnabled(ctx.db, requireString(rec, "id"), true) },
  }),

  "watcher.listCandidateRelations": () => ({
    kind: "hit",
    value: { relations: listCandidateGraphRelations() },
  }),

  "watcher.validateCondition": (rec, ctx) => handleValidateCondition(rec, ctx.db),

  "watcher.listHistory": (rec, ctx) => ({
    kind: "hit",
    value: listWatcherHistory(ctx.db, {
      watcherId: requireString(rec, "watcherId"),
      limit: requireNumber(rec, "limit"),
    }),
  }),

  "extension.list": (rec, ctx) => handleExtensionList(rec, ctx),

  "extension.info": (rec, ctx) => handleExtensionInfo(rec, ctx),

  "extension.install": (rec, ctx) => handleExtensionInstall(rec, ctx),

  "extension.sync": async (rec, ctx) => handleExtensionSync(rec, ctx),

  "extension.enable": (rec, ctx) => ({
    kind: "hit",
    value: { ok: setExtensionEnabled(ctx.db, requireString(rec, "id"), true) },
  }),

  "extension.disable": (rec, ctx) => {
    const id = requireString(rec, "id");
    const ok = setExtensionEnabled(ctx.db, id, false);
    // S7-F10 — fire-and-forget: the IPC response shape is just { ok };
    // callers don't wait for the child teardown. The disabled-flag is
    // already flipped, so even if the stop is in flight, no new tool
    // calls will reach the child.
    if (ok && ctx.mesh !== undefined) {
      void ctx.mesh.stopExtensionClient(id);
    }
    return { kind: "hit", value: { ok } };
  },

  "extension.remove": (rec, ctx) => {
    const installPath = deleteExtensionById(ctx.db, requireString(rec, "id"));
    if (installPath === null) {
      throw new AutomationRpcError(-32602, "Extension not found");
    }
    try {
      rmSync(installPath, { recursive: true, force: true });
    } catch {
      /* row already removed; best-effort filesystem cleanup */
    }
    return { kind: "hit", value: { ok: true } };
  },

  "workflow.list": (_rec, ctx) => ({
    kind: "hit",
    value: { workflows: listWorkflows(ctx.db) },
  }),

  "workflow.save": (rec, ctx) => {
    const description =
      rec !== undefined && typeof rec["description"] === "string" ? rec["description"] : null;
    const id = upsertWorkflowByName(
      ctx.db,
      requireString(rec, "name"),
      description,
      requireString(rec, "stepsJson"),
      Date.now(),
    );
    return { kind: "hit", value: { id } };
  },

  "workflow.delete": (rec, ctx) => ({
    kind: "hit",
    value: { ok: deleteWorkflowByName(ctx.db, requireString(rec, "name")) },
  }),

  "workflow.listRuns": (rec, ctx) => ({
    kind: "hit",
    value: listWorkflowRuns(ctx.db, {
      workflowName: requireString(rec, "workflowName"),
      limit: requireNumber(rec, "limit"),
    }),
  }),
};

type ExtensionListItem = ExtensionRow & {
  /** Set when the extension is hard-disabled with a structured reason. */
  disabled_reason?: typeof PRE_T2_DISABLE_REASON;
  /** True when the extension was hard-disabled and needs to be reinstalled. */
  needs_reinstall?: boolean;
};

function decorateExtensionList(rows: readonly ExtensionRow[]): ExtensionListItem[] {
  const preT2 = new Set(preT2DisabledIds());
  return rows.map((r) =>
    preT2.has(r.id)
      ? { ...r, disabled_reason: PRE_T2_DISABLE_REASON, needs_reinstall: true }
      : { ...r },
  );
}

function handleExtensionList(rec: Record<string, unknown> | undefined, ctx: AutomationCtx): Hit {
  const filter = rec !== undefined && typeof rec["filter"] === "string" ? rec["filter"] : "";
  const all = decorateExtensionList(listExtensions(ctx.db));
  const filtered =
    filter === "needs-reinstall" || filter === "needs_reinstall"
      ? all.filter((e) => e.needs_reinstall === true)
      : all;
  return { kind: "hit", value: { extensions: filtered } };
}

function handleExtensionInfo(rec: Record<string, unknown> | undefined, ctx: AutomationCtx): Hit {
  const id = requireString(rec, "id");
  const row = listExtensions(ctx.db).find((r) => r.id === id);
  if (row === undefined) {
    throw new AutomationRpcError(-32602, "Extension not found");
  }
  const preT2 = new Set(preT2DisabledIds());
  if (preT2.has(row.id)) {
    return {
      kind: "hit",
      value: {
        extension: {
          ...row,
          disabled_reason: PRE_T2_DISABLE_REASON,
          needs_reinstall: true,
        },
        message: preT2DisableMessage(row.id, row.version),
      },
    };
  }
  return { kind: "hit", value: { extension: { ...row } } };
}

async function handleExtensionSync(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  if (ctx.vault === undefined) {
    throw new AutomationRpcError(-32603, "Gateway is not configured with a vault");
  }
  if (ctx.fetcher === undefined) {
    throw new AutomationRpcError(-32603, "Gateway is not configured with a publisher key fetcher");
  }
  const dryRun =
    rec !== undefined && typeof rec["dryRun"] === "boolean" ? (rec["dryRun"] as boolean) : false;
  try {
    const result = await syncPublisherKeys({
      vault: ctx.vault,
      db: ctx.db,
      fetcher: ctx.fetcher,
      enforceAirGap: ctx.enforceAirGap ?? false,
      dryRun,
    });
    return { kind: "hit", value: result as unknown as Record<string, unknown> };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AutomationRpcError(-32603, msg);
  }
}

async function handleExtensionInstall(
  rec: Record<string, unknown> | undefined,
  ctx: AutomationCtx,
): Promise<Hit> {
  const sourcePath = requireString(rec, "sourcePath");
  const dir = ctx.extensionsDir;
  if (dir === undefined || dir.trim() === "") {
    throw new AutomationRpcError(-32603, "Gateway is not configured with an extensions directory");
  }
  // Optional publisherKeyPath parameter for `--publisher-key <path>` CLI flow.
  const publisherKeyPath =
    rec !== undefined && typeof rec["publisherKeyPath"] === "string"
      ? rec["publisherKeyPath"].trim()
      : undefined;
  try {
    const installed = await installExtensionFromLocalDirectory({
      db: ctx.db,
      extensionsDir: dir,
      sourcePath,
      ...(ctx.vault !== undefined && { vault: ctx.vault }),
      ...(ctx.fetcher !== undefined && { fetcher: ctx.fetcher }),
      ...(ctx.enforceAirGap !== undefined && { enforceAirGap: ctx.enforceAirGap }),
      ...(publisherKeyPath !== undefined && publisherKeyPath !== "" && { publisherKeyPath }),
    });
    return {
      kind: "hit",
      value: {
        id: installed.id,
        version: installed.version,
        installPath: installed.installPath,
        manifestHash: installed.manifestHash,
        entryHash: installed.entryHash,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new AutomationRpcError(-32602, msg);
  }
}

export async function dispatchAutomationRpc(options: {
  method: string;
  params: unknown;
  db: Database;
  /** Required for `extension.install`. */
  extensionsDir?: string;
  /** S7-F10 — `extension.disable` calls `stopExtensionClient` to terminate the running child. */
  mesh?: AutomationRpcExtensionMeshHandle;
  /** I16 — vault for caching verified publisher pubkeys at install time. */
  vault?: NimbusVault;
  /** I16 — registry client used to fetch unknown publisher pubkeys. */
  fetcher?: PublisherKeyFetcher;
  /** I16 — when true, refuse signed-extension install if no local pubkey is available. */
  enforceAirGap?: boolean;
}): Promise<Hit | { kind: "miss" }> {
  const handler = AUTOMATION_HANDLERS[options.method];
  if (handler === undefined) {
    return { kind: "miss" };
  }
  const ctx: AutomationCtx = {
    db: options.db,
    ...(options.extensionsDir !== undefined && { extensionsDir: options.extensionsDir }),
    ...(options.mesh !== undefined && { mesh: options.mesh }),
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(options.fetcher !== undefined && { fetcher: options.fetcher }),
    ...(options.enforceAirGap !== undefined && { enforceAirGap: options.enforceAirGap }),
  };
  return await handler(asRecord(options.params), ctx);
}
