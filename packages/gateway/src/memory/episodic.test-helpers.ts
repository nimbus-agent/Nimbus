import { Database } from "bun:sqlite";

import type { NimbusMemoryToml } from "../config/memory-toml.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ensureFullSqlite } from "../platform/sqlite-runtime.ts";
import { EpisodicMemory, type EpisodicMemoryDeps } from "./episodic-memory.ts";
import { EpisodicStore } from "./episodic-store.ts";
import type { EpisodicLlm } from "./episodic-summarise.ts";

export const TEST_DIMS = 384;

/** A deterministic bag-of-words embedder: words that two texts share raise their cosine similarity. */
export function bagEmbed(text: string): Float32Array {
  const v = new Float32Array(TEST_DIMS);
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619) >>> 0;
    v[h % TEST_DIMS] = (v[h % TEST_DIMS] as number) + 1;
  }
  return v;
}

export function migratedDb(): Database {
  ensureFullSqlite();
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

export type CapturedLlm = EpisodicLlm & { readonly prompts: string[] };

/** An LLM double that records every prompt it was given and answers with `reply` (`null`: no local model). */
export function captureLlm(reply: string | null): CapturedLlm {
  const prompts: string[] = [];
  return {
    prompts,
    complete: async (prompt) => {
      prompts.push(prompt);
      return reply;
    },
  };
}

export const ON: NimbusMemoryToml = { episodic: true, retentionDays: 90, recallRemote: false };
export const OFF: NimbusMemoryToml = { episodic: false, retentionDays: 90, recallRemote: false };

export function makeMemory(opts: {
  readonly db: Database;
  readonly llm: EpisodicLlm;
  readonly config?: () => NimbusMemoryToml;
  readonly now?: () => number;
  readonly embedText?: EpisodicMemoryDeps["embedText"];
  readonly idleMs?: number;
}): { memory: EpisodicMemory; store: EpisodicStore } {
  const store = new EpisodicStore(opts.db);
  const memory = new EpisodicMemory({
    store,
    config: opts.config ?? (() => ON),
    llm: opts.llm,
    embedText: opts.embedText ?? (async (t) => bagEmbed(t)),
    dims: TEST_DIMS,
    ...(opts.now === undefined ? {} : { now: opts.now }),
    ...(opts.idleMs === undefined ? {} : { idleMs: opts.idleMs }),
  });
  return { memory, store };
}
