import { describe, expect, test } from "bun:test";
import { resolveCloudByteUrl } from "./cloud-url-resolver.ts";
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

const driveCandidate: MediaCandidate = BASE;

const photosCandidate: MediaCandidate = {
  ...BASE,
  itemId: "google_photos:p1",
  service: "google_photos",
  externalId: "p1",
};

const onedriveCandidate: MediaCandidate = {
  ...BASE,
  itemId: "onedrive:o1",
  service: "onedrive",
  externalId: "o1",
};

describe("resolveCloudByteUrl", () => {
  test("drive needs no round-trip — the URL is constructed from the external id", async () => {
    let called = false;
    const r = await resolveCloudByteUrl(driveCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect(called).toBe(false);
    expect(r).toEqual({
      kind: "constructed",
      url: expect.stringContaining("alt=media"),
      bearer: true,
    });
  });

  test("a rendition preference makes no difference to a Drive URL — driveByteUrl takes none", async () => {
    const deps = { bearerFor: async () => "tok", fetchFn: async () => new Response("{}") };
    const withRenditions = await resolveCloudByteUrl(driveCandidate, true, deps);
    const without = await resolveCloudByteUrl(driveCandidate, false, deps);
    expect(withRenditions).toEqual(without);
  });

  test("photos RE-RESOLVES baseUrl rather than trusting the indexed one, over an authenticated, non-redirect-following request", async () => {
    let requested = "";
    let init: RequestInit | undefined;
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "photos-tok",
      fetchFn: async (u, i) => {
        requested = u;
        init = i;
        return new Response(JSON.stringify({ baseUrl: "https://lh3.example/fresh" }));
      },
    });
    expect(requested).toBe("https://photoslibrary.googleapis.com/v1/mediaItems/p1");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer photos-tok");
    expect(init?.redirect).toBe("manual");
    expect(r).toEqual({ kind: "provider", url: "https://lh3.example/fresh", bearer: false });
  });

  test("photos with no baseUrl in the response is a fetch_miss, not a crash", async () => {
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response(JSON.stringify({ id: "p1" })),
    });
    expect(r).toEqual({ error: "fetch_miss" });
  });

  test("onedrive reads @microsoft.graph.downloadUrl, over an authenticated, non-redirect-following request", async () => {
    let requested = "";
    let init: RequestInit | undefined;
    const r = await resolveCloudByteUrl(onedriveCandidate, false, {
      bearerFor: async () => "od-tok",
      fetchFn: async (u, i) => {
        requested = u;
        init = i;
        return new Response(
          JSON.stringify({ "@microsoft.graph.downloadUrl": "https://x.sharepoint.test/d" }),
        );
      },
    });
    expect(requested).toBe("https://graph.microsoft.com/v1.0/me/drive/items/o1");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer od-tok");
    expect(init?.redirect).toBe("manual");
    expect(r).toEqual({ kind: "provider", url: "https://x.sharepoint.test/d", bearer: false });
  });

  test("onedrive with no downloadUrl in the response is a fetch_miss, not a crash", async () => {
    const r = await resolveCloudByteUrl(onedriveCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response(JSON.stringify({ id: "o1" })),
    });
    expect(r).toEqual({ error: "fetch_miss" });
  });

  test("a missing credential is not_configured, and no request is made", async () => {
    let called = false;
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => null,
      fetchFn: async () => {
        called = true;
        return new Response("{}");
      },
    });
    expect(r).toEqual({ error: "not_configured" });
    expect(called).toBe(false);
  });

  test("an unknown service resolves nothing rather than guessing", async () => {
    const r = await resolveCloudByteUrl({ ...photosCandidate, service: "dropbox" }, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response("{}"),
    });
    expect(r).toEqual({ error: "unresolvable_modality" });
  });

  test("a 429 is reported as rate_limited, distinct from any other failure", async () => {
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response("rate limited", { status: 429 }),
    });
    expect(r).toEqual({ error: "rate_limited" });
  });

  test("a non-429 error status is a fetch_miss", async () => {
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response("server error", { status: 500 }),
    });
    expect(r).toEqual({ error: "fetch_miss" });
  });

  test("a 200 whose body is not JSON at all is a fetch_miss, not an uncaught throw", async () => {
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response("<html>not json</html>"),
    });
    expect(r).toEqual({ error: "fetch_miss" });
  });

  test("a transport failure from fetchFn itself is a fetch_miss, not an uncaught throw", async () => {
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(r).toEqual({ error: "fetch_miss" });
  });
});
