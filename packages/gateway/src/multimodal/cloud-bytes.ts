// packages/gateway/src/multimodal/cloud-bytes.ts
/**
 * The cloud arm of byte acquisition (spec § 16.2). Contacts NO model — that separation is what
 * makes `media-gate.ts`'s chokepoint claim checkable, exactly as for the local arm.
 *
 * Three properties the tests pin:
 *  - ONE `sync`-class egress row is appended BEFORE the request and an append failure ABORTS it,
 *    so a zero-row window means no bytes were fetched, never that some were fetched unrecorded;
 *  - a credential rides only on a URL we constructed (§ 16.4);
 *  - the run budget is evaluated PER CHUNK, so an overrun aborts the transfer instead of paying
 *    for the whole artifact and then declining it.
 */
import { randomUUID } from "node:crypto";
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
  | { readonly ok: false; readonly reason: SkipReason }
  | {
      readonly ok: false;
      readonly stop: "budget_exhausted" | "rate_limited";
      readonly fetched: number;
    };

const MAX_429_RETRIES = 2;

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

export async function fetchCloudBytes(
  candidate: MediaCandidate,
  byteUrl: ByteUrl,
  deps: CloudBytesDeps,
): Promise<CloudBytes> {
  // A provider-returned URL is pinned to https: (spec § 16.4). `assertSafeUrl` permits both
  // schemes — it guards the HOST, not the transport — so this check is not redundant with it.
  // Checked BEFORE the ledger append: a URL we will never fetch should not produce an egress row
  // claiming we did.
  if (byteUrl.kind === "provider") {
    let parsed: URL;
    try {
      parsed = new URL(byteUrl.url);
    } catch {
      return { ok: false, reason: "fetch_miss" };
    }
    if (parsed.protocol !== "https:") return { ok: false, reason: "fetch_miss" };
  }

  // Fail-closed: append first. A throw here propagates and no request is made.
  deps.appendEgress({ destination: candidate.service, method: "media.fetchBytes" });

  const headers: Record<string, string> = {};
  if (byteUrl.bearer) {
    const token = await deps.bearerFor(candidate.service);
    if (token === null) return { ok: false, reason: "not_configured" };
    headers["Authorization"] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  let res: Response;
  for (let attempt = 0; ; attempt += 1) {
    res = await deps.fetchFn(byteUrl.url, { headers, signal: controller.signal });
    if (res.status !== 429 && res.status !== 503) break;
    if (attempt >= MAX_429_RETRIES) return { ok: false, stop: "rate_limited", fetched: 0 };
    const retryAfter = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 2 ** attempt * 1000;
    await deps.sleep(waitMs + Math.floor(Math.random() * 250));
  }
  if (!res.ok) return { ok: false, reason: "fetch_miss" };

  // A declared length lets an oversized artifact be refused without transferring it at all.
  // Both bounds are checked here, not just the per-artifact one: streaming 10 MB of a 500 MB file
  // before tripping the run budget spends exactly the resource the budget exists to conserve.
  // `content-length` is a HINT, not a guarantee — it can be absent, or wrong — so the per-chunk
  // checks below still run. This is an optimisation over them, never a replacement.
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared)) {
    if (declared > deps.maxBytes) {
      controller.abort();
      return { ok: false, reason: "over_byte_cap" };
    }
    if (declared > deps.remainingBudget) {
      controller.abort();
      return { ok: false, stop: "budget_exhausted", fetched: 0 };
    }
  }

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
        return { ok: false, reason: "over_byte_cap" };
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

/** Resolves once the stream has flushed and closed the underlying file descriptor. */
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
 */
async function collectToScratch(
  res: Response,
  controller: AbortController,
  deps: CloudBytesDeps,
): Promise<CloudBytes> {
  const path = join(deps.scratchDir, `${CLOUD_SCRATCH_PREFIX}${randomUUID()}`);
  const ws = createWriteStream(path, { mode: 0o600 });
  let succeeded = false;
  try {
    let fetched = 0;
    const body = res.body;
    if (body !== null) {
      const reader = body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value === undefined) continue;
          fetched += value.byteLength;
          if (fetched > deps.maxBytes) {
            controller.abort();
            return { ok: false, reason: "over_byte_cap" };
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
    }
    await closeStream(ws);
    succeeded = true;
    return { ok: true, kind: "path", path, fetched };
  } finally {
    if (!succeeded) {
      ws.destroy();
      try {
        rmSync(path, { force: true });
      } catch {
        // Best-effort: a filesystem that rejects the removal does not change the outcome already
        // decided above.
      }
    }
  }
}
