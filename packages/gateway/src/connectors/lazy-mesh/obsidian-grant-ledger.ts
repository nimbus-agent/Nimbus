// packages/gateway/src/connectors/lazy-mesh/obsidian-grant-ledger.ts
// The persisted ledger of every path the Obsidian sandbox was handed a WRITE grant on (I15, B4b).
//
// Why it exists: on Windows an AppContainer ACE outlives its child and the gateway, so a write
// grant made before a crash or a restart must still be revoked afterwards, even when the vault it
// named is no longer discovered (its `.obsidian` removed, its root dropped from config). The ledger
// is written BEFORE the spawn that grants, and an entry leaves it only after a revoke of it
// succeeded. It is used only where ACEs persist (the revoker is active on win32).
//
// Where it lives: `<configDir>/sandbox-grants/`, which no sandboxed child is granted. Not under
// `dataDir`: the filesystem MCP holds a write grant on `dataDir`, so a child could rewrite a ledger
// kept there and hide a grant from the next revoke.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ObsidianGrantLedgerStore {
  /** The recorded paths. Missing file: `[]`. Unreadable or malformed: THROWS (fail closed). */
  load(): readonly string[];
  /** Replace the recorded paths (atomically: a temp file renamed over the old one). */
  save(paths: readonly string[]): void;
}

/** The ledger file for a given config dir. */
export function obsidianGrantLedgerFile(configDir: string): string {
  return join(configDir, "sandbox-grants", "obsidian-write-ledger.json");
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/** The production store: one JSON array of strings in `file`. */
export function fileObsidianGrantLedger(file: string): ObsidianGrantLedgerStore {
  return {
    load: () => {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (err) {
        if (isErrno(err, "ENOENT")) return [];
        throw err;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === "string")) {
        throw new Error(`the Obsidian grant ledger is malformed: ${file}`);
      }
      return parsed as string[];
    },
    save: (paths) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...paths]), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}
