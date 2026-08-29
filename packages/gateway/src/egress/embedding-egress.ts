import type { Database } from "bun:sqlite";

import type { Embedder } from "../embedding/types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

/**
 * The I29 `model`-class appender for EMBEDDINGS -- the last exclusion that class carried.
 *
 * Until this landed, `PROSE_HEAVY_TYPES` routed prose to OpenAI's 1536-dim table with no
 * appender, so `nimbus prove` could report `model: 0` over a window in which vectors really had
 * left the machine. The zero was true about generates and silent about embeddings.
 *
 * A DECORATOR at construction, not a call-site append, for the same reason as
 * `wrapLedgeredProvider`: there are three construction sites
 * (`create-routing-runtime.ts`, `create-embedding-runtime.ts`, `ipc/index-reembed-rpc.ts`) and
 * an unknown number of `embed()` callers. Wrapping the instance covers every caller, including
 * ones written later, without any of them cooperating.
 *
 * Locality is DERIVED from `embedder.isLocal`, never passed in. A local embedder is returned
 * UNCHANGED -- not even a blocked row -- mirroring `LOCAL_ONLY_SYNC_SERVICES` and
 * `wrapLedgeredProvider`. A caller-computed boolean is one wiring mistake away from a
 * fabricated row for a local embed, or a missing one for a remote embed.
 */
export function wrapLedgeredEmbedder(
  db: Database,
  embedder: Embedder,
  now: () => number = Date.now,
): Embedder {
  if (embedder.isLocal) {
    return embedder;
  }
  // `openai:text-embedding-3-small` -> `openai`. The vendor, matching what a `model` row's
  // `destination` means elsewhere: a place data can go, never a raw URL.
  const destination = embedder.model.split(":")[0] ?? embedder.model;

  return {
    model: embedder.model,
    dims: embedder.dims,
    isLocal: embedder.isLocal,
    embed: async (texts: string[]): Promise<Float32Array[]> => {
      // An empty batch makes no request -- `createOpenAIEmbedder` returns early -- so a row
      // would record egress that did not happen.
      if (texts.length === 0) {
        return [];
      }
      try {
        appendEgressEntry(db, {
          timestamp: now(),
          sourceType: "model",
          sourceId: embedder.model,
          destination,
          method: "embedding.embed",
          // `payloadSummary` is REQUIRED on `EgressEntry` and is a debugging aid, never the
          // security boundary -- it is `redactEgressSummary`-scrubbed and capped at 256 bytes.
          // Record the batch SIZE, never the texts: the whole point of the ledger is to prove
          // what left, not to keep a second copy of it.
          payloadSummary: redactEgressSummary({ model: embedder.model, batch: texts.length }),
          hitlStatus: "not_required",
          resultStatus: "authorized",
        });
      } catch (err) {
        throw new EgressAppendFailedError(err);
      }
      return embedder.embed(texts);
    },
  };
}
