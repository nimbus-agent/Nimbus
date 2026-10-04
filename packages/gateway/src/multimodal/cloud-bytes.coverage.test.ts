/**
 * Arms of the cloud byte-fetch that `cloud-bytes.test.ts` leaves unexercised: a provider URL that
 * does not parse, the declared-length pre-check refusing on the per-artifact cap (and admitting a
 * length exactly at both bounds), the exponential backoff a 429 without `Retry-After` falls back
 * to, and scratch cleanup for a stream whose own open failed.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createWriteStream, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CloudBytesDeps, cleanupFailedScratch, fetchCloudBytes } from "./cloud-bytes.ts";
import type { ByteUrl } from "./cloud-renditions.ts";
import type { MediaCandidate } from "./media-types.ts";

const SCRATCH = mkdtempSync(join(tmpdir(), "nimbus-cloud-bytes-cov-"));
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

const image: MediaCandidate = {
  itemId: "google_drive:1AbC",
  service: "google_drive",
  externalId: "1AbC",
  type: "media_image",
  title: "a.png",
  url: null,
  modality: "image",
  sourcePath: null,
  sourceMime: "image/png",
  sourceBytes: 10,
};

const providerUrl: ByteUrl = { kind: "provider", url: "https://example.test/i.jpg", bearer: false };

type Recorded = { egress: string[]; fetches: { url: string; signal: AbortSignal | null }[] };

function deps(overrides: Partial<CloudBytesDeps> = {}): { deps: CloudBytesDeps; seen: Recorded } {
  const seen: Recorded = { egress: [], fetches: [] };
  return {
    seen,
    deps: {
      scratchDir: SCRATCH,
      maxBytes: 1_000,
      remainingBudget: 1_000,
      bearerFor: () => Promise.resolve("test-token"),
      appendEgress: (row) => {
        seen.egress.push(`${row.destination} ${row.method}`);
        return { rowHash: "h" };
      },
      fetchFn: (url, init) => {
        seen.fetches.push({ url, signal: init.signal ?? null });
        return Promise.resolve(new Response("AB"));
      },
      sleep: () => Promise.resolve(),
      ...overrides,
    },
  };
}

/** A body whose `pull()` runs ONLY on a real read (zero high-water mark — see cloud-bytes.test.ts). */
function untouchedBody(): { body: ReadableStream<Uint8Array>; pulled: () => boolean } {
  let pulled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulled = true;
        controller.close();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
  );
  return { body, pulled: () => pulled };
}

describe("fetchCloudBytes — pre-request refusals", () => {
  test("a provider URL that does not parse is a fetch_miss with no egress row and no request", async () => {
    const { deps: d, seen } = deps();
    const r = await fetchCloudBytes(
      image,
      { kind: "provider", url: "not a url", bearer: false },
      d,
    );
    expect(r).toEqual({ ok: false, reason: "fetch_miss", fetched: 0 });
    expect(seen.egress).toEqual([]);
    expect(seen.fetches).toEqual([]);
  });
});

describe("fetchCloudBytes — the declared content-length", () => {
  test("a length over the per-artifact cap is refused before one byte streams", async () => {
    const { body, pulled } = untouchedBody();
    const { deps: d, seen } = deps({
      maxBytes: 100,
      remainingBudget: 1_000_000,
      fetchFn: (url, init) => {
        seen.fetches.push({ url, signal: init.signal ?? null });
        return Promise.resolve(new Response(body, { headers: { "content-length": "101" } }));
      },
    });
    expect(await fetchCloudBytes(image, providerUrl, d)).toEqual({
      ok: false,
      reason: "over_byte_cap",
      fetched: 0,
    });
    expect(pulled()).toBe(false);
    // The transfer is aborted, not merely abandoned.
    expect(seen.fetches).toHaveLength(1);
    expect(seen.fetches[0]?.signal?.aborted).toBe(true);
    expect(seen.egress).toEqual(["google_drive media.fetchBytes"]);
  });

  test("a length exactly at both the cap and the budget is admitted and streamed", async () => {
    const { deps: d, seen } = deps({
      maxBytes: 6,
      remainingBudget: 6,
      fetchFn: (url, init) => {
        seen.fetches.push({ url, signal: init.signal ?? null });
        return Promise.resolve(new Response("ABCDEF", { headers: { "content-length": "6" } }));
      },
    });
    const r = await fetchCloudBytes(image, providerUrl, d);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "bytes") {
      expect(new TextDecoder().decode(r.bytes)).toBe("ABCDEF");
      expect(r.fetched).toBe(6);
    } else {
      throw new Error(`expected in-memory bytes, got ${JSON.stringify(r)}`);
    }
    expect(seen.fetches[0]?.signal?.aborted).toBe(false);
  });
});

describe("fetchCloudBytes — rate-limit backoff", () => {
  test("a 429 without Retry-After backs off exponentially (1 s, then 2 s, plus jitter)", async () => {
    const waits: number[] = [];
    const statuses = [429, 503, 200];
    const { deps: d, seen } = deps({
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      fetchFn: (url, init) => {
        seen.fetches.push({ url, signal: init.signal ?? null });
        const status = statuses.shift() ?? 500;
        return Promise.resolve(new Response(status === 200 ? "AB" : null, { status }));
      },
    });
    const r = await fetchCloudBytes(image, providerUrl, d);
    expect(r).toMatchObject({ ok: true, kind: "bytes", fetched: 2 });
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(1_000);
    expect(waits[0]).toBeLessThan(1_250);
    expect(waits[1]).toBeGreaterThanOrEqual(2_000);
    expect(waits[1]).toBeLessThan(2_250);
    // One row per attempt: two rate-limited attempts and the one that succeeded.
    expect(seen.egress).toHaveLength(3);
  });
});

describe("cleanupFailedScratch", () => {
  test("a stream whose own open failed is cleaned up without the cleanup itself throwing", async () => {
    // The parent directory does not exist, so the stream's open fails with ENOENT — its `close`
    // wait then REJECTS rather than resolving, and cleanup must swallow that, not surface it.
    const path = join(SCRATCH, "no-such-dir", "nimbus-media-open-failed");
    const ws = createWriteStream(path, { mode: 0o600 });
    expect(ws.closed).toBe(false);
    await expect(cleanupFailedScratch(ws, path)).resolves.toBeUndefined();
    expect(ws.destroyed).toBe(true);
    // Cleanup returned only once the stream had finished closing. A cleanup that skipped the wait
    // would return while the failed open is still in flight; its late ENOENT would then surface as
    // an unhandled error in whichever test file happens to run next, not here.
    expect(ws.closed).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(SCRATCH, "no-such-dir"))).toBe(false);
  });
});
