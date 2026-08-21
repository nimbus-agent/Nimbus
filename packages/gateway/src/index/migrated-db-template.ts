import { Database } from "bun:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbRun } from "../db/write.ts";
import { LocalIndex } from "./local-index.ts";
import { readIndexedUserVersion } from "./migrations/runner.ts";
import { ensureSqliteVecForConnection } from "./sqlite-vec-load.ts";

/**
 * A migrated-once SQLite template that test harnesses copy instead of re-migrating.
 *
 * WHY THIS EXISTS. Hundreds of tests build a throwaway index by calling
 * `LocalIndex.ensureSchema` on a fresh file, which replays every migration from zero. That is
 * the right shape — each test gets a private database no sibling can see — but the migration
 * replay is pure repetition, and on the `windows-2025` CI runner it dominates the gateway
 * suite. Measured on a dev machine with `LocalIndex.SCHEMA_VERSION` at 55:
 *
 *   migrations only      146.5 ms
 *   vec load only          0.5 ms
 *   copy template + vec    2.7 ms   <- this module
 *   full ensureSchema    142.8 ms
 *
 * The isolation property is unchanged: every caller still gets its own file on disk. Only the
 * *construction* is shared, and it is shared through a byte copy, not a shared handle.
 *
 * WHY THE TEMPLATE IS BUILT BY `ensureSchema` AND NOT BY A HAND-LISTED MIGRATION SET. Calling
 * the production entry point is what makes the copy definitionally identical to what a caller
 * would have built itself. A hand-rolled equivalent could drift from `ensureSchema` silently,
 * which is exactly the class of bug a test harness must not introduce.
 *
 * WHY THE HANDLE IS CLOSED BEFORE THE FILE IS COPIED. An open SQLite connection may hold
 * committed pages in a `-wal` sidecar that a single-file copy would leave behind. Closing
 * checkpoints them into the main database first, so the copy is complete. `templatePath()`
 * therefore never hands back a path whose builder connection is still open.
 */

let templateDir: string | undefined;
let templateFile: string | undefined;

function templatePath(): string {
  if (templateFile !== undefined) return templateFile;

  const dir = mkdtempSync(join(tmpdir(), "nimbus-schema-tpl-"));
  const file = join(dir, "template.db");

  const db = new Database(file);
  try {
    LocalIndex.ensureSchema(db);
  } finally {
    // Checkpoints any WAL content into the main file — see the note above.
    db.close();
  }

  templateDir = dir;
  templateFile = file;
  return file;
}

/**
 * Copy the migrated template to `dbPath`, leaving the file closed.
 *
 * For callers that migrate a path and then hand it to something which opens its own handles —
 * `brief-test-server.ts` and `agent-test-server.ts` both do exactly that, and their setup
 * connection must not linger.
 */
export function materializeMigratedDb(dbPath: string): void {
  copyFileSync(templatePath(), dbPath);
}

/**
 * Drop-in replacement for `new Database(dbPath)` followed by `LocalIndex.ensureSchema(db)`.
 *
 * The per-connection work `ensureSchema` does after migrating — loading sqlite-vec and turning
 * foreign keys on — is NOT part of the file and so is redone here for the new handle. That is
 * the 2.7 ms, and skipping it would hand back a connection that behaves differently from one
 * `ensureSchema` produced.
 */
export function openMigratedDb(dbPath: string): Database {
  materializeMigratedDb(dbPath);
  const db = new Database(dbPath);
  ensureSqliteVecForConnection(db, readIndexedUserVersion(db));
  dbRun(db, "PRAGMA foreign_keys = ON");
  return db;
}

let templateBytes: Uint8Array | undefined;

/**
 * The `:memory:` counterpart of {@link openMigratedDb}, for harnesses that never wanted a file.
 *
 * `Database.deserialize` rehydrates a serialized image into a NEW in-memory database, so each
 * caller still gets a private one — the same isolation the file copy preserves. The image is
 * taken from the same on-disk template, which is what keeps the two paths from drifting: there
 * is one migrated artifact, read two ways.
 */
export function openMigratedMemoryDb(): Database {
  if (templateBytes === undefined) {
    const src = new Database(templatePath(), { readonly: true });
    try {
      templateBytes = src.serialize();
    } finally {
      src.close();
    }
  }
  const db = Database.deserialize(templateBytes);
  ensureSqliteVecForConnection(db, readIndexedUserVersion(db));
  dbRun(db, "PRAGMA foreign_keys = ON");
  return db;
}

/**
 * Remove the template directory. Registered on `exit` so a test run does not leave a temp
 * directory behind; safe to call more than once, and safe to call when no template was built.
 */
export function cleanupMigratedDbTemplate(): void {
  if (templateDir === undefined) return;
  try {
    rmSync(templateDir, { recursive: true, force: true });
  } catch {
    /* a locked file on Windows is not worth failing a test run over */
  }
  templateDir = undefined;
  templateFile = undefined;
  templateBytes = undefined;
}

process.on("exit", cleanupMigratedDbTemplate);
