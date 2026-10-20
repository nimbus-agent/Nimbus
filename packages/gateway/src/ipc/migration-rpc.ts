/**
 * `migration.*` (Readwise unbundling spec § 7.2, § 7.3's CLI bullet): the owner's view of, and the
 * one decision about, a bundled connector moving to its signed extension. CLI-only: every method is
 * in `FORBIDDEN_OVER_LAN` (I5) and none is on the Tauri allowlist (I7) — the desktop path is a
 * separate, later surface.
 *
 *   migration.list            -> { migrations: MigrationRowView[] }
 *   migration.accept { id }   -> MigrationRowView   (one `extension.migrate` prompt, unicast to the
 *                                                    calling session through the owner's gate)
 *   migration.decline { id }  -> MigrationRowView
 *   migration.retry           -> { migrations: MigrationRowView[] }   (re-prepares failed AND
 *                                                                      declined rows — B10)
 *
 * Nothing here returns a filesystem path: a row's `stagePath` is dropped, and any absolute path
 * inside an error text is replaced before it leaves the gateway. No Vault value ever reaches a row
 * or an error (the engine only checks a credential is non-blank).
 */
import type { ExtensionRunGate } from "../extensions/approve-run.ts";
import {
  type MigrationEngine,
  MigrationError,
  type MigrationRow,
  migrationConsentViaGate,
} from "../extensions/migration/migration-engine.ts";
import { asRecord } from "./connector-rpc-shared.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

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
}

type Hit = { kind: "hit"; value: unknown };
type Miss = { kind: "miss" };

const PATH_PLACEHOLDER = "<path>";
/** `file:` URLs name a local path too. */
const FILE_URL_RE = /\bfile:\/\/[^\s'"`<>]*/gi;
/** A drive-letter path (`C:\…` or `C:/…`) or a UNC path (`\\host\share\…`). */
const WINDOWS_PATH_RE = /(?:\b[A-Za-z]:[\\/]|\\\\)[^\s'"`<>|]*/g;
/**
 * A POSIX absolute path at the start of a token. The preceding character excludes `:` and `/`, so
 * the `//host/path` of an `https://` URL is not taken for one.
 */
const POSIX_PATH_RE = /(^|[\s'"`(=,[])\/(?!\/)[^\s'"`<>)\],]*/g;

/**
 * Replaces every absolute filesystem path in `text`. Error texts come from the registry fetch,
 * the install and the filesystem, any of which can name the data directory, the extensions
 * directory or a staging path. Stated bound: a RELATIVE path survives, and a bare word is never
 * taken for a path.
 */
export function redactMigrationPaths(text: string): string {
  return text
    .replace(FILE_URL_RE, PATH_PLACEHOLDER)
    .replace(WINDOWS_PATH_RE, PATH_PLACEHOLDER)
    .replace(POSIX_PATH_RE, (_m, lead: string) => `${lead}${PATH_PLACEHOLDER}`);
}

export function toMigrationRowView(row: MigrationRow): MigrationRowView {
  return {
    id: row.id,
    legacyServiceId: row.legacyServiceId,
    extensionId: row.extensionId,
    version: row.version,
    treeDigest: row.treeDigest,
    state: row.state,
    error: row.error === null ? null : redactMigrationPaths(row.error),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function listView(engine: MigrationRpcContext["engine"]): { migrations: MigrationRowView[] } {
  return { migrations: engine.list().map(toMigrationRowView) };
}

function requireId(rec: Record<string, unknown> | undefined): string {
  const v = rec?.["id"];
  if (typeof v !== "string" || v.trim() === "") {
    throw new RpcMethodError(-32602, "Invalid params: 'id' (non-empty string) required");
  }
  return v.trim();
}

/** A `MigrationError` keeps its code (it leads the message, and rides in `data`); paths never. */
function rpcErrorOf(e: unknown): unknown {
  if (!(e instanceof MigrationError)) return e;
  return new RpcMethodError(-32000, redactMigrationPaths(e.message), { code: e.code });
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
  const row = await ctx.engine.accept(id, migrationConsentViaGate(gate));
  return { kind: "hit", value: toMigrationRowView(row) };
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
        return { kind: "hit", value: listView(ctx.engine) };
      case "migration.accept":
        return await handleAccept(rec, ctx);
      case "migration.decline":
        return { kind: "hit", value: toMigrationRowView(ctx.engine.decline(requireId(rec))) };
      case "migration.retry":
        // B10: `retry`, never `evaluate` — it also re-prepares a DECLINED row (the owner changing
        // their mind, spec § 7.2 step 6), which boot evaluation never does.
        await ctx.engine.retry();
        return { kind: "hit", value: listView(ctx.engine) };
      default:
        return { kind: "miss" };
    }
  } catch (e) {
    throw rpcErrorOf(e);
  }
}
