/**
 * The I29 `model`-class appender for VISION calls (spec § 9.2, § 7).
 *
 * A DECORATOR over the provider instance, not an append at a call site — the same shape as
 * `wrapLedgeredProvider` (routes), `wrapLedgeredMastraModel` (the AI-SDK seam) and
 * `wrapLedgeredEmbedder` (embeddings). Wrapping the instance covers every current caller and
 * every caller written later without any of them cooperating; a call-site append covers only the
 * sites that exist today, which is how `recordSynthesisEgress` came to leave one of two reachable
 * remote paths silent.
 *
 * Shipped BEFORE any remote VLM existed (PR 2), for the same reason PR 1 shipped the gate with
 * only its local arm: retrofitting an appender onto code that already reaches the model is how a
 * silent window gets built. It was tested against a deliberately non-local fake back then, so the
 * row's shape existed before the thing that would emit it.
 *
 * PR 4 is what gives this its first REAL remote provider: `vlm/remote/remote-vlm-shared.ts`'s
 * `createRemoteVlm`, wrapped at both of this file's D22(g)-confined construction sites in
 * `build-media-pass-deps.ts`. This function is therefore no longer an identity for every caller
 * that reaches it — a granted image's `describe()` call is wrapped for real, and I37 (spec § 18.6)
 * has its first live exercise rather than a foregone conclusion. It stays an identity ONLY for a
 * local provider (`provider.isLocal`, I34), which makes no outbound request and still needs no
 * ledger row — that bound is unchanged and correct, not a residual gap.
 *
 * WHY LOCALITY IS DERIVED. Reading `provider.isLocal` (I34) makes both failure modes
 * unrepresentable: a caller cannot pass `false` for a remote provider and put a false zero in the
 * ledger `nimbus prove` reports on, nor `true` for a local one and fabricate rows. A LOCAL
 * provider is returned UNCHANGED — identity, not a pass-through wrapper — because a local describe
 * makes no outbound request and ledgering it would over-claim egress. Same choice as
 * `LOCAL_ONLY_SYNC_SERVICES` in `sync-egress.ts`.
 *
 * WHAT THE ROW MAY NOT CARRY. `payload_summary` gets the model and the byte COUNT — never the
 * prompt and never the image. An image is the most sensitive payload in the subsystem; a summary
 * that quoted it would put the artifact in a table whose whole purpose is to be readable.
 */
import type { Database } from "bun:sqlite";
import type {
  VlmDescribeInput,
  VlmDescribeResult,
  VlmProvider,
} from "../multimodal/vlm/vlm-types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

export function wrapLedgeredVlm(
  db: Database,
  provider: VlmProvider,
  now: () => number = Date.now,
): VlmProvider {
  if (provider.isLocal) {
    return provider;
  }
  return {
    providerId: provider.providerId,
    isLocal: provider.isLocal,
    model: provider.model,
    isAvailable: () => provider.isAvailable(),
    describe: async (input: VlmDescribeInput): Promise<VlmDescribeResult> => {
      // Ledger THEN act. An append that throws aborts the call, so a window with no rows means no
      // image left the machine -- never that one left unrecorded.
      try {
        appendEgressEntry(db, {
          timestamp: now(),
          sourceType: "model",
          sourceId: provider.model,
          destination: provider.providerId,
          method: input.egressMethod ?? "multimodal.vlm.describe",
          payloadSummary: redactEgressSummary({
            model: provider.model,
            imageBytes: input.bytes.byteLength,
          }),
          hitlStatus: "not_required",
          resultStatus: "authorized",
        });
      } catch (err) {
        throw new EgressAppendFailedError(err, { appender: "vlm", model: provider.model });
      }
      return provider.describe(input);
    },
  };
}
