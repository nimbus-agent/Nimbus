import { afterEach, describe, expect, test } from "bun:test";
import { fetchUpdateManifest, ManifestFetchError } from "./manifest-fetcher.ts";
import { jsonResponse } from "./testing/updater-test-fixtures.ts";
import type { UpdateManifest } from "./types.ts";

let server: ReturnType<typeof Bun.serve>;
let url: string;

function sampleManifest(): UpdateManifest {
  return {
    version: "0.2.0",
    pub_date: "2026-05-01T00:00:00Z",
    notes: "Test",
    platforms: {
      "darwin-x86_64": {
        url: "https://example/darwin",
        sha256: "a".repeat(64),
        signature: "sig",
      },
      "darwin-aarch64": {
        url: "https://example/darwin-arm",
        sha256: "a".repeat(64),
        signature: "sig",
      },
      "linux-x86_64": {
        url: "https://example/linux",
        sha256: "a".repeat(64),
        signature: "sig",
      },
      "windows-x86_64": {
        url: "https://example/windows",
        sha256: "a".repeat(64),
        signature: "sig",
      },
    },
  };
}

describe("fetchUpdateManifest", () => {
  afterEach(() => {
    server?.stop(true);
  });

  test("parses a well-formed manifest", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => jsonResponse(sampleManifest()),
    });
    url = `http://127.0.0.1:${server.port}/latest.json`;
    const manifest = await fetchUpdateManifest(url, { timeoutMs: 2000 });
    expect(manifest.version).toBe("0.2.0");
    expect(manifest.platforms["linux-x86_64"]?.url).toBe("https://example/linux");
  });

  test("throws ManifestFetchError on 404", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not found", { status: 404 }),
    });
    url = `http://127.0.0.1:${server.port}/latest.json`;
    await expect(fetchUpdateManifest(url, { timeoutMs: 2000 })).rejects.toBeInstanceOf(
      ManifestFetchError,
    );
  });

  test("throws on malformed JSON", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not json", { status: 200 }),
    });
    url = `http://127.0.0.1:${server.port}/latest.json`;
    await expect(fetchUpdateManifest(url, { timeoutMs: 2000 })).rejects.toBeInstanceOf(
      ManifestFetchError,
    );
  });

  test("throws on missing required fields", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => jsonResponse({ version: "0.2.0", pub_date: "2026-05-01T00:00:00Z" }),
    });
    url = `http://127.0.0.1:${server.port}/latest.json`;
    await expect(fetchUpdateManifest(url, { timeoutMs: 2000 })).rejects.toThrow(/platforms/);
  });

  test("times out when server hangs", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async () => {
        await Bun.sleep(500);
        return jsonResponse(sampleManifest());
      },
    });
    url = `http://127.0.0.1:${server.port}/latest.json`;
    await expect(fetchUpdateManifest(url, { timeoutMs: 50 })).rejects.toThrow(/timeout|abort/i);
  });
});
