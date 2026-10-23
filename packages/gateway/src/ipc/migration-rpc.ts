/**
 * `migration.*` (connector-unbundling spec § 7.2, § 7.3): the owner's view of, and the one decision
 * about, a bundled connector moving to its signed extension. Every method is in
 * `FORBIDDEN_OVER_LAN` (I5). `migration.list` and `migration.accept` are renderer-callable (on the
 * Tauri allowlist, I46): the desktop lists pending migrations and answers one by id. `decline` and
 * `retry` are not — they stay in a terminal (`nimbus connector migrate`).
 *
 * I46: accept takes a migration id and NOTHING else from its params — no package, registry,
 * permission, credential or flag. Whether it can succeed is decided by the engine's whitelist (a
 * gateway-created row in `awaiting_approval`, the baked built-in registry and root key, the staged
 * tree digest, the baked continuity entry), identically for every caller. `fromRenderer` is an
 * audit field the dispatcher derives from the connection's declared kind, never from params.
 *
 *   migration.list            -> { migrations: MigrationRowView[] }
 *   migration.accept { id }   -> MigrationRowView   (one `extension.migrate` prompt, unicast to the
 *                                                    calling session through the owner's gate)
 *   migration.decline { id }  -> MigrationRowView
 *   migration.retry           -> { migrations: MigrationRowView[] }   (re-prepares failed AND
 *                                                                      declined rows — B10)
 *
 * Nothing here returns a filesystem path: a row's `stagePath` is dropped, and every path inside an
 * error text is replaced before it leaves the gateway (`migration-redact.ts`: the gateway's own roots
 * literally first, so a path with a space is redacted whole). No Vault value ever reaches a row or an
 * error (the engine only checks a credential is non-blank).
 */
import type { ExtensionRunGate } from "../extensions/approve-run.ts";
import {
  type MigrationEngine,
  MigrationError,
  type MigrationRow,
  migrationConsentViaGate,
} from "../extensions/migration/migration-engine.ts";
import { redactMigrationPaths } from "../extensions/migration/migration-redact.ts";
import { asRecord } from "./connector-rpc-shared.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

export { redactMigrationPaths } from "../extensions/migration/migration-redact.ts";

/** A migration row as a client sees it: every column but the staging path. */
export interface MigrationRowView {
  readonly id: string;
  readonly legacyServiceId: string;
  readonly extensionId: string;
  readonly version: string | null;
  readonly treeDigest: string | null;
  readonly state: MigrationRow["state"];
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MigrationRpcContext {
  readonly engine: Pick<MigrationEngine, "list" | "accept" | "decline" | "retry">;
  /**
   * `migration.accept` only: the per-call owner gate — the gate-only executor bound to the CALLING
   * session's consent channel, so the `extension.migrate` prompt goes to that session alone.
   */
  readonly ownerGate?: ExtensionRunGate;
  /**
   * The gateway's own directories (data, extensions, config, home), substituted literally before
   * any pattern runs. Absent means the pattern passes alone.
   */
  readonly redactRoots?: readonly string[];
  /**
   * `migration.accept` only, I46's audit field: the call arrived on the desktop bridge's
   * connection (its kind, declared once at connect time). Recorded in the prompt's payload and so
   * in the gate's audit row; no decision reads it. Absent means false.
   */
  readonly fromRenderer?: boolean;
}

type Hit = { kind: "hit"; value: unknown };
type Miss = { kind: "miss" };

export function toMigrationRowView(
  row: MigrationRow,
  redactRoots: readonly string[] = [],
): MigrationRowView {
  return {
    id: row.id,
    legacyServiceId: row.legacyServiceId,
    extensionId: row.extensionId,
    version: row.version,
    treeDigest: row.treeDigest,
    state: row.state,
    error: row.error === null ? null : redactMigrationPaths(row.error, redactRoots),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function listView(ctx: MigrationRpcContext): { migrations: MigrationRowView[] } {
  return { migrations: ctx.engine.list().map((r) => toMigrationRowView(r, ctx.redactRoots)) };
}

function requireId(rec: Record<string, unknown> | undefined): string {
  const v = rec?.["id"];
  if (typeof v !== "string" || v.trim() === "") {
    throw new RpcMethodError(-32602, "Invalid params: 'id' (non-empty string) required");
  }
  return v.trim();
}

/** A `MigrationError` keeps its code (it leads the message, and rides in `data`); paths never. */
function rpcErrorOf(e: unknown, redactRoots: readonly string[] | undefined): unknown {
  if (!(e instanceof MigrationError)) return e;
  return new RpcMethodError(-32000, redactMigrationPaths(e.message, redactRoots), {
    code: e.code,
  });
}

async function handleAccept(
  rec: Record<string, unknown> | undefined,
  ctx: MigrationRpcContext,
): Promise<Hit> {
  const id = requireId(rec);
  const gate = ctx.ownerGate;
  if (gate === undefined) {
    throw new RpcMethodError(-32603, "migration.accept requires the owner's HITL gate");
  }
  // `migrationConsentViaGate` is the ONE way the owner's gate becomes the migration consent: it
  // asks under `extension.migrate` (I2 frozen set, never delegable — I20) and nothing else.
  const row = await ctx.engine.accept(id, migrationConsentViaGate(gate), {
    fromRenderer: ctx.fromRenderer === true,
  });
  return { kind: "hit", value: toMigrationRowView(row, ctx.redactRoots) };
}

export async function dispatchMigrationRpc(
  method: string,
  params: unknown,
  ctx: MigrationRpcContext,
): Promise<Hit | Miss> {
  const rec = asRecord(params);
  try {
    switch (method) {
      case "migration.list":
        return { kind: "hit", value: listView(ctx) };
      case "migration.accept":
        return await handleAccept(rec, ctx);
      case "migration.decline":
        return {
          kind: "hit",
          value: toMigrationRowView(ctx.engine.decline(requireId(rec)), ctx.redactRoots),
        };
      case "migration.retry":
        // B10: `retry`, never `evaluate` — it also re-prepares a DECLINED row (the owner changing
        // their mind, spec § 7.2 step 6), which boot evaluation never does.
        await ctx.engine.retry();
        return { kind: "hit", value: listView(ctx) };
      default:
        return { kind: "miss" };
    }
  } catch (e) {
    throw rpcErrorOf(e, ctx.redactRoots);
  }
}
