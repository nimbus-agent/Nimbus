import type { Database } from "bun:sqlite";
import { earliestHistoryMs, pointInTimeDisclosure } from "../../index/item-history-at.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { LlmGenerateResult } from "../../llm/types.ts";
import { gatewayZone } from "../../util/zoned-time.ts";

/** The `RunAskParams` fields the empty-index answer reads (structural: `RunAskParams` is assignable). */
export type EmptyIndexParams = {
  readonly input: string;
  readonly stream: boolean;
  readonly sendChunk: (text: string) => void;
  readonly pointInTimeMs?: number | undefined;
  readonly localIndex: LocalIndex;
};

const EMPTY_INDEX_GUIDANCE = `No data indexed yet.

To get started, connect a service and run an initial sync:
  nimbus connector auth github
  nimbus connector auth google
  nimbus connector auth slack
  nimbus connector list
  nimbus connector sync <service>

Then try your question again, or run nimbus doctor for a health summary.`;

const DEMO_EMPTY_INDEX_GUIDANCE = `No data indexed yet.

This is the demo root. Seed the synthetic "Acme" org with:
  nimbus demo
`;

function emptyIndexGuidance(demo: boolean): string {
  return demo ? DEMO_EMPTY_INDEX_GUIDANCE : EMPTY_INDEX_GUIDANCE;
}

const INDEX_ITEM_COUNT_CACHE = new WeakMap<Database, { at: number; value: number }>();
const INDEX_ITEM_COUNT_TTL_MS = 8000;

export function countIndexedItems(localIndex: LocalIndex): number | undefined {
  if (typeof localIndex.getDatabase !== "function") {
    return undefined;
  }
  try {
    const db = localIndex.getDatabase();
    const now = Date.now();
    const hit = INDEX_ITEM_COUNT_CACHE.get(db);
    if (hit !== undefined && now - hit.at < INDEX_ITEM_COUNT_TTL_MS) {
      return hit.value;
    }
    const row = db.query(`SELECT COUNT(*) AS c FROM item`).get() as { c: number } | null;
    const c = row?.c;
    const value = typeof c === "number" && Number.isFinite(c) ? Math.max(0, Math.floor(c)) : 0;
    INDEX_ITEM_COUNT_CACHE.set(db, { at: now, value });
    return value;
  } catch {
    return undefined;
  }
}

export function emptyIndexGuidanceIfNeeded(
  p: EmptyIndexParams,
  demo: boolean,
  indexed: number | undefined,
): RunAskResult | undefined {
  if (p.input.trim() === "" || indexed !== 0) {
    return undefined;
  }
  const guidance = emptyIndexGuidance(demo);
  const atMs = p.pointInTimeMs;
  if (atMs === undefined) {
    if (p.stream) {
      p.sendChunk(`${guidance}\n`);
    }
    return { reply: guidance };
  }
  // A point-in-time turn is answered as one even when `item` is empty: the client needs the `asOfMs` echo, and
  // the deterministic block says what the empty table cannot (history may outlive its deleted items).
  const db =
    typeof p.localIndex.getDatabase === "function" ? p.localIndex.getDatabase() : undefined;
  const block = pointInTimeDisclosure({
    atMs,
    zone: gatewayZone(),
    historyStartMs: db === undefined ? null : earliestHistoryMs(db),
    gapCount: 0,
  }).join("\n");
  if (p.stream) {
    p.sendChunk(`${guidance}\n${block}\n`);
  }
  return { reply: `${guidance}\n${block}`, asOfMs: atMs };
}

/**
 * What `runAsk` returns. `asOfMs` is set only on a point-in-time turn that was honoured: the echo is how a
 * client tells a gateway that answered as of the instant from an older one that ignored `at`.
 */
export type RunAskResult = { reply: string; modelMeta?: LlmGenerateResult; asOfMs?: number };
