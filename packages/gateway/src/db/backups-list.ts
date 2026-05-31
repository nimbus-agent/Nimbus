import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type MigrationBackupEntry = {
  filename: string;
  compressedSizeBytes: number;
  mtimeMs: number;
};

export function listMigrationBackups(dataDir: string): MigrationBackupEntry[] {
  const dir = join(dataDir, "backups");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: MigrationBackupEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".db.gz") || !name.startsWith("pre-migration-")) {
      continue;
    }
    const full = join(dir, name);
    try {
      const st = statSync(full);
      out.push({ filename: name, compressedSizeBytes: st.size, mtimeMs: st.mtimeMs });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
