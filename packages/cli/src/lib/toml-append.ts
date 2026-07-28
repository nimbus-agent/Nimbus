import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type AppendRootResult = {
  status: "added" | "already-present";
  tomlPath: string;
  backupPath?: string;
};

const FILESYSTEM_ROOTS_HEADER = "[[filesystem.roots]]";

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

    // `resolve()` is load-bearing, not cosmetic: on Windows the writer emits
    // TOML `\\` escapes which the gateway's parseString does NOT un-escape, so
    // this value can carry doubled separators. resolve() normalises them, which
    // is why the round-trip holds. Pinned by the Windows test in the suite.
    if (resolve(raw.slice(1, -1)) === target) {
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

  // JSON.stringify gives correct TOML escaping for a basic string.
  const block = [
    "",
    FILESYSTEM_ROOTS_HEADER,
    `path = ${JSON.stringify(target)}`,
    "git_aware = true",
    "code_index = true",
    "",
  ].join("\n");

  writeFileSync(tomlPath, prefix + block, { encoding: "utf8", flag: "a" });
  return backupPath === undefined
    ? { status: "added", tomlPath }
    : { status: "added", tomlPath, backupPath };
}
