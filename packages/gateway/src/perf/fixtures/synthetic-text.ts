export const SYNTHETIC_TEXT_DEFAULT_SEED = 0x6e696d62;
export interface SynthesizeTextOptions {
  length: number;
  count: number;
  seed?: number;
}

const WORDS = [
  "context",
  "ranker",
  "vault",
  "gateway",
  "embedding",
  "vector",
  "neighbor",
  "audit",
  "watcher",
  "session",
  "graph",
  "person",
  "service",
  "metric",
  "latency",
  "throughput",
  "memory",
  "snapshot",
  "manifest",
  "cluster",
  "schema",
  "migrate",
  "transaction",
  "checkpoint",
  "rollback",
  "consent",
  "redact",
  "verify",
  "signature",
  "release",
] as const;

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthesizeText(opts: SynthesizeTextOptions): string[] {
  const seed = opts.seed ?? SYNTHETIC_TEXT_DEFAULT_SEED;
  const rng = mulberry32(seed);
  const out: string[] = [];
  for (let i = 0; i < opts.count; i += 1) {
    const parts: string[] = [];
    let used = 0;
    while (used < opts.length) {
      const w = WORDS[Math.floor(rng() * WORDS.length)] ?? "context";
      parts.push(w);
      used += w.length + 1;
    }
    out.push(parts.join(" "));
  }
  return out;
}
