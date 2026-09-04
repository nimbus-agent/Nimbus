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

  test("photos RE-RESOLVES baseUrl rather than trusting the indexed one", async () => {
    let requested = "";
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async (u) => {
        requested = u;
        return new Response(JSON.stringify({ baseUrl: "https://lh3.example/fresh" }));
      },
    });
    expect(requested).toContain("/v1/mediaItems/p1");
    expect(r).toEqual({ kind: "provider", url: "https://lh3.example/fresh", bearer: false });
  });

  test("photos with no baseUrl in the response is a fetch_miss, not a crash", async () => {
    const r = await resolveCloudByteUrl(photosCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () => new Response(JSON.stringify({ id: "p1" })),
    });
    expect(r).toEqual({ error: "fetch_miss" });
  });

  test("onedrive reads @microsoft.graph.downloadUrl", async () => {
    const r = await resolveCloudByteUrl(onedriveCandidate, false, {
      bearerFor: async () => "tok",
      fetchFn: async () =>
        new Response(
          JSON.stringify({ "@microsoft.graph.downloadUrl": "https://x.sharepoint.test/d" }),
        ),
    });
    expect(r).toEqual({ kind: "provider", url: "https://x.sharepoint.test/d", bearer: false });
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
});
