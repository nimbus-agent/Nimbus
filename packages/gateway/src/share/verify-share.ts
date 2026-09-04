import { load as yamlParse } from "js-yaml";
import { safeFetch } from "../util/safe-fetch.ts";
import { type ShareFile, type VerifyResult, verifyShareBytes } from "./share-format.ts";
import { verifyForwardingChain } from "./share-forwarding.ts";

/**
 * A {@link VerifyResult} augmented with the share's self-declared origin, when the bytes parse as
 * JSON carrying a `body.origin`. The origin is surfaced for display even when verification fails
 * (e.g. a tampered body), so the caller can show "claims to be from X — but signature invalid".
 * It is therefore UNTRUSTED until {@link VerifyResult.signatureValid} is true.
 *
 * `forwarding` is ADVISORY attribution only (spec §9.2): a bad/tampered hop never flips
 * `signatureValid` or `ok` — content validity is determined independently by the inner sig.
 */
export interface VerifyShareReport extends VerifyResult {
  readonly origin?: { readonly label: string; readonly pubkey: string };
  /** Advisory forwarding hop-chain validation result. Absent when the share has no forwarding envelope or when the input cannot be parsed. */
  readonly forwarding?: {
    readonly hops: number;
    readonly chainValid: boolean;
    readonly hopsValid: number;
  };
}

/**
 * Accept either a JSON (`.nimbus-share.json`) or YAML (`.nimbus-recipe.yaml`) share. Parse to an
 * object and re-encode as JSON bytes so the single JSON-only `verifyShareBytes` primitive can hash
 * + verify. Verification re-canonicalizes the body, so the input serialization never affects the
 * result. Returns the original bytes unchanged when they are already JSON.
 */
function toJsonShareBytes(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  try {
    JSON.parse(text);
    return bytes; // already JSON
  } catch {
    // fall through to YAML
  }
  try {
    const obj: unknown = yamlParse(text);
    return new TextEncoder().encode(JSON.stringify(obj));
  } catch {
    return bytes; // neither JSON nor YAML → let verifyShareBytes report "malformed json"
  }
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
  const jsonBytes = toJsonShareBytes(bytes);
  let base: VerifyResult;
  try {
    base = verifyShareBytes(jsonBytes, opts);
  } catch {
    base = NOT_A_SHARE;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(jsonBytes)) as {
      body?: { origin?: unknown };
      forwarding?: { hops?: unknown; chain?: unknown };
      contentHash?: unknown;
      format?: unknown;
      sig?: unknown;
    };
    const origin = parsed.body?.origin;
    // `origin` is untrusted JSON — only surface it when it has the expected `{label, pubkey}`
    // string shape, so a malformed value can't poison the report's type contract.
    const originField =
      origin !== null &&
      typeof origin === "object" &&
      typeof (origin as { label?: unknown }).label === "string" &&
      typeof (origin as { pubkey?: unknown }).pubkey === "string"
        ? (origin as { label: string; pubkey: string })
        : undefined;

    // Advisory forwarding chain: run only when the share parses as a valid ShareFile (has a
    // proper forwarding envelope). Content validity (base) is NEVER affected by this check —
    // a bad/tampered hop returns forwarding.chainValid=false while signatureValid stays true.
    let forwardingField: { hops: number; chainValid: boolean; hopsValid: number } | undefined;
    if (
      parsed.forwarding !== null &&
      typeof parsed.forwarding === "object" &&
      typeof parsed.forwarding.hops === "number" &&
      Array.isArray(parsed.forwarding.chain) &&
      typeof parsed.contentHash === "string" &&
      typeof parsed.format === "string" &&
      parsed.sig !== null &&
      typeof parsed.sig === "object"
    ) {
      const chain = verifyForwardingChain(parsed as unknown as ShareFile);
      forwardingField = {
        // Report the hop depth from the actual chain, NOT the untrusted `forwarding.hops` field —
        // a payload could otherwise claim an arbitrary hop count while `chainValid` derives from `chain`.
        hops: chain.hopsTotal,
        chainValid: chain.valid,
        hopsValid: chain.hopsValid,
      };
    }

    const report: VerifyShareReport = {
      ...base,
      ...(originField === undefined ? {} : { origin: originField }),
      ...(forwardingField === undefined ? {} : { forwarding: forwardingField }),
    };
    return report;
  } catch {
    return base;
  }
}

/**
 * Load raw share bytes from a URL (SSRF-safe {@link safeFetch}) or a local file path. The
 * input-loading half of {@link verifyShareFromInput}, exported so `share.replay` can both verify and
 * parse the same bytes without a second read.
 */
export async function loadShareBytes(
  input: string,
  deps?: { readonly safeFetchFn?: typeof safeFetch },
): Promise<Uint8Array> {
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const doFetch = deps?.safeFetchFn ?? safeFetch;
    const res = await doFetch(input);
    return new Uint8Array(await res.arrayBuffer());
  }
  return await Bun.file(input).bytes();
}

/**
 * Parse share bytes (JSON or YAML) into a {@link ShareFile} for replay, or `null` if the input is not
 * a well-formed share envelope. Verification is the trust boundary ({@link verifyShareFromBytes}) —
 * this only structurally validates enough to read `body`/`sig`/`forwarding`. Never throws.
 */
export function parseShareFile(bytes: Uint8Array): ShareFile | null {
  try {
    const obj = JSON.parse(new TextDecoder().decode(toJsonShareBytes(bytes))) as unknown;
    if (
      obj === null ||
      typeof obj !== "object" ||
      typeof (obj as { body?: unknown }).body !== "object" ||
      (obj as { body?: unknown }).body === null ||
      typeof (obj as { sig?: unknown }).sig !== "object" ||
      (obj as { sig?: unknown }).sig === null ||
      typeof (obj as { format?: unknown }).format !== "string" ||
      typeof (obj as { contentHash?: unknown }).contentHash !== "string" ||
      typeof (obj as { forwarding?: unknown }).forwarding !== "object" ||
      (obj as { forwarding?: unknown }).forwarding === null
    ) {
      return null;
    }
    return obj as ShareFile;
  } catch {
    return null;
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
