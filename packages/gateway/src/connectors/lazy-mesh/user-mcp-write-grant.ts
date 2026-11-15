// packages/gateway/src/connectors/lazy-mesh/user-mcp-write-grant.ts
// The ONE builder of a user MCP server's write grant (I15; Phase 28 AD5b; static D10 `user-write`).
//
// A user MCP server may write the directories its registration names (`--write <dir>`, V98
// `write_paths_json`). The owner approved them at registration; this module decides, at EVERY spawn
// decision, whether they may still be granted, and produces the only value from which a spawn
// manifest can carry a write path (`PreparedUserMcpWriteGrant`). A refused preparation refuses the
// spawn: it never falls back to a spawn without the grant.
//
// The steps, in order (each a fixed reason; a later step never runs after a refusal):
//   1. the stored list parses, holds at most four directories and none overlaps another;
//   2. each directory passes `writeDirRefusal` in spawn mode, with the facts read NOW;
//   3. the sandbox of this OS can confine the exact policy (`canConfine`);
//   4. Windows only: every path an EARLIER spawn of this id was granted and this one is not is
//      revoked, fail closed, and this spawn's paths are recorded in the ledger BEFORE any client
//      exists. An AppContainer ACE outlives its child, the gateway and even its profile (measured),
//      so the ledger is the only memory of what must be revoked later.
//
// The ledger records EVERY path the profile is granted, read and write: a re-registered id would
// otherwise inherit the earlier registration's read ACEs as well.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { SandboxPolicy } from "../../platform/sandbox/sandbox-policy.ts";
import type { AppContainerGrantRevoker } from "../../platform/sandbox/win32-grant-revoke.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import {
  MAX_WRITE_DIRS,
  type WriteDirDeps,
  writeDirRefusal,
  writeDirsOverlap,
} from "../write-dir-rules.ts";

declare const PREPARED: unique symbol;

/**
 * The write directories a spawn may be granted. Constructed ONLY in this module (the brand has no
 * value outside it), by `prepareUserMcpWriteGrant` or as {@link NO_USER_MCP_WRITE_GRANT}.
 */
export interface PreparedUserMcpWriteGrant {
  readonly [PREPARED]: true;
  readonly dirs: readonly string[];
}

function prepared(dirs: readonly string[]): PreparedUserMcpWriteGrant {
  return { dirs: Object.freeze([...dirs]) } as PreparedUserMcpWriteGrant;
}

/** No write directory: what every server registered without `--write` spawns with. */
export const NO_USER_MCP_WRITE_GRANT: PreparedUserMcpWriteGrant = prepared([]);

/** The policy id (and Windows profile id) of a user MCP server. */
export function userMcpPolicyId(serviceId: string): string {
  return `user.${serviceId}`;
}

/** Fixed reasons of a refused preparation; none echoes a path. */
export const USER_MCP_WRITE_GRANT_REFUSALS = Object.freeze({
  malformed: "the stored write directories are malformed",
  tooMany: "more write directories are stored than a server may have",
  overlap: "two stored write directories overlap",
  ledgerUnreadable: "the record of earlier Windows grants could not be read",
  revokeFailed: "an earlier Windows grant could not be revoked",
  ledgerWriteFailed: "the record of this spawn's Windows grants could not be written",
});

/**
 * What one user MCP profile was granted: every path (read and write), and which of them it could
 * WRITE. The access level is recorded so that a path which is kept but loses its write right is
 * revoked before it is granted again as read-only (a Windows grant merges rights, it never narrows).
 */
export interface UserMcpLedgerEntry {
  readonly paths: readonly string[];
  readonly writable: readonly string[];
}

export type UserMcpLedger = Readonly<Record<string, UserMcpLedgerEntry>>;

export interface UserMcpGrantLedgerStore {
  /** Every recorded profile's entry. Missing file: `{}`. Unreadable or malformed: THROWS. */
  load(): UserMcpLedger;
  /** Replace the record (atomically: a temp file renamed over the old one). */
  save(all: UserMcpLedger): void;
}

/** The ledger file for a given config dir: beside the Obsidian and iac ledgers, never under `dataDir`. */
export function userMcpGrantLedgerFile(configDir: string): string {
  return join(configDir, "sandbox-grants", "user-mcp-ledger.json");
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((p) => typeof p === "string");
}

function isLedgerEntry(v: unknown): v is UserMcpLedgerEntry {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as { paths?: unknown; writable?: unknown };
  return isStringArray(e.paths) && isStringArray(e.writable);
}

function isLedgerShape(v: unknown): v is Record<string, UserMcpLedgerEntry> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  return Object.values(v).every(isLedgerEntry);
}

/** The production store: one JSON object, service id to paths, in `file`. */
export function fileUserMcpGrantLedger(file: string): UserMcpGrantLedgerStore {
  return {
    load: () => {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (err) {
        if (isErrno(err, "ENOENT")) return {};
        throw err;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!isLedgerShape(parsed)) {
        throw new Error(`the user MCP grant ledger is malformed: ${file}`);
      }
      return parsed;
    },
    save: (all) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

export interface UserMcpWriteGrantDeps {
  /** The facts the placement rule reads, read at the call. */
  readonly writeDir: WriteDirDeps;
  /** The sandbox runner's own answer for the exact policy; `null` means it can confine it. */
  readonly canConfine: (policy: SandboxPolicy) => string | null;
  readonly ledger: UserMcpGrantLedgerStore;
  /** The Windows revoker for one policy id (inactive elsewhere). */
  readonly revokerFor: (policyId: string) => AppContainerGrantRevoker;
}

export type PrepareUserMcpWriteGrantResult =
  | { readonly ok: true; readonly grant: PreparedUserMcpWriteGrant }
  | { readonly ok: false; readonly reason: string };

function parseStringArray(raw: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((x): x is string => typeof x === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** The stored directories, or the fixed reason they cannot be used. No file-system read. */
export function storedWriteDirs(
  row: UserMcpConnectorRow,
  platform: NodeJS.Platform,
):
  | { readonly ok: true; readonly dirs: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  const dirs = parseStringArray(row.write_paths_json);
  if (dirs === undefined) return { ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.malformed };
  if (dirs.length > MAX_WRITE_DIRS) {
    return { ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.tooMany };
  }
  for (let i = 0; i < dirs.length; i++) {
    for (let j = i + 1; j < dirs.length; j++) {
      if (writeDirsOverlap(dirs[i] ?? "", dirs[j] ?? "", platform)) {
        return { ok: false, reason: USER_MCP_WRITE_GRANT_REFUSALS.overlap };
      }
    }
  }
  return { ok: true, dirs };
}

/** The file-system half of a user MCP spawn manifest, with its two declarations when it has a grant. */
export type UserMcpWriteManifestParts = Pick<
  ExtensionManifest,
  "canonicalWritePaths" | "canonicalWriteDirs"
> &
  Readonly<Record<"read" | "write", string[]>>;

/**
 * The permissions of a user MCP spawn for a prepared grant: the directories are readable as well as
 * writable (a macOS write rule grants no read, so read is the union), each is declared a canonical
 * path and a directory, and a spawn with no grant gets exactly `write: []` and neither declaration.
 */
export function userMcpWriteManifestParts(
  read: readonly string[],
  grant: PreparedUserMcpWriteGrant,
): UserMcpWriteManifestParts {
  if (grant.dirs.length === 0) return { read: [...read], write: [] };
  const seen = new Set(read);
  return {
    read: [...read, ...grant.dirs.filter((d) => !seen.has(d))],
    write: [...grant.dirs],
    canonicalWritePaths: [...grant.dirs],
    canonicalWriteDirs: [...grant.dirs],
  };
}

/** The policy `canConfine` is asked about: the one the spawn will carry. */
function policyFor(
  row: UserMcpConnectorRow,
  read: readonly string[],
  net: readonly string[],
  grant: PreparedUserMcpWriteGrant,
): SandboxPolicy {
  const parts = userMcpWriteManifestParts(read, grant);
  return {
    id: userMcpPolicyId(row.service_id),
    permissions: { network: [...net], filesystem: { read: parts.read, write: [...parts.write] } },
    ...(parts.canonicalWritePaths === undefined
      ? {}
      : { canonicalWritePaths: parts.canonicalWritePaths }),
    ...(parts.canonicalWriteDirs === undefined
      ? {}
      : { canonicalWriteDirs: parts.canonicalWriteDirs }),
  };
}

/**
 * At REGISTRATION, before the owner is asked: can this OS's sandbox confine these write directories
 * at all (owner ruling OR-AD-30)? The policy asked about is the one a spawn would carry. `null` when
 * it can; otherwise the fixed reason. An OS that cannot confine the grant never stores one.
 */
export function userMcpWriteConfineRefusal(
  registration: {
    readonly serviceId: string;
    readonly readPaths: readonly string[];
    readonly netHosts: readonly string[];
    readonly writePaths: readonly string[];
  },
  canConfine: (policy: SandboxPolicy) => string | null,
): string | null {
  if (registration.writePaths.length === 0) return null;
  const row = { service_id: registration.serviceId } as UserMcpConnectorRow;
  try {
    return canConfine(
      policyFor(
        row,
        registration.readPaths,
        registration.netHosts,
        prepared(registration.writePaths),
      ),
    );
  } catch {
    return "the sandbox could not be asked whether it can confine a write directory";
  }
}

/**
 * Windows: revoke what an earlier spawn of this id was granted and this one is not, then record
 * this spawn's paths. An entry leaves the ledger only after a revoke of it succeeded.
 */
async function settleWindowsLedger(
  serviceId: string,
  current: UserMcpLedgerEntry,
  deps: UserMcpWriteGrantDeps,
): Promise<string | undefined> {
  const revoker = deps.revokerFor(userMcpPolicyId(serviceId));
  if (!revoker.active) return undefined;
  let all: UserMcpLedger;
  try {
    all = deps.ledger.load();
  } catch {
    return USER_MCP_WRITE_GRANT_REFUSALS.ledgerUnreadable;
  }
  const earlier = all[serviceId] ?? { paths: [], writable: [] };
  if (earlier.paths.length === 0 && current.paths.length === 0) return undefined;
  // Stale: a path this spawn is not granted at all, AND a path it keeps but may no longer WRITE
  // (the helper would only add read to the existing permission, leaving the write right in place).
  const keep = new Set(current.paths);
  const keepWrite = new Set(current.writable);
  const stale = [
    ...new Set([
      ...earlier.paths.filter((p) => !keep.has(p)),
      ...earlier.writable.filter((p) => !keepWrite.has(p)),
    ]),
  ];
  if (stale.length > 0) {
    try {
      await revoker.revoke(stale);
    } catch {
      return USER_MCP_WRITE_GRANT_REFUSALS.revokeFailed;
    }
  }
  const same =
    stale.length === 0 &&
    earlier.paths.length === current.paths.length &&
    earlier.writable.length === current.writable.length;
  if (same) return undefined;
  try {
    const next: Record<string, UserMcpLedgerEntry> = { ...all };
    if (current.paths.length === 0) delete next[serviceId];
    else next[serviceId] = { paths: [...current.paths], writable: [...current.writable] };
    deps.ledger.save(next);
  } catch {
    return USER_MCP_WRITE_GRANT_REFUSALS.ledgerWriteFailed;
  }
  return undefined;
}

/**
 * Decides the write grant of ONE spawn of `row`. `read` and `net` are the row's parsed read paths
 * and hosts (the caller has already parsed them). Never throws.
 */
export async function prepareUserMcpWriteGrant(
  row: UserMcpConnectorRow,
  read: readonly string[],
  net: readonly string[],
  deps: UserMcpWriteGrantDeps,
): Promise<PrepareUserMcpWriteGrantResult> {
  const no = (reason: string): PrepareUserMcpWriteGrantResult => ({ ok: false, reason });
  // 1. The stored list.
  const stored = storedWriteDirs(row, deps.writeDir.platform);
  if (!stored.ok) return no(stored.reason);
  // 2. Each directory, with the facts as they are now.
  for (const dir of stored.dirs) {
    const checked = writeDirRefusal(dir, "spawn", deps.writeDir);
    if (!checked.ok) return no(checked.reason);
  }
  const grant = stored.dirs.length === 0 ? NO_USER_MCP_WRITE_GRANT : prepared(stored.dirs);
  // 3. The sandbox of this OS, for the exact policy.
  if (grant.dirs.length > 0) {
    let cannot: string | null;
    try {
      cannot = deps.canConfine(policyFor(row, read, net, grant));
    } catch {
      cannot = "the sandbox could not be asked whether it can confine a write directory";
    }
    if (cannot !== null) return no(cannot);
  }
  // 4. Windows: the ledger, before any client exists.
  const parts = userMcpWriteManifestParts(read, grant);
  const failed = await settleWindowsLedger(
    row.service_id,
    { paths: parts.read, writable: parts.write },
    deps,
  );
  if (failed !== undefined) return no(failed);
  return { ok: true, grant };
}

/**
 * Windows: revoke every path the ledger records for `serviceId` and drop its entry. Returns `false`
 * when the ledger could not be read or the revoke failed (the entry then stays, as a debt the next
 * spawn, the next registration of the id or the boot step settles). Never throws.
 */
export async function releaseUserMcpGrants(
  serviceId: string,
  deps: Pick<UserMcpWriteGrantDeps, "ledger" | "revokerFor">,
): Promise<boolean> {
  const revoker = deps.revokerFor(userMcpPolicyId(serviceId));
  if (!revoker.active) return true;
  try {
    const all = deps.ledger.load();
    const entry = all[serviceId];
    if (entry === undefined) return true;
    if (entry.paths.length > 0) await revoker.revoke(entry.paths);
    const next: Record<string, UserMcpLedgerEntry> = { ...all };
    delete next[serviceId];
    deps.ledger.save(next);
    return true;
  } catch {
    return false;
  }
}

/** The service ids the ledger records; `undefined` when it cannot be read. */
export function ledgerServiceIds(ledger: UserMcpGrantLedgerStore): readonly string[] | undefined {
  try {
    return Object.keys(ledger.load());
  } catch {
    return undefined;
  }
}
