import { readFileSync, writeFileSync } from "node:fs";

export function restoreDbFromSnapshot(snapshotPath: string, dbPath: string): void {
  const compressed = readFileSync(snapshotPath);
  const raw = Bun.gunzipSync(compressed);
  writeFileSync(dbPath, raw);
}
