// packages/gateway/src/connectors/write-dir-rules.ts
// Where a directory may be for a user MCP server to WRITE it (I15; Phase 28 AD5b; owner rulings
// OR-AD-28 and OR-AD-29). ONE function, `writeDirRefusal`, for the registration and for every
// spawn, so a grant stored before a rule existed (or before a folder became protected) is refused
// at the next spawn too. Pure: every file-system and environment fact comes through `deps`.
//
// The order is cheapest first, and each refusal is a fixed sentence (no path is echoed):
//   1. the spelling: absolute, no UNC, device or stream path, no quote, control character or break;
//   2. the kind: it exists, it is a directory, and the path itself is not a link;
//   3. the canonical form: at registration the typed path is replaced by it; at a spawn the stored
//      path must BE it, byte for byte (so a link, junction, 8.3 alias or case variant on the way in
//      is refused);
//   4. the placement: not a root, not a folder that is or holds home or temp, not a direct child of
//      home, not inside a hidden home folder, `~/Library`, `%APPDATA%` or `%LOCALAPPDATA%` (the temp
//      folder excepted), not on `PATH`;
//   5. the overlaps, in both directions: Nimbus's own folders, an approved iac working directory,
//      any registered server's code;
//   6. the markers above it (the directory is inside a repository or a vault), then the tree rule.
import { WRITE_DIR_MARKER_NAMES, type WriteDirScan } from "../platform/sandbox/write-dir-scan.ts";
import {
  findProtectedOverlap,
  isDeviceOrUnc,
  isRootOf,
  isSameOrInside,
  pathApiFor,
  pathsOverlap,
} from "../util/path-overlap.ts";

/** What the rule needs of an `lstat` (the path itself, never followed). */
export interface WriteDirKind {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface WriteDirDeps {
  readonly platform: NodeJS.Platform;
  /** The kernel's view of the path (links, junctions and 8.3 names resolved); throws when missing. */
  readonly realpath: (p: string) => string;
  /** `lstat`: throws when the path does not exist. */
  readonly lstat: (p: string) => WriteDirKind;
  /** Does this exact path exist (an `lstat` that did not throw)? Used for the markers above. */
  readonly exists: (p: string) => boolean;
  readonly homeDir: string;
  readonly tmpDir: string;
  /** The gateway's `PATH` entries, already split. */
  readonly pathEntries: readonly string[];
  /** Windows `%APPDATA%` and `%LOCALAPPDATA%`; empty elsewhere. */
  readonly appDataDirs: readonly string[];
  /** Nimbus's own folders, read now: data, config, sandbox, extensions, cache, iac, logs. */
  readonly protectedRoots: () => readonly string[];
  /** The owner-approved iac working directories, read now. */
  readonly iacWorkdirs: () => readonly string[];
  /** Every registered server's command directory and absolute arguments, read now. */
  readonly serverCodePaths: () => readonly string[];
  /** The tree rule; production wires `scanWriteDir`. */
  readonly scan: (dir: string) => WriteDirScan;
}

export const WRITE_DIR_REFUSALS = Object.freeze({
  notAbsolute: "a write directory must be an absolute path",
  deviceOrUnc: "a network, device or stream path cannot be a write directory",
  badCharacter: "the path has a quote, a control character or a line break",
  notFound: "that directory does not exist",
  notADirectory: "that path is not a directory",
  link: "that path is a link; name the real directory",
  moved:
    "the directory is no longer at the exact path that was approved (a link, an alias or a renamed folder is on the way)",
  root: "a filesystem root, a drive root, or a folder that holds your home or temp folder cannot be a write directory",
  homeChild:
    "a folder directly inside your home folder cannot be a write directory; name a folder inside it",
  hiddenHome:
    "a hidden folder in your home folder, your Library folder or your application-data folder cannot hold a write directory",
  onPath: "a folder on PATH, holding one or inside one cannot be a write directory",
  protected: "the directory overlaps a folder Nimbus owns",
  iacWorkdir: "the directory overlaps a working directory approved for infrastructure writes",
  serverCode: "the directory overlaps the code of a registered MCP server",
  insideMarker:
    "the directory is inside a Git repository, a vault or an editor workspace (a .git, .obsidian or similar folder is above it)",
  marker: "the directory holds a .git, .obsidian, editor or other marker folder, or is one",
  treeLink: "the directory holds a link",
  treeMultiLink: "the directory holds a file that has a second name (a hard link)",
  treeSpecial: "the directory holds an entry that is neither a file nor a folder",
  treeOverCap: "the directory is too large or too deep to check (over 50,000 entries or 16 levels)",
  treeUnreadable: "the directory, or something in it, could not be read",
});
export type WriteDirRefusal = (typeof WRITE_DIR_REFUSALS)[keyof typeof WRITE_DIR_REFUSALS];

const SCAN_REFUSALS: Readonly<Record<Exclude<WriteDirScan, "clean">, WriteDirRefusal>> =
  Object.freeze({
    marker: WRITE_DIR_REFUSALS.marker,
    link: WRITE_DIR_REFUSALS.treeLink,
    "multi-link": WRITE_DIR_REFUSALS.treeMultiLink,
    special: WRITE_DIR_REFUSALS.treeSpecial,
    "over-cap": WRITE_DIR_REFUSALS.treeOverCap,
    unreadable: WRITE_DIR_REFUSALS.treeUnreadable,
  });

export type WriteDirResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: WriteDirRefusal };

/** A quote (it would end an SBPL string), a C0 or C1 control character, DEL, or a line separator. */
function hasBadCharacter(p: string): boolean {
  for (const ch of p) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x22 || cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) {
      return true;
    }
  }
  return false;
}

/** Is `p` the same as, or an ancestor of, `other`? */
function holds(platform: NodeJS.Platform, p: string, other: string): boolean {
  return other !== "" && isSameOrInside(platform, other, p);
}

/** The canonical form of a configured folder, or its spelling when it does not exist. */
function canonicalOr(p: string, deps: WriteDirDeps): string {
  try {
    return deps.realpath(p);
  } catch {
    return p;
  }
}

function placementRefusal(canonical: string, deps: WriteDirDeps): WriteDirRefusal | undefined {
  const { platform } = deps;
  const api = pathApiFor(platform);
  if (isRootOf(canonical, platform)) return WRITE_DIR_REFUSALS.root;
  const home = canonicalOr(deps.homeDir, deps);
  const tmp = canonicalOr(deps.tmpDir, deps);
  if (holds(platform, canonical, home) || holds(platform, canonical, tmp)) {
    return WRITE_DIR_REFUSALS.root;
  }
  // The temp folder is the one place inside a hidden or application-data folder that is allowed
  // (on Windows it is `%LOCALAPPDATA%\Temp`): scratch space, where nothing of the owner's lives.
  const inTmp = tmp !== "" && isSameOrInside(platform, canonical, tmp);
  if (home !== "" && isSameOrInside(platform, canonical, home) && !inTmp) {
    const rel = api.relative(home, canonical);
    const segments = rel.split(api.sep).filter((s) => s !== "");
    const first = segments[0] ?? "";
    if (segments.length === 1) return WRITE_DIR_REFUSALS.homeChild;
    if (first.startsWith(".")) return WRITE_DIR_REFUSALS.hiddenHome;
    if (platform === "darwin" && first.toLowerCase() === "library") {
      return WRITE_DIR_REFUSALS.hiddenHome;
    }
  }
  if (!inTmp) {
    for (const dir of deps.appDataDirs) {
      if (dir !== "" && pathsOverlap(platform, canonical, canonicalOr(dir, deps))) {
        return WRITE_DIR_REFUSALS.hiddenHome;
      }
    }
  }
  for (const entry of deps.pathEntries) {
    if (entry === "" || !api.isAbsolute(entry)) continue;
    if (pathsOverlap(platform, canonical, canonicalOr(entry, deps))) {
      return WRITE_DIR_REFUSALS.onPath;
    }
  }
  return undefined;
}

function overlapRefusal(canonical: string, deps: WriteDirDeps): WriteDirRefusal | undefined {
  const { platform, realpath } = deps;
  if (findProtectedOverlap(canonical, deps.protectedRoots(), platform, realpath) !== undefined) {
    return WRITE_DIR_REFUSALS.protected;
  }
  if (findProtectedOverlap(canonical, deps.iacWorkdirs(), platform, realpath) !== undefined) {
    return WRITE_DIR_REFUSALS.iacWorkdir;
  }
  if (findProtectedOverlap(canonical, deps.serverCodePaths(), platform, realpath) !== undefined) {
    return WRITE_DIR_REFUSALS.serverCode;
  }
  return undefined;
}

/**
 * A marker entry in a folder ABOVE the directory: it sits inside a repository or a vault. The walk
 * stops BELOW the home folder: a `.vscode` or `.git` directly in home is the owner's profile (an
 * editor's extensions folder, a dotfiles repository), which nearly every developer has, and not a
 * workspace this directory belongs to. Stated bound.
 */
function markerAbove(canonical: string, deps: WriteDirDeps): boolean {
  const api = pathApiFor(deps.platform);
  const home = canonicalOr(deps.homeDir, deps);
  const sameAsHome = (d: string): boolean =>
    home !== "" && isSameOrInside(deps.platform, d, home) && isSameOrInside(deps.platform, home, d);
  let dir = api.dirname(canonical);
  for (;;) {
    if (sameAsHome(dir)) return false;
    for (const name of WRITE_DIR_MARKER_NAMES) {
      if (deps.exists(api.join(dir, name))) return true;
    }
    const parent = api.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * May `path` be a write directory? `register`: `path` is what the owner typed, and the answer
 * carries its canonical form, which is what the prompt shows and the row stores. `spawn`: `path`
 * is the stored value and must already be its own canonical form.
 */
export function writeDirRefusal(
  path: string,
  mode: "register" | "spawn",
  deps: WriteDirDeps,
): WriteDirResult {
  const no = (reason: WriteDirRefusal): WriteDirResult => ({ ok: false, reason });
  const api = pathApiFor(deps.platform);
  // 1. The spelling.
  if (typeof path !== "string" || !api.isAbsolute(path)) return no(WRITE_DIR_REFUSALS.notAbsolute);
  if (isDeviceOrUnc(path, deps.platform)) return no(WRITE_DIR_REFUSALS.deviceOrUnc);
  if (hasBadCharacter(path)) return no(WRITE_DIR_REFUSALS.badCharacter);
  // 2. The kind, of the path itself.
  let kind: WriteDirKind;
  try {
    kind = deps.lstat(path);
  } catch {
    return no(WRITE_DIR_REFUSALS.notFound);
  }
  if (kind.isSymbolicLink()) return no(WRITE_DIR_REFUSALS.link);
  if (!kind.isDirectory()) return no(WRITE_DIR_REFUSALS.notADirectory);
  // 3. The canonical form.
  let canonical: string;
  try {
    canonical = deps.realpath(path);
  } catch {
    return no(WRITE_DIR_REFUSALS.notFound);
  }
  if (mode === "spawn" && canonical !== path) return no(WRITE_DIR_REFUSALS.moved);
  if (isDeviceOrUnc(canonical, deps.platform)) return no(WRITE_DIR_REFUSALS.deviceOrUnc);
  if (hasBadCharacter(canonical)) return no(WRITE_DIR_REFUSALS.badCharacter);
  // 4. The placement. 5. The overlaps.
  const placed = placementRefusal(canonical, deps) ?? overlapRefusal(canonical, deps);
  if (placed !== undefined) return no(placed);
  // 6. The markers above, then the tree (last: it walks).
  if (markerAbove(canonical, deps)) return no(WRITE_DIR_REFUSALS.insideMarker);
  const verdict = deps.scan(canonical);
  if (verdict !== "clean") return no(SCAN_REFUSALS[verdict]);
  return { ok: true, path: canonical };
}

/** Do two canonical write directories overlap (equal, or one inside the other)? */
export function writeDirsOverlap(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string): string => (platform === "darwin" ? p.toLowerCase() : p);
  return pathsOverlap(platform, norm(a), norm(b));
}

/** The most write directories one server may have (owner ruling OR-AD-34). */
export const MAX_WRITE_DIRS = 4;
