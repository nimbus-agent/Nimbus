// packages/gateway/src/multimodal/cloud-bytes.ts
/**
 * The cloud arm of byte acquisition (spec § 16.2). Contacts NO model — that separation is what
 * makes `media-gate.ts`'s chokepoint claim checkable, exactly as for the local arm.
 *
 * Three properties the tests pin:
 *  - ONE `sync`-class egress row is appended BEFORE the request and an append failure ABORTS it,
 *    so a zero-row window means no bytes were fetched, never that some were fetched unrecorded —
 *    appended PER ATTEMPT (not once per call), since a retried request is a second real outbound
 *    request and I29's `model` class already establishes that one prompt can produce N ledgered
 *    rows across N attempts (see `egress/model-egress.ts`'s doc comment) — deduplicating would
 *    misstate that a single row covered up to three real requests;
 *  - a credential rides only on a URL we constructed (§ 16.4);
 *  - the run budget is evaluated PER CHUNK, so an overrun aborts the transfer instead of paying
 *    for the whole artifact and then declining it.
 */
import { randomInt, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, rmSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import type { ByteUrl } from "./cloud-renditions.ts";
import type { MediaCandidate, SkipReason } from "./media-types.ts";
import { CLOUD_SCRATCH_PREFIX } from "./stt/ffmpeg-bin.ts";

export type CloudBytes =
  | {
      readonly ok: true;
      readonly kind: "bytes";
      readonly bytes: Uint8Array;
      readonly fetched: number;
    }
  | { readonly ok: true; readonly kind: "path"; readonly path: string; readonly fetched: number }
  | { readonly ok: false; readonly reason: SkipReason; readonly fetched: number }
  | {
      readonly ok: false;
      readonly stop: "budget_exhausted" | "rate_limited";
      readonly fetched: number;
    };

const MAX_429_RETRIES = 2;

/**
 * A provider-controlled `Retry-After` must not be able to stall a run for hours: the HTTP-date
 * form already degrades safely to exponential backoff, and a negative value is left to the
 * timer underneath `deps.sleep` (a negative delay is treated as 0, per the standard timer
 * semantics, not clamped here) — but an untrusted large integer (`Retry-After: 86400`) would
 * otherwise sleep for a full day, twice, inside the pass. This bound handles that case only.
 */
const MAX_RETRY_AFTER_MS = 30_000;

export interface CloudBytesDeps {
  readonly scratchDir: string;
  /** Per-artifact cap for this modality. Refuses, never truncates (spec § 5.3). */
  readonly maxBytes: number;
  /** Bytes still permitted this RUN. Reaching zero stops the pass (spec § 16.9). */
  readonly remainingBudget: number;
  /** Resolved only for a `constructed` URL — never called for a provider-returned one. */
  readonly bearerFor: (service: string) => Promise<string | null>;
  /**
   * Appends ONE `sync` row. THROWS to abort — fail-closed. Injected rather than importing
   * `appendEgressEntry`, which static rule D22(b) confines to `egress/*`.
   */
  readonly appendEgress: (row: {
    destination: string;
    method: string;
  }) => { rowHash: string } | undefined;
  readonly fetchFn: (url: string, init: RequestInit) => Promise<Response>;
  readonly sleep: (ms: number) => Promise<void>;
}

type CloudBytesRefusal = Extract<CloudBytes, { ok: false }>;

/**
 * A provider-returned URL is pinned to https: (spec § 16.4). `assertSafeUrl` permits both
 * schemes — it guards the HOST, not the transport — so this check is not redundant with it.
 * Checked BEFORE the ledger append: a URL we will never fetch should not produce an egress row
 * claiming we did.
 */
function checkProviderUrlScheme(byteUrl: ByteUrl): CloudBytesRefusal | null {
  if (byteUrl.kind !== "provider") return null;
  let parsed: URL;
  try {
    parsed = new URL(byteUrl.url);
  } catch {
    return { ok: false, reason: "fetch_miss", fetched: 0 };
  }
  if (parsed.protocol !== "https:") return { ok: false, reason: "fetch_miss", fetched: 0 };
  return null;
}

/**
 * Resolved BEFORE the ledger append, mirroring the https: check above: a request that can never
 * be made (no credential for a URL that needs one) must not produce a row claiming one was.
 */
async function resolveAuthHeaders(
  byteUrl: ByteUrl,
  candidate: MediaCandidate,
  deps: CloudBytesDeps,
): Promise<{ headers: Record<string, string> } | CloudBytesRefusal> {
  const headers: Record<string, string> = {};
  if (byteUrl.bearer) {
    const token = await deps.bearerFor(candidate.service);
    if (token === null) return { ok: false, reason: "not_configured", fetched: 0 };
    headers["Authorization"] = `Bearer ${token}`;
  }
  return { headers };
}

/**
 * The 429/503 retry loop. Appends one egress row per ATTEMPT (see the module doc comment) and
 * backs off on a rate-limit response, up to {@link MAX_429_RETRIES}.
 */
async function fetchWithRetry(
  byteUrl: ByteUrl,
  candidate: MediaCandidate,
  headers: Record<string, string>,
  controller: AbortController,
  deps: CloudBytesDeps,
): Promise<{ res: Response } | CloudBytesRefusal> {
  for (let attempt = 0; ; attempt += 1) {
    // Fail-closed: append before EACH attempt, not once before the loop — a retry really does
    // dispatch a fresh outbound request. A throw here propagates and no request is made; it is
    // deliberately NOT inside the try/catch below, which covers only the fetch call itself.
    deps.appendEgress({ destination: candidate.service, method: "media.fetchBytes" });
    let res: Response;
    try {
      res = await deps.fetchFn(byteUrl.url, { headers, signal: controller.signal });
    } catch {
      // `safeFetchFollowing` (the production `fetchFn`) THROWS for a private-address target, an
      // unsafe URL, or too many redirects — and the runtime throws on a bare transport failure.
      // A single hostile provider-returned URL must skip this ONE item, not abort the whole pass.
      return { ok: false, reason: "fetch_miss", fetched: 0 };
    }
    if (res.status !== 429 && res.status !== 503) return { res };
    if (attempt >= MAX_429_RETRIES) return { ok: false, stop: "rate_limited", fetched: 0 };
    const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    const waitMs = Number.isFinite(retryAfter)
      ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
      : 2 ** attempt * 1000;
    await deps.sleep(waitMs + randomInt(250));
  }
}

/**
 * A declared length lets an oversized artifact be refused without transferring it at all.
 * Both bounds are checked here, not just the per-artifact one: streaming 10 MB of a 500 MB file
 * before tripping the run budget spends exactly the resource the budget exists to conserve.
 * `content-length` is a HINT, not a guarantee — it can be absent, or wrong — so the per-chunk
 * checks in {@link collectToMemory}/{@link collectToScratch} still run as a backstop for the
 * PERMIT direction (a header that understates the real size). That backstop does NOT exist for
 * the REFUSE direction taken here: a header that OVERSTATES the size refuses the artifact before
 * a single byte streams, with no per-chunk check to overrule a lying provider's inflated number.
 */
function checkDeclaredLength(
  res: Response,
  controller: AbortController,
  deps: CloudBytesDeps,
): CloudBytesRefusal | null {
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (!Number.isFinite(declared)) return null;
  if (declared > deps.maxBytes) {
    controller.abort();
    return { ok: false, reason: "over_byte_cap", fetched: 0 };
  }
  if (declared > deps.remainingBudget) {
    controller.abort();
    return { ok: false, stop: "budget_exhausted", fetched: 0 };
  }
  return null;
}

export async function fetchCloudBytes(
  candidate: MediaCandidate,
  byteUrl: ByteUrl,
  deps: CloudBytesDeps,
): Promise<CloudBytes> {
  const schemeRefusal = checkProviderUrlScheme(byteUrl);
  if (schemeRefusal !== null) return schemeRefusal;

  const auth = await resolveAuthHeaders(byteUrl, candidate, deps);
  if (!("headers" in auth)) return auth;

  const controller = new AbortController();
  const attempt = await fetchWithRetry(byteUrl, candidate, auth.headers, controller, deps);
  if (!("res" in attempt)) return attempt;
  const { res } = attempt;
  if (!res.ok) return { ok: false, reason: "fetch_miss", fetched: 0 };

  const lengthRefusal = checkDeclaredLength(res, controller, deps);
  if (lengthRefusal !== null) return lengthRefusal;

  return candidate.modality === "image"
    ? await collectToMemory(res, controller, deps)
    : await collectToScratch(res, controller, deps);
}

/**
 * Buffers a still image in memory. Only reachable for `modality === "image"` — the AV arm always
 * goes to disk (`collectToScratch`) since a video/audio artifact can be large enough that holding
 * it in memory is the wrong default.
 */
async function collectToMemory(
  res: Response,
  controller: AbortController,
  deps: CloudBytesDeps,
): Promise<CloudBytes> {
  const body = res.body;
  if (body === null) return { ok: true, kind: "bytes", bytes: new Uint8Array(0), fetched: 0 };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let fetched = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      fetched += value.byteLength;
      // Per-chunk, not just at the end: an overrun aborts the transfer rather than paying for
      // the whole artifact and then declining it.
      if (fetched > deps.maxBytes) {
        controller.abort();
        return { ok: false, reason: "over_byte_cap", fetched };
      }
      if (fetched > deps.remainingBudget) {
        controller.abort();
        return { ok: false, stop: "budget_exhausted", fetched };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(fetched);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, kind: "bytes", bytes, fetched };
}

/** Resolves once `chunk` has actually been written (or errored), so backpressure is honoured. */
function writeChunk(ws: WriteStream, chunk: Uint8Array): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    ws.write(chunk, (err) => {
      if (err) reject(err);
      else resolveWrite();
    });
  });
}

/**
 * Resolves once every pending write has flushed. This is the `finish` event, not `close`: the
 * underlying file descriptor closes shortly AFTER `finish`, asynchronously. That distinction does
 * not matter on the success path this function serves (the caller only needs the bytes durably
 * written, not the fd closed) — it does matter on the cleanup path, which is why
 * {@link collectToScratch}'s failure branch waits for `close` itself rather than reusing this.
 */
function closeStream(ws: WriteStream): Promise<void> {
  return new Promise((resolveEnd, reject) => {
    ws.end((err?: Error | null) => {
      if (err) reject(err);
      else resolveEnd();
    });
  });
}

/**
 * Streams an AV artifact to a gateway-owned scratch file rather than holding it in memory.
 *
 * `nimbus-media-<uuid>`, no extension (spec § 5.4): a downloaded artifact's extension is whatever
 * the provider served, and an extension list is guaranteed to drift. The mode goes on CREATION
 * (`createWriteStream(path, { mode: 0o600 })`), not a `chmodSync` afterwards, so there is no
 * window in which the file exists world-readable under a permissive umask. The file is removed on
 * every non-`ok` exit — including a thrown read/write error, not only the two budget refusals —
 * because `succeeded` is set only immediately before the happy-path return, and the `finally`
 * checks it unconditionally.
 *
 * `createWriteStream` opens its file descriptor ASYNCHRONOUSLY. On the reachable path where the
 * very first chunk already exceeds the cap or the budget, this function can reach the cleanup
 * branch before that `open` has completed — an `rmSync` at that moment removes nothing, and the
 * still-pending open then creates the file anyway, moments after this function has already
 * returned. `ws.destroy()` alone does not close synchronously either. The fix is to await the
 * stream's own `close` event before removing: `close` fires only once the fd has genuinely been
 * opened-then-closed, so by the time this function returns, the file is guaranteed to be either
 * never created or created-and-removed — never present.
 */
/**
 * Streams `res.body` into `ws`, chunk by chunk, checking both budgets per chunk (spec § 16.9) —
 * an overrun aborts the transfer and reports it as a refusal rather than a success.
 */
async function streamBodyToFile(
  res: Response,
  controller: AbortController,
  ws: WriteStream,
  deps: CloudBytesDeps,
): Promise<{ fetched: number } | CloudBytesRefusal> {
  const body = res.body;
  if (body === null) return { fetched: 0 };
  let fetched = 0;
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      fetched += value.byteLength;
      if (fetched > deps.maxBytes) {
        controller.abort();
        return { ok: false, reason: "over_byte_cap", fetched };
      }
      if (fetched > deps.remainingBudget) {
        controller.abort();
        return { ok: false, stop: "budget_exhausted", fetched };
      }
      await writeChunk(ws, value);
    }
  } finally {
    reader.releaseLock();
  }
  return { fetched };
}

/**
 * Removes a scratch file a failed collection created. Waits for the stream's own `close` event
 * first — see {@link collectToScratch}'s docstring for why `rmSync` alone races the async open.
 * Both the wait and the removal are best-effort: neither failing changes the outcome already
 * decided by the caller.
 */
async function cleanupFailedScratch(ws: WriteStream, path: string): Promise<void> {
  ws.destroy();
  await once(ws, "close").catch(() => undefined);
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort: a filesystem that rejects the removal does not change the outcome already
    // decided above.
  }
}

async function collectToScratch(
  res: Response,
  controller: AbortController,
  deps: CloudBytesDeps,
): Promise<CloudBytes> {
  const path = join(deps.scratchDir, `${CLOUD_SCRATCH_PREFIX}${randomUUID()}`);
  const ws = createWriteStream(path, { mode: 0o600 });
  let succeeded = false;
  try {
    const streamed = await streamBodyToFile(res, controller, ws, deps);
    if ("ok" in streamed) return streamed;
    await closeStream(ws);
    succeeded = true;
    return { ok: true, kind: "path", path, fetched: streamed.fetched };
  } finally {
    if (!succeeded) await cleanupFailedScratch(ws, path);
  }
}
