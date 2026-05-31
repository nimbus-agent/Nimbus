import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dbExec, dbRun, dbStmtRun } from "../db/write.ts";
import type { CorpusTier } from "./types.ts";

export const FIXTURE_TIER_SIZES = {
  small: 10_000,
  medium: 100_000,
  large: 1_000_000,
} as const satisfies Record<CorpusTier, number>;

export const FIXTURE_SEED = 0x12345678;
export const FIXTURE_TIMESTAMP = 1704067200000;
export interface BuildOptions {
  cacheDir?: string;
}

function defaultCacheDir(): string {
  return join(tmpdir(), "nimbus-bench-fixtures");
}

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIXTURE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS item (
  id              TEXT PRIMARY KEY,
  service         TEXT NOT NULL,
  type            TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  title           TEXT NOT NULL,
  body_preview    TEXT,
  url             TEXT,
  canonical_url   TEXT,
  modified_at     INTEGER NOT NULL,
  author_id       TEXT,
  metadata        TEXT,
  synced_at       INTEGER NOT NULL,
  pinned          INTEGER NOT NULL DEFAULT 0,
  UNIQUE(service, external_id)
);
CREATE INDEX IF NOT EXISTS idx_item_service     ON item(service);
CREATE INDEX IF NOT EXISTS idx_item_type        ON item(type);
CREATE INDEX IF NOT EXISTS idx_item_modified_at ON item(modified_at);
`;

export async function buildSyntheticIndex(
  tier: CorpusTier,
  opts: BuildOptions = {},
): Promise<string> {
  const cacheDir = opts.cacheDir ?? defaultCacheDir();
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  const path = join(cacheDir, `${tier}-${FIXTURE_SEED.toString(16)}.sqlite`);
  if (existsSync(path)) {
    return path;
  }

  const rows = FIXTURE_TIER_SIZES[tier];
  const db = new Database(path);
  try {
    dbExec(db, FIXTURE_SCHEMA_SQL);
    const rng = makeRng(FIXTURE_SEED);
    const ins = db.prepare(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, url, modified_at, synced_at, pinned)
       VALUES (?, 'github', 'pr', ?, ?, '', '', ?, ?, 0)`,
    );
    const now = FIXTURE_TIMESTAMP;
    dbRun(db, "BEGIN");
    for (let i = 0; i < rows; i += 1) {
      const t = Math.floor(rng() * 1_000_000);
      dbStmtRun(ins, `gh:${i}`, String(i), `Synthetic PR ${i}`, now - t, now - t);
    }
    dbRun(db, "COMMIT");
    ins.finalize();
  } finally {
    db.close();
  }
  return path;
}
