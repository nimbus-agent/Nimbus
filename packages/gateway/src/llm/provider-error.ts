// packages/gateway/src/llm/provider-error.ts

/**
 * Why a provider call failed, in the only distinction the router acts on.
 *
 * `transport` — connection refused, DNS, timeout, 5xx, 429. The vendor was not reached, or was
 * reached and could not answer right now. Trying the NEXT route in priority order may succeed.
 * `auth` — 401/403. The key is missing, wrong, or lacks access.
 * `request` — 400/404 and any other 4xx. The request itself is unacceptable: a bad model name, a
 * malformed body.
 *
 * Only `transport` continues the priority walk. The other two fail identically at the next
 * vendor, so retrying would send the same prompt to a second destination — one more real
 * outbound request and one more `egress_ledger` row — for no better answer.
 */
export type LlmFailureKind = "transport" | "auth" | "request";

/**
 * Maps an HTTP status onto the retry decision.
 *
 * Note the DEFAULT: an unmapped 4xx is `request`, never `transport`. The fail-closed direction
 * here is "do not retry", because retrying is the action that costs a real outbound request to a
 * second vendor. An unmapped 5xx IS transport — the 5xx range means the server failed, which is
 * exactly the retryable case.
 */
export function classifyHttpStatus(status: number): LlmFailureKind {
  if (status === 429) return "transport";
  if (status >= 500) return "transport";
  if (status === 401 || status === 403) return "auth";
  return "request";
}

/**
 * A provider failure carrying its retry classification. Thrown by every cloud adapter, so
 * `LlmRouter.generate`'s priority walk can branch without knowing any vendor's status codes —
 * classification lives with the adapter because that is the only layer that can read them.
 */
export class LlmProviderError extends Error {
  readonly kind: LlmFailureKind;
  readonly status?: number;

  constructor(message: string, kind: LlmFailureKind, status?: number) {
    super(message);
    this.name = "LlmProviderError";
    this.kind = kind;
    // Conditional assignment, not `this.status = status`: under `exactOptionalPropertyTypes` an
    // explicitly-undefined optional property is a different type from an absent one, and a
    // keyless refusal never reaches HTTP so it has no status to report.
    if (status !== undefined) this.status = status;
  }
}
