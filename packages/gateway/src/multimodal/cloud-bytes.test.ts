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

  test("refuses over the per-artifact cap rather than truncating", async () => {
    const deps = fakeDeps({ maxBytes: 1, fetchFn: async () => new Response("ABCDEF") });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, reason: "over_byte_cap" });
  });

  test("stops the RUN when the streaming budget is exhausted mid-download", async () => {
    const deps = fakeDeps({ remainingBudget: 3, fetchFn: async () => new Response("ABCDEFGHIJ") });
    const r = await fetchCloudBytes(imageCandidate, providerUrl, deps);
    expect(r).toEqual({ ok: false, stop: "budget_exhausted", fetched: expect.any(Number) });
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

  test("a 404 is a per-item fetch_miss, not a run stop", async () => {
    const deps = fakeDeps({ fetchFn: async () => new Response(null, { status: 404 }) });
    expect(await fetchCloudBytes(imageCandidate, providerUrl, deps)).toEqual({
      ok: false,
      reason: "fetch_miss",
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

  test("a budget stop mid-download deletes the partial scratch file", async () => {
    const deps = fakeDeps({ remainingBudget: 3, fetchFn: async () => new Response("ABCDEFGHIJ") });
    await fetchCloudBytes(avCandidate, providerUrl, deps);
    expect(readdirSync(deps.scratchDir).filter((n) => n.startsWith("nimbus-media-"))).toEqual([]);
  });
});
