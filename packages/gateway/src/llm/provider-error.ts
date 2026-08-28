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
/**
 * Reads a 2xx response body as JSON, classifying a parse failure rather than letting it escape.
 *
 * `Response.json()` THROWS a `SyntaxError` when a 2xx body is not JSON — which a proxy named by
 * `base_url` will happily produce, returning an HTML error page with status 200. That
 * `SyntaxError` is not an `LlmProviderError`, so `LlmRouter.generate` would treat it as
 * unclassified and STOP the priority walk, never trying the healthy local route next in line.
 * That is the exact failure the fallback rule exists to prevent, so it is classified TRANSPORT:
 * whatever answered was not the vendor API, and another destination may do better.
 */
export async function readJsonBody(resp: Response, providerId: string): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    throw new LlmProviderError(`${providerId}: response body was not JSON`, "transport");
  }
}

/**
 * Narrows a parsed JSON value to a plain object, or `{}` when it is anything else.
 *
 * A TypeScript `as` assertion does NOT validate JSON: a literal `null` body satisfies the
 * compiler and then throws `TypeError` on the first property read. Returning `{}` for a null,
 * array or primitive root lets every field read below degrade to the same honest empty answer a
 * missing field already produces, instead of a crash the router cannot classify.
 */
export function asJsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** An array field from external JSON, or `[]` — `.filter()` on a non-array throws. */
export function asJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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
