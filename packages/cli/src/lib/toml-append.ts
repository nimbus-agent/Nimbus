import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

export type AppendRootResult = {
  status: "added" | "already-present";
  tomlPath: string;
  backupPath?: string;
};

const FILESYSTEM_ROOTS_HEADER = "[[filesystem.roots]]";

/**
 * Render a path for the TOML file so it needs no backslash escaping.
 *
 * On Windows this rewrites `C:\repo` to `C:/repo`. That matters because
 * NOTHING un-escapes `\\` on the way back in: neither `hasFilesystemRoot`
 * below nor the gateway's own `parseString` (`config/filesystem-toml.ts`).
 * Emitting `\\` therefore relies on `resolve()` collapsing the doubled
 * separators afterwards — which is true on Windows and FALSE on POSIX, where a
 * backslash is an ordinary filename character. Removing the escapes at the
 * source makes the round-trip hold by construction on every platform instead of
 * by a Windows-only accident. Splitting on `sep` rather than on a literal `\`
 * is what keeps it safe on POSIX: there `sep` is `/`, so a filename that
 * genuinely contains a backslash is left intact rather than being split into
 * two components.
 */
function toTomlPath(absolute: string): string {
  return absolute.split(sep).join("/");
}

/**
 * Reverse TOML basic-string escaping.
 *
 * The writer no longer emits `\\`, but a hand-written or older config still
 * can, and the comparison has to agree with what the user meant. Order
 * matters: `\\` must be consumed before `\"`, or `\\"` would be misread as an
 * escaped quote.
 */
function unescapeTomlBasicString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "\\" && i + 1 < raw.length) {
      const next = raw[i + 1];
      if (next === "\\" || next === '"') {
        out += next;
        i += 1;
        continue;
      }
    }
    out += raw[i];
  }
  return out;
}

/**
 * Is `rootPath` already configured as a filesystem root in this TOML source?
 *
 * Deliberately narrow. The CLI cannot import the gateway's TOML parser (IPC-only
 * boundary), so this answers exactly one question rather than pretending to be a
 * parser. Comments are stripped first so a commented-out example root does not
 * make `init` believe it has already run.
 */
export function hasFilesystemRoot(source: string, rootPath: string): boolean {
  const target = resolve(rootPath);
  let table = "";
  for (const line of source.split(/\r?\n/)) {
    const hash = line.indexOf("#");
    const code = (hash < 0 ? line : line.slice(0, hash)).trim();

    // Track the current table so a `path = …` under some OTHER section can never
    // be mistaken for a configured root. Only `[[filesystem.roots]]` defines a
    // `path` key today, so this is latent rather than live — but it is a few
    // lines for correct-by-construction instead of correct-by-coincidence, and
    // the failure mode it prevents is silent: `init` would report "already
    // configured" and never add the root.
    if (code.startsWith("[") && code.endsWith("]")) {
      table = code;
      continue;
    }
    if (table !== FILESYSTEM_ROOTS_HEADER) {
      continue;
    }
    const eq = code.indexOf("=");
    if (eq <= 0 || code.slice(0, eq).trim() !== "path") {
      continue;
    }
    const raw = code.slice(eq + 1).trim();
    if (raw.length < 2) {
      continue;
    }

    // Un-escape BEFORE resolving. Relying on resolve() to collapse doubled
    // separators only works on Windows; on POSIX a backslash is an ordinary
    // filename character, so `\\` would survive as two characters and the
    // comparison would miss. Pinned by the Windows-style-path test, which runs
    // on every platform in the matrix.
    if (resolve(unescapeTomlBasicString(raw.slice(1, -1))) === target) {
      return true;
    }
  }
  return false;
}

/**
 * Add a `[[filesystem.roots]]` block to nimbus.toml by APPENDING.
 *
 * Append-only on purpose. Config parsing in the gateway is a bespoke section
 * scanner, not a round-trippable TOML library, so there is no serializer to
 * write back through — and a parse/serialize cycle would strip the user's
 * comments and reorder their keys. Appending cannot do either.
 */
export function appendFilesystemRoot(configDir: string, rootPath: string): AppendRootResult {
  const tomlPath = join(configDir, "nimbus.toml");
  const target = resolve(rootPath);

  if (existsSync(tomlPath) && hasFilesystemRoot(readFileSync(tomlPath, "utf8"), target)) {
    return { status: "already-present", tomlPath };
  }

  mkdirSync(configDir, { recursive: true });

  let backupPath: string | undefined;
  let prefix = "";
  if (existsSync(tomlPath)) {
    backupPath = `${tomlPath}.bak`;
    copyFileSync(tomlPath, backupPath);
    const current = readFileSync(tomlPath, "utf8");
    prefix = current.endsWith("\n") || current === "" ? "" : "\n";
  }

  // JSON.stringify gives correct TOML escaping for a basic string; toTomlPath
  // means there are no separators left for it to escape.
  const block = [
    "",
    FILESYSTEM_ROOTS_HEADER,
    `path = ${JSON.stringify(toTomlPath(target))}`,
    "git_aware = true",
    "code_index = true",
    "",
  ].join("\n");

  writeFileSync(tomlPath, prefix + block, { encoding: "utf8", flag: "a" });
  return backupPath === undefined
    ? { status: "added", tomlPath }
    : { status: "added", tomlPath, backupPath };
}
