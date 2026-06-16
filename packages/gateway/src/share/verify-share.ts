import { safeFetch } from "./safe-fetch.ts";
import { type VerifyResult, verifyShareBytes } from "./share-format.ts";

/**
 * A {@link VerifyResult} augmented with the share's self-declared origin, when the bytes parse as
 * JSON carrying a `body.origin`. The origin is surfaced for display even when verification fails
 * (e.g. a tampered body), so the caller can show "claims to be from X — but signature invalid".
 * It is therefore UNTRUSTED until {@link VerifyResult.signatureValid} is true.
 */
export interface VerifyShareReport extends VerifyResult {
  readonly origin?: { readonly label: string; readonly pubkey: string };
}

/** Fail-closed report for input the codec cannot interpret as a share file. */
const NOT_A_SHARE: VerifyResult = {
  ok: false,
  signatureValid: false,
  contentHashValid: false,
  expired: false,
  errors: ["not a share file"],
};

/**
 * Verify raw share bytes, reusing the codec's per-check result and exposing the declared origin.
 *
 * Resilient by contract: this is the ingestion point for untrusted bytes (a downloaded URL or a
 * local file the user points at), so it never throws — any input the codec can't interpret as a
 * well-formed share file (malformed JSON, or valid JSON missing the expected `body`) yields a
 * fail-closed not-ok report rather than propagating an exception.
 */
export function verifyShareFromBytes(
  bytes: Uint8Array,
  opts?: { now?: number },
): VerifyShareReport {
  let base: VerifyResult;
  try {
    base = verifyShareBytes(bytes, opts);
  } catch {
    base = NOT_A_SHARE;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as {
      body?: { origin?: { label: string; pubkey: string } };
    };
    const origin = parsed.body?.origin;
    return origin === undefined ? base : { ...base, origin };
  } catch {
    return base;
  }
}

/**
 * Verify a share given a URL (fetched via the SSRF-safe {@link safeFetch}) or a local file path.
 * `http(s)://` inputs are fetched; anything else is treated as a filesystem path.
 */
export async function verifyShareFromInput(
  input: string,
  opts?: { now?: number },
  deps?: { readonly safeFetchFn?: typeof safeFetch },
): Promise<VerifyShareReport> {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const doFetch = deps?.safeFetchFn ?? safeFetch;
    const res = await doFetch(input);
    const buf = new Uint8Array(await res.arrayBuffer());
    return verifyShareFromBytes(buf, opts);
  }
  const buf = await Bun.file(input).bytes();
  return verifyShareFromBytes(buf, opts);
}
