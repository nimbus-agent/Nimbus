// packages/gateway/src/connectors/connector-writes/iac-grants.ts
// The owner's approved IaC scope (Phase 9.7 D2, invariant I54, V85 `connector_write_iac_grant`):
// which directories Terraform may run in, which clouds' credentials and hosts the plan/apply
// children get, and the owner's extra hosts. Written only by the HITL-gated
// `connector.writes.enable iac` handler (it replaces the whole set); read fresh by the runner for
// every child it starts. This module also holds the two path rules that decide a directory:
//
//  - {@link approveWorkdir}: at approval time, a typed directory is canonicalised and refused for
//    every reason in the plan's table (section 2.4), so what is stored is a plain, real,
//    ASCII-typeable absolute path that no Nimbus-owned or system-wide directory overlaps;
//  - {@link gateWorkdir}: at gate time, the caller's directory must be BYTE-FOR-BYTE its own
//    canonical form (so no `..`, link, 8.3 alias or case variant: the typed confirm text and the
//    prompt show exactly what the connector receives) and equal to, or inside, a stored grant.
import type { Database } from "bun:sqlite";

import { dbRun } from "../../db/write.ts";
import { findProtectedOverlap, isSameOrInside, pathApiFor } from "../../util/path-overlap.ts";
import { isConfirmChar } from "./confirm-template.ts";
import { IAC_LIMITS, terraformInputRefusal } from "./iac-limits.ts";

export const IAC_CLOUDS = ["aws", "azure", "gcp"] as const;
export type IacCloud = (typeof IAC_CLOUDS)[number];

/** What `enable iac` approved. All lists are sorted and de-duplicated. */
export interface IacGrants {
  /** Canonical absolute directories. */
  readonly workdirs: readonly string[];
  readonly clouds: readonly IacCloud[];
  /** Extra AWS regions beyond the Vault default (plain region names). */
  readonly regions: readonly string[];
  /** Extra hosts the owner typed (`host` or `host:port`). */
  readonly net: readonly string[];
}

export const EMPTY_IAC_GRANTS: IacGrants = Object.freeze({
  workdirs: Object.freeze([]) as readonly string[],
  clouds: Object.freeze([]) as readonly IacCloud[],
  regions: Object.freeze([]) as readonly string[],
  net: Object.freeze([]) as readonly string[],
});

type Kind = "workdir" | "cloud" | "region" | "net";

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isCloud(v: string): v is IacCloud {
  return (IAC_CLOUDS as readonly string[]).includes(v);
}

/** The stored grants. A value the closed lists no longer accept (a cloud) is dropped: fail closed. */
export function getIacGrants(db: Database): IacGrants {
  const rows = db.query("SELECT kind, value FROM connector_write_iac_grant").all() as Array<{
    kind: Kind;
    value: string;
  }>;
  const of = (k: Kind): string[] => rows.filter((r) => r.kind === k).map((r) => r.value);
  return {
    workdirs: sortedUnique(of("workdir")),
    clouds: sortedUnique(of("cloud").filter(isCloud)),
    regions: sortedUnique(of("region")),
    net: sortedUnique(of("net")),
  };
}

/** Replaces the whole stored set (re-enabling replaces, it never merges). */
export function setIacGrants(db: Database, grants: IacGrants, now: number): void {
  const insert = (kind: Kind, values: readonly string[]): void => {
    for (const value of sortedUnique(values)) {
      dbRun(
        db,
        "INSERT INTO connector_write_iac_grant (kind, value, approved_at) VALUES (?, ?, ?)",
        [kind, value, now],
      );
    }
  };
  db.transaction(() => {
    dbRun(db, "DELETE FROM connector_write_iac_grant");
    insert("workdir", grants.workdirs);
    insert("cloud", grants.clouds);
    insert("region", grants.regions);
    insert("net", grants.net);
  })();
}

/** Drops every grant (narrowing needs no approval). True when something was stored. */
export function removeIacGrants(db: Database): boolean {
  return dbRun(db, "DELETE FROM connector_write_iac_grant").changes > 0;
}

// ---------------------------------------------------------------------------------------------
// The path rules.

export const IAC_WORKDIR_REFUSALS = Object.freeze({
  notAbsolute: "the directory must be an absolute path",
  deviceOrUnc: "a UNC, device or alternate-data-stream path cannot be approved",
  notFound: "the directory does not exist",
  notADirectory: "that path is not a directory",
  root: "a filesystem root, a drive root, or a folder that holds your home or temp folder cannot be approved",
  protected: "the directory overlaps a folder Nimbus owns",
  notTypeable:
    "the path has a character that cannot be typed in a confirm text (use plain ASCII letters, digits, spaces and _ - . / \\ : # @ !)",
  tooLong: "the path is too long to type in a confirm text",
  terraformDir: "the directory is or is inside a .terraform folder",
  shape: "the path is not a plain absolute path",
});
export type IacWorkdirRefusal = (typeof IAC_WORKDIR_REFUSALS)[keyof typeof IAC_WORKDIR_REFUSALS];

/** The facts both path rules read; production wires the real filesystem, tests inject. */
export interface IacPathDeps {
  readonly platform: NodeJS.Platform;
  /** The kernel's view of the path (links, junctions and 8.3 names resolved); throws when missing. */
  readonly realpath: (p: string) => string;
  readonly isDirectory: (p: string) => boolean;
  readonly homeDir: string;
  readonly tmpDir: string;
  /** Nimbus's own folders: data, config, sandbox, the iac root, the extensions dir. */
  readonly protectedRoots: readonly string[];
}

function isDeviceOrUnc(p: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  if (p.startsWith("\\\\") || p.startsWith("//")) return true; // UNC, `\\?\`, `\\.\`
  // A drive letter's colon is the only colon a plain Windows path has (anything else is a stream).
  return p.slice(2).includes(":");
}

function typeable(p: string): boolean {
  for (const ch of p) {
    const cp = ch.codePointAt(0) ?? 0;
    if (!isConfirmChar(cp) || cp === 0x3d) return false;
  }
  return true;
}

function hasTerraformSegment(p: string, platform: NodeJS.Platform): boolean {
  const lower = (s: string): string => (platform === "win32" ? s.toLowerCase() : s);
  return p.split(/[\\/]+/).some((s) => lower(s) === ".terraform");
}

function isRootOf(p: string, platform: NodeJS.Platform): boolean {
  const api = pathApiFor(platform);
  return api.parse(p).root === p || api.dirname(p) === p;
}

/** Is `p` the same as, or an ancestor of, `other`? */
function holds(platform: NodeJS.Platform, p: string, other: string): boolean {
  return isSameOrInside(platform, other, p);
}

/**
 * At approval time: the canonical form of the typed directory, or why it cannot be approved. The
 * order is cheapest-first and every reason is a fixed sentence the enable error shows.
 */
export function approveWorkdir(
  raw: string,
  deps: IacPathDeps,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
  const api = pathApiFor(deps.platform);
  const no = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });
  if (typeof raw !== "string" || !api.isAbsolute(raw)) return no(IAC_WORKDIR_REFUSALS.notAbsolute);
  if (isDeviceOrUnc(raw, deps.platform)) return no(IAC_WORKDIR_REFUSALS.deviceOrUnc);
  let canonical: string;
  try {
    canonical = deps.realpath(raw);
  } catch {
    return no(IAC_WORKDIR_REFUSALS.notFound);
  }
  if (isDeviceOrUnc(canonical, deps.platform)) return no(IAC_WORKDIR_REFUSALS.deviceOrUnc);
  if (!deps.isDirectory(canonical)) return no(IAC_WORKDIR_REFUSALS.notADirectory);
  if (canonical.length > IAC_LIMITS.maxWorkdirChars) return no(IAC_WORKDIR_REFUSALS.tooLong);
  if (!typeable(canonical)) return no(IAC_WORKDIR_REFUSALS.notTypeable);
  if (isRootOf(canonical, deps.platform)) return no(IAC_WORKDIR_REFUSALS.root);
  if (
    holds(deps.platform, canonical, deps.homeDir) ||
    holds(deps.platform, canonical, deps.tmpDir)
  ) {
    return no(IAC_WORKDIR_REFUSALS.root);
  }
  if (
    findProtectedOverlap(canonical, deps.protectedRoots, deps.platform, deps.realpath) !== undefined
  ) {
    return no(IAC_WORKDIR_REFUSALS.protected);
  }
  if (hasTerraformSegment(canonical, deps.platform)) return no(IAC_WORKDIR_REFUSALS.terraformDir);
  if (terraformInputRefusal({ workingDirectory: canonical }) !== undefined) {
    return no(IAC_WORKDIR_REFUSALS.shape);
  }
  return { ok: true, path: canonical };
}

/**
 * At gate time: `input` must already BE its own canonical form (byte for byte), be a directory,
 * and be equal to or inside a stored grant (segment compare; case-insensitive on win32 and darwin).
 * Returns the canonical path (the same string) or `undefined`; the caller maps `undefined` to the
 * fixed `notApprovedDirectory` refusal, never echoing the path.
 */
export function gateWorkdir(
  input: unknown,
  grants: IacGrants,
  deps: IacPathDeps,
): string | undefined {
  if (
    typeof input !== "string" ||
    terraformInputRefusal({ workingDirectory: input }) !== undefined
  ) {
    return undefined;
  }
  let canonical: string;
  try {
    canonical = deps.realpath(input);
  } catch {
    return undefined;
  }
  if (canonical !== input || !deps.isDirectory(canonical)) return undefined;
  const insensitive = deps.platform === "win32" || deps.platform === "darwin";
  const norm = (p: string): string => (insensitive ? p.toLowerCase() : p);
  const api = pathApiFor(deps.platform);
  for (const granted of grants.workdirs) {
    const rel = api.relative(norm(granted), norm(canonical));
    if (rel === "" || (!api.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${api.sep}`))) {
      return canonical;
    }
  }
  return undefined;
}
