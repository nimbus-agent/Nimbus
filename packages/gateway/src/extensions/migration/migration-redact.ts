/**
 * Path redaction for every connector-migration text that leaves the engine: a row's `error`, the
 * paused reason on the health row (`nimbus doctor`, `connector.listStatus`, the desktop), and a
 * refusal's message. Error texts come from the registry fetch, the install and the filesystem, any of
 * which can name the data directory, the extensions directory, a staging path or the home directory.
 *
 * Three passes, in order:
 * 1. KNOWN ROOTS, literally, longest first — with either separator, case-insensitively on Windows —
 *    together with the rest of the path that follows them. This is the pass that handles a path with
 *    a SPACE in it, such as macOS's `~/Library/Application Support/Nimbus` data root or a Windows
 *    profile named `John Smith`: no pattern can tell where such a path ends, but a known root can.
 * 2. A QUOTED span (`'…'`, `"…"`, `` `…` ``) that contains a path separator, as Node and Bun
 *    filesystem errors quote their paths. A quoted URL is kept.
 * 3. Generic absolute paths: a `file:` URL, a drive-letter or UNC path, and a POSIX path at a token
 *    start (never the `//host/path` of an `https://` URL).
 *
 * Stated bound: an unquoted absolute path with a space OUTSIDE every known root keeps the text after
 * its first space; a relative path survives; a bare word is never taken for a path.
 */
import { homedir } from "node:os";

export const PATH_PLACEHOLDER = "<path>";

/** Path characters that may follow a root (no whitespace, no quotes, no delimiters). */
const TAIL = String.raw`(?:[\\/][^\s'"` + "`" + String.raw`<>|]*)?`;
const QUOTED_RE = /(['"`])([^'"`\r\n]*[\\/][^'"`\r\n]*)\1/g;
const FILE_URL_RE = /\bfile:\/\/[^\s'"`<>]*/gi;
const WINDOWS_PATH_RE = /(?:\b[A-Za-z]:[\\/]|\\\\)[^\s'"`<>|]*/g;
const POSIX_PATH_RE = /(^|[\s'"`(=,[])\/(?!\/)[^\s'"`<>)\],]*/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every spelling of each root (both separators, no trailing separator), longest first. */
function rootSpellings(roots: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of roots) {
    const r = raw.trim().replace(/[\\/]+$/, "");
    // A root of one or two characters (`/`, `C:`) would eat every path: never a real root here.
    if (r.length < 3) continue;
    out.add(r);
    out.add(r.replaceAll("\\", "/"));
    out.add(r.replaceAll("/", "\\"));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function redactMigrationPaths(
  text: string,
  roots: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): string {
  let out = text;
  const flags = platform === "win32" ? "gi" : "g";
  for (const root of rootSpellings(roots)) {
    out = out.replace(new RegExp(`${escapeRegExp(root)}${TAIL}`, flags), PATH_PLACEHOLDER);
  }
  out = out.replace(QUOTED_RE, (m, q: string, body: string) =>
    /^[a-z][a-z0-9+.-]*:\/\//i.test(body) && !body.toLowerCase().startsWith("file:")
      ? m
      : `${q}${PATH_PLACEHOLDER}${q}`,
  );
  return out
    .replace(FILE_URL_RE, PATH_PLACEHOLDER)
    .replace(WINDOWS_PATH_RE, PATH_PLACEHOLDER)
    .replace(POSIX_PATH_RE, (_m, lead: string) => `${lead}${PATH_PLACEHOLDER}`);
}

/** The roots every migration text is redacted against, plus the owner's home directory. */
export function migrationRedactionRoots(dirs: ReadonlyArray<string | undefined>): string[] {
  let home: string | undefined;
  try {
    home = homedir();
  } catch {
    home = undefined;
  }
  return [...dirs, home].filter((d): d is string => typeof d === "string" && d !== "");
}
