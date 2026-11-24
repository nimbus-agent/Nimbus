import type { Database } from "bun:sqlite";
import { embedQueryBestEffort } from "../../embedding/embedding-readiness.ts";
import type { EmbeddingRuntime } from "../../embedding/embedding-runtime.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import type { LlmRouter } from "../../llm/router.ts";
import { EpisodicMemory, memoryConfigFor } from "../../memory/episodic-memory.ts";
import { EpisodicStore } from "../../memory/episodic-store.ts";
import { createEpisodicLlm } from "../../memory/episodic-summarise.ts";
import type { SessionMemoryStore } from "../../memory/session-memory-store.ts";
import type { PlatformPaths } from "../paths.ts";

/** How often idle sessions are looked for. */
export const EPISODIC_SWEEP_MS = 5 * 60_000;
export const EPISODIC_PRUNE_MS = 24 * 3_600_000;

export type EpisodicBootDeps = {
  readonly db: Database;
  readonly rt: EmbeddingRuntime | null | undefined;
  readonly llmRegistry: { readonly llmRouter: LlmRouter };
  readonly paths: PlatformPaths;
  readonly sidecarStops: Array<() => void>;
  readonly embeddingDims?: number;
};

/**
 * Attaches long-term episodic memory (I61) to the session store, once, at boot. NOT attached on a demo gateway
 * (I41: it neither stores nor recalls), and not before the V107 tables exist. The summariser is
 * `createEpisodicLlm` (local providers only) and the embedder is the embedding runtime's `embedQuery`, the local
 * MiniLM; `embedQueryDual` and the remote embedder are not reachable from here.
 */
export function attachEpisodicMemory(
  store: SessionMemoryStore | undefined,
  deps: EpisodicBootDeps,
): EpisodicMemory | undefined {
  if (store === undefined || deps.paths.demo === true) return undefined;
  if (readIndexedUserVersion(deps.db) < 107) return undefined;
  const rt = deps.rt ?? null;
  const memory = new EpisodicMemory({
    store: new EpisodicStore(deps.db),
    config: memoryConfigFor(deps.paths.configDir),
    llm: createEpisodicLlm(deps.llmRegistry.llmRouter),
    embedText: (t) => (rt === null ? Promise.resolve(null) : embedQueryBestEffort(rt, t)),
    dims: rt === null ? (deps.embeddingDims ?? 384) : rt.getEmbeddingDims(),
  });
  store.episodic = memory;
  const sweep = setInterval(() => {
    void memory.sweep().catch(() => undefined);
  }, EPISODIC_SWEEP_MS);
  const prune = setInterval(() => {
    try {
      memory.prune();
    } catch {
      /* best-effort maintenance */
    }
  }, EPISODIC_PRUNE_MS);
  sweep.unref?.();
  prune.unref?.();
  try {
    memory.prune();
  } catch {
    /* best-effort maintenance */
  }
  deps.sidecarStops.push(() => {
    clearInterval(sweep);
    clearInterval(prune);
  });
  return memory;
}
