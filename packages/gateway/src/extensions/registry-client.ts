/**
 * Registry client that fetches `<baseUrl>/publishers/<id>.key` and returns
 * the 32-byte Ed25519 pubkey body. Body shape: raw 44-char base64 (with
 * padding) of a 32-byte payload, no envelope. Strict body-length check
 * defends against trailing-garbage / append-style attacks.
 *
 * Phase-5 T2 PR 3 extends this surface with the two methods the polling
 * `ExtensionAutoUpdater` daemon needs:
 *
 * - `fetchLatestVersion(id, channel, signal)` → `{ version, channel } | null`
 * - `fetchManifest(id, version, signal)` → `{ manifest, manifestHash, entryHash, tarballUrl, tarballSizeBytes? }`
 *
 * Both go through the same timeout + per-call `AbortController` plumbing.
 * Schema-invalid responses throw; 404 on `latest` returns `null`; 404 on
 * `manifest` throws (a referenced version must be servable).
 */

import { type ExtensionManifest, parseExtensionManifestJson } from "./manifest.ts";
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

// ─── T2 PR 3 — full registry client ─────────────────────────────────────────

export interface RegistryClientOpts {
  baseUrl: string;
  timeoutMs?: number;
  retries?: number;
  fetchFn?: typeof fetch;
}

export interface FetchLatestVersionResponse {
  version: string;
  channel: "stable" | "beta";
}

export interface FetchManifestResponse {
  manifest: ExtensionManifest;
  /**
   * Raw on-disk JSON object as received from the registry. Used by the
   * auto-update daemon for `verifyManifestSignature` because canonicalization
   * is over the bytes the publisher actually signed — the parsed
   * `ExtensionManifest` includes defaulted fields (e.g. `updateChannel`) that
   * would change the canonical bytes.
   */
  manifestRaw: Record<string, unknown>;
  manifestHash: string;
  entryHash: string;
  tarballUrl: string;
  tarballSizeBytes?: number;
}

export interface RegistryClient {
  fetchPublisherKey: PublisherKeyFetcher["fetch"];
  fetchLatestVersion(
    extensionId: string,
    channel: "stable" | "beta",
    signal: AbortSignal,
  ): Promise<FetchLatestVersionResponse | null>;
  fetchManifest(
    extensionId: string,
    version: string,
    signal: AbortSignal,
  ): Promise<FetchManifestResponse>;
}

const HEX64 = /^[0-9a-f]{64}$/i;

export function createRegistryClient(opts: RegistryClientOpts): RegistryClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetchFn ?? fetch;
  const publisher = createPublisherKeyFetcher({
    baseUrl: opts.baseUrl,
    timeoutMs,
    retries: opts.retries ?? DEFAULT_RETRIES,
    fetchFn,
  });

  async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
    const local = new AbortController();
    const onAbort = () => local.abort();
    signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => local.abort(), timeoutMs);
    try {
      const res = await fetchFn(url, { signal: local.signal });
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`registry GET ${url} failed: HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
    }
  }

  return {
    fetchPublisherKey: publisher.fetch,

    async fetchLatestVersion(id, channel, signal) {
      const url = `${baseUrl}/v1/extensions/${encodeURIComponent(id)}/latest?channel=${channel}`;
      const body = await getJson<{ version?: unknown; channel?: unknown }>(url, signal);
      if (body === null) return null;
      if (
        typeof body.version !== "string" ||
        (body.channel !== "stable" && body.channel !== "beta")
      ) {
        throw new Error(`registry latest schema invalid: ${JSON.stringify(body)}`);
      }
      return { version: body.version, channel: body.channel };
    },

    async fetchManifest(id, version, signal) {
      const url = `${baseUrl}/v1/extensions/${encodeURIComponent(id)}/manifest?version=${encodeURIComponent(version)}`;
      const body = await getJson<Record<string, unknown>>(url, signal);
      if (body === null) {
        throw new Error(`registry manifest not found: ${id}@${version}`);
      }
      const manifestHash = body["manifestHash"];
      const entryHash = body["entryHash"];
      const tarballUrl = body["tarballUrl"];
      const manifestRaw = body["manifest"];
      const tarballSizeRaw = body["tarballSizeBytes"];
      if (
        typeof manifestHash !== "string" ||
        !HEX64.test(manifestHash) ||
        typeof entryHash !== "string" ||
        !HEX64.test(entryHash) ||
        typeof tarballUrl !== "string" ||
        typeof manifestRaw !== "object" ||
        manifestRaw === null
      ) {
        throw new Error("registry manifest schema invalid");
      }
      const manifest = parseExtensionManifestJson(JSON.stringify(manifestRaw));
      const tarballSizeBytes = typeof tarballSizeRaw === "number" ? tarballSizeRaw : undefined;
      return {
        manifest,
        manifestRaw: manifestRaw as Record<string, unknown>,
        manifestHash,
        entryHash,
        tarballUrl,
        ...(tarballSizeBytes !== undefined ? { tarballSizeBytes } : {}),
      };
    },
  };
}
