import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { type CloudBytesDeps, fetchCloudBytes } from "./cloud-bytes.ts";
import type { ByteUrl } from "./cloud-renditions.ts";
import type { MediaCandidate } from "./media-types.ts";

const BASE: MediaCandidate = {
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

const imageCandidate: MediaCandidate = BASE;

const avCandidate: MediaCandidate = {
  ...BASE,
  itemId: "google_drive:1Vid",
  externalId: "1Vid",
  type: "media_av",
  modality: "av",
  sourceMime: "video/mp4",
};

const providerUrl: ByteUrl = { kind: "provider", url: "https://example.test/i.jpg", bearer: false };
const constructedUrl: ByteUrl = {
  kind: "constructed",
  url: "https://www.googleapis.com/drive/v3/files/1AbC?alt=media",
  bearer: true,
};

function fakeDeps(overrides: Partial<CloudBytesDeps> = {}): CloudBytesDeps {
  return {
    scratchDir: mkdtempSync(join(tmpdir(), "nimbus-cloud-bytes-")),
    maxBytes: 1_000_000_000,
    remainingBudget: 1_000_000_000,
    bearerFor: async () => "test-token",
    appendEgress: () => ({ rowHash: "h" }),
    fetchFn: async () => new Response("AB"),
    sleep: async () => undefined,
    ...overrides,
  };
}

/**
 * A `ReadableStream` that yields `parts` one at a time, tracking which indexes were actually
 * pulled. A ZERO high-water mark is load-bearing: Bun's default queuing strategy pulls the first
 * chunk EAGERLY at construction, before any reader ever attaches, which would make `pulledIndexes`
 * lie about whether a chunk was genuinely consumed by a real `read()` call (see the sibling
 * comment below, on the declared-length test, for the same trap in its single-chunk form).
 *
 * Distinct from a single big string body (used by several tests below): a string body arrives as
 * ONE chunk in Bun, which cannot distinguish "checked once at the end" from "checked per chunk".
 * This fixture makes that distinction observable — and, because `content-length` is never set on
 * a streamed body built this way, it also can't accidentally be satisfied by the content-length
 * PRE-check instead of the per-chunk streaming check it exists to exercise.
 */
function chunkedStream(parts: readonly string[]): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly pulledIndexes: number[];
} {
  const pulledIndexes: number[] = [];
  let i = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (i >= parts.length) {
          controller.close();
          return;
        }
        pulledIndexes.push(i);
        controller.enqueue(new TextEncoder().encode(parts[i]));
        i += 1;
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
  );
  return { stream, pulledIndexes };
}

describe("fetchCloudBytes", () => {
  test("appends ONE sync egress row BEFORE the request", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      appendEgress: () => {
        order.push("egress");
        return { rowHash: "h" };
      },
      fetchFn: async () => {
        order.push("fetch");
        return new Response("AB");
      },
    });
    await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(order).toEqual(["egress", "fetch"]);
  });

  test("appends one egress row PER ATTEMPT, not once for the whole retry loop", async () => {
    const order: string[] = [];
    let calls = 0;
    const deps = fakeDeps({
      appendEgress: () => {
        order.push("egress");
        return { rowHash: "h" };
      },
      fetchFn: async () => {
        order.push("fetch");
        calls += 1;
        // Two 429s, then a success — three real outbound attempts.
        if (calls < 3) {
          return new Response(null, { status: 429, headers: { "retry-after": "0" } });
        }
        return new Response("AB");
      },
    });
    await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(order).toEqual(["egress", "fetch", "egress", "fetch", "egress", "fetch"]);
  });

  test("an egress append failure ABORTS — fail-closed, no request is made", async () => {
    let fetched = false;
    const deps = fakeDeps({
      appendEgress: () => {
        throw new Error("ledger down");
      },
      fetchFn: async () => {
        fetched = true;
        return new Response("AB");
      },
    });
    await expect(fetchCloudBytes(imageCandidate, providerUrl, deps)).rejects.toThrow("ledger down");
    expect(fetched).toBe(false);
  });

  test("a throwing fetchFn yields a per-item fetch_miss, not a crashed pass", async () => {
    // Production `fetchFn` is `safeFetchFollowing`, which THROWS for a private-address target, an
    // unsafe URL, or too many redirects — a single hostile provider-returned URL must skip this
    // ONE item rather than rejecting the whole pass.
    const order: string[] = [];
    const deps = fakeDeps({
      appendEgress: () => {
        order.push("egress");
        return { rowHash: "h" };
      },
      fetchFn: async () => {
        throw new Error("unsafe url: host resolves to private 127.0.0.1");
      },
    });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, reason: "fetch_miss", fetched: 0 });
    // The append still ran: the try/catch wraps ONLY the fetch call, so a failing appender (tested
    // separately above) keeps propagating rather than being swallowed here.
    expect(order).toEqual(["egress"]);
  });

  test("NO Authorization header on a provider-returned URL", async () => {
    let seen: Headers | undefined;
    const deps = fakeDeps({
      fetchFn: async (_u, init) => {
        seen = new Headers(init?.headers);
        return new Response("AB");
      },
    });
    await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(seen?.has("authorization")).toBe(false);
  });

  test("Authorization IS present on a constructed URL", async () => {
    let seen: Headers | undefined;
    const deps = fakeDeps({
      fetchFn: async (_u, init) => {
        seen = new Headers(init?.headers);
        return new Response("AB");
      },
    });
    await fetchCloudBytes(imageCandidate, constructedUrl, deps);
    expect(seen?.get("authorization")).toBe("Bearer test-token");
  });

  test("bearerFor returning null skips the request as not_configured, before any egress row", async () => {
    const order: string[] = [];
    const deps = fakeDeps({
      bearerFor: async () => null,
      appendEgress: () => {
        order.push("egress");
        return { rowHash: "h" };
      },
      fetchFn: async () => {
        order.push("fetch");
        return new Response("AB");
      },
    });
    const r = await fetchCloudBytes(imageCandidate, constructedUrl, deps);
    expect(r).toEqual({ ok: false, reason: "not_configured", fetched: 0 });
    // A request that can never be made must not produce a row claiming one was.
    expect(order).toEqual([]);
  });

  test("refuses a provider-returned http: URL", async () => {
    const insecure: ByteUrl = { kind: "provider", url: "http://example.test/i.jpg", bearer: false };
    let fetched = false;
    const deps = fakeDeps({
      fetchFn: async () => {
        fetched = true;
        return new Response("AB");
      },
    });
    expect(await fetchCloudBytes(imageCandidate, insecure, deps)).toEqual({
      ok: false,
      reason: "fetch_miss",
      fetched: 0,
    });
    expect(fetched).toBe(false);
  });

  test("refuses BEFORE streaming when the declared length exceeds the run budget", async () => {
    let bodyRead = false;
    const deps = fakeDeps({
      remainingBudget: 10,
      fetchFn: async () =>
        new Response(
          // A default `ReadableStream` is pulled EAGERLY at construction, before any reader
          // attaches, to fill its default highWaterMark:1 — that would fire `pull()` regardless
          // of whether this function ever reads the body, making the assertion below pass against
          // a broken implementation too. A zero high-water mark means `pull()` fires ONLY on a
          // real read.
          new ReadableStream(
            {
              pull() {
                bodyRead = true;
              },
            },
            new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
          ),
          { headers: { "content-length": "500000000" } },
        ),
    });
    expect(await fetchCloudBytes(imageCandidate, providerUrl, deps)).toEqual({
      ok: false,
      stop: "budget_exhausted",
      fetched: 0,
    });
    expect(bodyRead).toBe(false);
  });

  test("refuses over the per-artifact cap PER CHUNK, not only via the content-length hint", async () => {
    const { stream, pulledIndexes } = chunkedStream(["AB", "CDEFGH", "IJ"]);
    const deps = fakeDeps({ maxBytes: 5, fetchFn: async () => new Response(stream) });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    // Chunk 1 (2 bytes) stays under the 5-byte cap; chunk 2 (6 more, 8 cumulative) crosses it —
    // `fetched` reports the bytes that actually crossed the wire before the refusal, same
    // convention as the `stop` arm.
    expect(r).toEqual({ ok: false, reason: "over_byte_cap", fetched: 8 });
    // Chunk 3 is never pulled: the per-chunk check aborts as soon as chunk 2 alone crosses the
    // cap, rather than reading the whole body first and refusing at the end.
    expect(pulledIndexes).toEqual([0, 1]);
  });

  test("stops the RUN when the streaming budget is exhausted mid-download, PER CHUNK", async () => {
    const { stream, pulledIndexes } = chunkedStream(["AB", "CDEFGH", "IJ"]);
    const deps = fakeDeps({ remainingBudget: 5, fetchFn: async () => new Response(stream) });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, stop: "budget_exhausted", fetched: 8 });
    expect(pulledIndexes).toEqual([0, 1]);
  });

  test("a 429 that persists stops the run rather than skipping the item", async () => {
    const deps = fakeDeps({
      fetchFn: async () => new Response(null, { status: 429, headers: { "retry-after": "0" } }),
    });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    // The `stop` variant of `CloudBytes` always carries `fetched: number` — a 429 never streams
    // any bytes, so `fetched` is 0, not absent.
    expect(r).toEqual({ ok: false, stop: "rate_limited", fetched: 0 });
  });

  test("a large Retry-After is clamped rather than slept in full", async () => {
    const waits: number[] = [];
    const deps = fakeDeps({
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchFn: async () => new Response(null, { status: 429, headers: { "retry-after": "86400" } }),
    });
    await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(waits).toHaveLength(2); // MAX_429_RETRIES
    for (const ms of waits) {
      // 30s clamp plus up to 250ms of jitter — never the unclamped 86,400,000ms a lying/huge
      // Retry-After would otherwise produce.
      expect(ms).toBeLessThanOrEqual(30_250);
    }
  });

  test("a 404 is a per-item fetch_miss, not a run stop", async () => {
    const deps = fakeDeps({ fetchFn: async () => new Response(null, { status: 404 }) });
    expect(await fetchCloudBytes(imageCandidate, providerUrl, deps)).toEqual({
      ok: false,
      reason: "fetch_miss",
      fetched: 0,
    });
  });

  test("an AV artifact lands in an extensionless scratch file that is 0600", async () => {
    const deps = fakeDeps({ fetchFn: async () => new Response("AB") });
    const r = await fetchCloudBytes(avCandidate, providerUrl, deps);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "path") {
      expect(basename(r.path).startsWith("nimbus-media-")).toBe(true);
      expect(extname(r.path)).toBe("");
      if (process.platform !== "win32") {
        expect(statSync(r.path).mode & 0o777).toBe(0o600);
      }
    }
  });

  test("an over-cap refusal before ANY chunk is written still leaves no scratch file", async () => {
    // `createWriteStream` opens its file descriptor ASYNCHRONOUSLY. On this path the very first
    // chunk (6 bytes) already exceeds the 1-byte cap, so the refusal is decided before a single
    // `writeChunk` ever runs — the exact case where an `rmSync` that doesn't wait for the fd to
    // finish opening removes nothing, and the still-pending open then creates the file moments
    // later, after this function has already returned.
    const deps = fakeDeps({ maxBytes: 1, fetchFn: async () => new Response("ABCDEF") });
    const r = await fetchCloudBytes(avCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, reason: "over_byte_cap", fetched: 6 });
    // The delay is load-bearing: an assertion made immediately after `await fetchCloudBytes(...)`
    // resolves cannot distinguish "the file was properly removed" from "the file doesn't exist
    // YET" — the exact trap that let a prior version of this fix look correct. Giving the
    // once-pending `open` a real chance to complete is what makes this test able to fail.
    await new Promise((r2) => setTimeout(r2, 250));
    expect(readdirSync(deps.scratchDir).filter((n) => n.startsWith("nimbus-media-"))).toEqual([]);
  });

  test("a budget stop mid-download deletes the partial scratch file — after a real chunk was written", async () => {
    const { stream } = chunkedStream(["AB", "CDEFGH", "IJ"]);
    const deps = fakeDeps({ remainingBudget: 5, fetchFn: async () => new Response(stream) });
    const r = await fetchCloudBytes(avCandidate, providerUrl, deps);
    // Chunk 1 (2 bytes) is genuinely written to disk before chunk 2 crosses the budget — this
    // exercises cleanup of a file that really has content, not merely an opened-but-empty fd.
    expect(r).toEqual({ ok: false, stop: "budget_exhausted", fetched: 8 });
    expect(readdirSync(deps.scratchDir).filter((n) => n.startsWith("nimbus-media-"))).toEqual([]);
  });
});
