import type { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dbRun } from "./write.ts";

/**
 * VACUUM the database into a temporary file, compress it with gzip, write
 * atomically to gzPath via a `.partial` staging file, then remove the
 * uncompressed temporary copy.
 *
 * Callers are responsible for creating the destination directory before
 * calling this function.
 *
 * @param db       The open SQLite database to back up.
 * @param tmpPath  Scratch path for the uncompressed VACUUM copy (will be removed).
 * @param gzPath   Final destination for the compressed backup.
 */
export function vacuumAndGzip(db: Database, tmpPath: string, gzPath: string): void {
  const gzPartial = `${gzPath}.partial`;

  dbRun(db, `VACUUM INTO ?`, [tmpPath]);
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    /* best-effort — backup still proceeds */
  }

  const raw = readFileSync(tmpPath);
  const compressed = Bun.gzipSync(raw);
  const fd = openSync(gzPartial, "wx", 0o600);
  try {
    writeSync(fd, compressed);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(gzPartial, gzPath);
  } catch {
    rmSync(gzPath, { force: true });
    renameSync(gzPartial, gzPath);
  }

  try {
    rmSync(tmpPath);
  } catch {
    /* non-fatal */
  }
}
