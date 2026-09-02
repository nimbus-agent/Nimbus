import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../../src/connectors/connector-sync-test-helpers.ts";
import { createFilesystemV2Syncable } from "../../src/connectors/filesystem-v2-sync.ts";
import { LocalIndex } from "../../src/index/local-index.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../../src/index/sqlite-vec-load.ts";

const MODEL = "fs-v2-semantic-smoke";

function vecAvailable(): boolean {
  const d = new Database(":memory:");
  tryLoadSqliteVec(d);
  const ok = isVecLoaded(d);
  d.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function vecPrimarily(dim: number, primary: number, strength = 1): Float32Array {
  const v = new Float32Array(dim);
  v[primary] = strength;
  return v;
}

describe.skipIf(!VEC_AVAILABLE)("filesystem v2 semantic search (integration)", () => {
  test("hybrid query 'OAuth refresh' ranks renewCredentials above decoy without refresh in title", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-fsv2-sem-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "good.ts"),
      `/** Handles OAuth refresh grant for expired access tokens. */
export function renewCredentials() { return {}; }
`,
    );
    writeFileSync(
      join(dir, "src", "decoy.ts"),
      `export function parseTimestamp() { return 0; /* unrelated */ }
`,
    );

    const db = createMemoryIndexDb();
    const sync = createFilesystemV2Syncable({
      roots: [
        {
          path: dir,
          gitAware: false,
          codeIndex: true,
          dependencyGraph: false,
          mediaIndex: false,
          exclude: ["node_modules", ".git"],
        },
      ],
    });
    await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);

    const targetRow = db
      .query(
        `SELECT id FROM item WHERE service = 'filesystem' AND type = 'code_symbol' AND title LIKE '%renewCredentials%'`,
      )
      .get() as { id: string } | null;
    const decoyRow = db
      .query(
        `SELECT id FROM item WHERE service = 'filesystem' AND type = 'code_symbol' AND title LIKE '%parseTimestamp%'`,
      )
      .get() as { id: string } | null;
    expect(targetRow?.id).toBeTruthy();
    expect(decoyRow?.id).toBeTruthy();
    const targetId = targetRow?.id ?? "";
    const decoyId = decoyRow?.id ?? "";

    const vTarget = vecPrimarily(384, 0, 0.99);
    vTarget[1] = 0.08;
    const vDecoy = vecPrimarily(384, 5, 1);
    let rowid = 1;
    const now = Date.now();
    for (const rec of [
      { id: targetId, vec: vTarget, chunk: "oauth refresh chunk" },
      { id: decoyId, vec: vDecoy, chunk: "decoy chunk" },
    ]) {
      db.run(`INSERT INTO vec_items_384(rowid, embedding) VALUES (?, vec_f32(?))`, [
        BigInt(rowid),
        rec.vec,
      ]);
      db.run(
        `INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text, vec_rowid, model, dims, embedded_at)
         VALUES (?, 0, ?, ?, ?, 384, ?)`,
        [rec.id, rec.chunk, rowid, MODEL, now],
      );
      rowid += 1;
    }

    const q = new Float32Array(384);
    q[0] = 1;
    q[1] = 0.05;

    const idx = new LocalIndex(db, {
      semanticSearch: {
        model: MODEL,
        embedQuery: async () => q,
        embedQueryDual: async () => ({
          vec384: q,
          vec1536: null,
          model384: MODEL,
          model1536: null,
        }),
      },
    });

    const ranked = await idx.searchRankedAsync(
      { name: "OAuth refresh", limit: 20 },
      { semantic: true, contextChunks: 1 },
    );
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    const posTarget = ranked.findIndex((r) => r.indexPrimaryKey === targetId);
    const posDecoy = ranked.findIndex((r) => r.indexPrimaryKey === decoyId);
    expect(posTarget).toBeGreaterThanOrEqual(0);
    expect(posDecoy).toBeGreaterThanOrEqual(0);
    expect(posTarget).toBeLessThan(posDecoy);

    idx.close();
  });
});
