import { Database } from "bun:sqlite";

import { buildItemListSql } from "../../index/item-list-query.ts";
import { buildSyntheticIndex, FIXTURE_TIMESTAMP } from "../perf-fixture.ts";
import type { BenchRunOptions } from "../types.ts";

export const QUERIES_PER_RUN = 100;

export interface RunOptions {
  cacheDir?: string;
}

export async function runQueryLatencyOnce(
  opts: BenchRunOptions,
  runOpts: RunOptions = {},
): Promise<number[]> {
  const tier = opts.corpus ?? "small";
  const fixturePath = await buildSyntheticIndex(tier, runOpts);

  const db = new Database(fixturePath, { readonly: true });
  const { sql, vals } = buildItemListSql({
    services: ["github"],
    types: ["pr"],
    sinceMs: FIXTURE_TIMESTAMP - 86_400_000,
    limit: 50,
  });

  const stmt = db.prepare(sql);
  try {
    stmt.all(...vals);

    const samples: number[] = [];
    for (let i = 0; i < QUERIES_PER_RUN; i += 1) {
      const t0 = performance.now();
      stmt.all(...vals);
      samples.push(performance.now() - t0);
    }
    return samples;
  } finally {
    stmt.finalize();
    db.close();
  }
}
