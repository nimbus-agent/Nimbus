/**
 * Registry client that fetches `<baseUrl>/publishers/<id>.key` and returns
 * the 32-byte Ed25519 pubkey body. Body shape: raw 44-char base64 (with
 * padding) of a 32-byte payload, no envelope. Strict body-length check
 * defends against trailing-garbage / append-style attacks.
 */

import { decodeBase64 } from "./verify-signature.ts";

export type PublisherKeyFetchResult =
  | { kind: "ok"; pubkey: Uint8Array }
  | { kind: "not_found" }
  | { kind: "transient"; statusCode?: number; message: string }
  | { kind: "registry_error"; statusCode: number; message: string };

export interface PublisherKeyFetcher {
  fetch(publisherId: string): Promise<PublisherKeyFetchResult>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRIES = 1;
const EXPECTED_BASE64_LEN = 44; // base64 of 32 bytes with padding

export function createPublisherKeyFetcher(opts: {
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  /** Injected fetch implementation for tests. Defaults to global fetch. */
  fetchFn?: typeof fetch;
}): PublisherKeyFetcher {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const fetchFn = opts.fetchFn ?? fetch;

  async function attempt(publisherId: string): Promise<PublisherKeyFetchResult> {
    const url = `${baseUrl}/publishers/${publisherId}.key`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: controller.signal });
      if (res.status === 404) return { kind: "not_found" };
      if (res.status >= 500 && res.status < 600) {
        return { kind: "transient", statusCode: res.status, message: `HTTP ${String(res.status)}` };
      }
      if (res.status >= 400) {
        return {
          kind: "registry_error",
          statusCode: res.status,
          message: `HTTP ${String(res.status)}`,
        };
      }
      if (!res.ok) {
        return {
          kind: "registry_error",
          statusCode: res.status,
          message: `HTTP ${String(res.status)}`,
        };
      }
      const text = (await res.text()).trim();
      if (text.length !== EXPECTED_BASE64_LEN) {
        return {
          kind: "registry_error",
          statusCode: res.status,
          message: `publisher key body must be exactly ${String(EXPECTED_BASE64_LEN)} trimmed chars (got ${String(text.length)})`,
        };
      }
      const pubkey = decodeBase64(text);
      if (pubkey.length !== 32) {
        return {
          kind: "registry_error",
          statusCode: res.status,
          message: "publisher key body did not decode to 32 bytes",
        };
      }
      return { kind: "ok", pubkey };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { kind: "transient", message: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetch(publisherId: string): Promise<PublisherKeyFetchResult> {
      let result = await attempt(publisherId);
      let remaining = retries;
      while (result.kind === "transient" && remaining > 0) {
        remaining--;
        result = await attempt(publisherId);
      }
      return result;
    },
  };
}
