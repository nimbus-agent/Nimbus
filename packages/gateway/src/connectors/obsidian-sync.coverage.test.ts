/**
 * Obsidian paths the main suite does not reach: a cursor that is not the indexer's own
 * `{"tip": <ms>}` JSON, and a note that is discovered but cannot be read.
 *
 * The unreadable-note test is SELF-VALIDATING rather than platform-gated: it removes every
 * permission bit from one note and then checks whether that actually made the note unreadable for
 * this process. On Linux/macOS as a normal user it does, and the note must be skipped while the
 * rest of the vault still indexes. On Windows (where mode bits do not gate reads) or as root it
 * does not, and the note must simply be indexed like the others. Either way the assertion follows
 * from the observed premise, so the test can never pass for the wrong reason.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createObsidianSyncable } from "./obsidian-sync.ts";

let root: string;
let db: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "obsidian-sync-cov-"));
  mkdirSync(join(root, ".obsidian"));
  writeFileSync(join(root, "A.md"), "# A\nlinks to [[B]]");
  writeFileSync(join(root, "B.md"), "# B\nback to [[A]]");
  db = createMemoryIndexDb();
});

afterEach(() => {
  db.close();
  // Put the mode back first so the recursive delete never depends on it.
  chmodSync(join(root, "B.md"), 0o644);
  rmSync(root, { recursive: true, force: true });
});

function rootCfg(path: string): NimbusFilesystemRootToml {
  return {
    path,
    gitAware: false,
    codeIndex: false,
    dependencyGraph: false,
    mediaIndex: false,
    exclude: [],
  };
}

function notePaths(): string[] {
  return (
    db.query("SELECT path FROM obsidian_notes ORDER BY path").all() as { path: string }[]
  ).map((r) => r.path);
}

function canOpenForRead(path: string): boolean {
  try {
    closeSync(openSync(path, "r"));
    return true;
  } catch {
    return false;
  }
}

describe("obsidian-sync — foreign cursors", () => {
  test("a non-JSON cursor, or one whose tip is not a number, re-reads every note", async () => {
    const syncable = createObsidianSyncable({ roots: [rootCfg(root)] });
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian");
    const first = await syncable.sync(ctx, null);
    expect(first.itemsUpserted).toBe(2);

    // Control: the indexer's own cursor skips the unchanged notes.
    const resumed = await syncable.sync(ctx, first.cursor);
    expect(resumed.itemsUpserted).toBe(0);

    for (const foreign of ["not-json{", '{"tip":"yesterday"}', "[]"]) {
      const res = await syncable.sync(ctx, foreign);
      expect(res.itemsUpserted).toBe(2);
      expect(res.cursor).toBe(first.cursor);
    }
  });
});

describe("obsidian-sync — a note that cannot be read", () => {
  test("is skipped while the rest of the vault still indexes (when the OS really denies the read)", async () => {
    const unreadable = join(root, "B.md");
    chmodSync(unreadable, 0o000);
    const denied = !canOpenForRead(unreadable);

    const res = await createObsidianSyncable({ roots: [rootCfg(root)] }).sync(
      syncTestContext(db, EMPTY_NIMBUS_VAULT, "obsidian"),
      null,
    );

    const tipOfA = statSync(join(root, "A.md")).mtimeMs;
    if (denied) {
      expect(res.itemsUpserted).toBe(1);
      expect(notePaths()).toEqual(["A.md"]);
      // The cursor advances only as far as the note that was actually read.
      expect(JSON.parse(res.cursor ?? "{}")).toEqual({ tip: tipOfA });
    } else {
      expect(res.itemsUpserted).toBe(2);
      expect(notePaths()).toEqual(["A.md", "B.md"]);
    }
  });
});
