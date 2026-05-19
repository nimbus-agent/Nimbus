import { describe, expect, it, mock } from "bun:test";

import { createPublisherKeyFetcher, createRegistryClient } from "./registry-client.ts";
import { encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

function fakeFetch(responses: Array<Response | Error>): typeof fetch {
  let i = 0;
  return mock((_url: string | URL | Request) => {
    const r = responses[i++];
    if (r === undefined) throw new Error("fakeFetch ran out of responses");
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  }) as unknown as typeof fetch;
}

describe("PublisherKeyFetcher", () => {
  it("ok: returns 32-byte pubkey for valid 44-char base64 body", async () => {
    const { pubkey } = generateEd25519Keypair();
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response(encodeBase64(pubkey), { status: 200 })]),
    });
    const result = await f.fetch("test-pub");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.pubkey).toEqual(pubkey);
  });

  it("not_found: 404 maps to not_found", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response("", { status: 404 })]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("not_found");
  });

  it("transient: 503 is retried once, succeeds on retry", async () => {
    const { pubkey } = generateEd25519Keypair();
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      retries: 1,
      fetchFn: fakeFetch([
        new Response("", { status: 503 }),
        new Response(encodeBase64(pubkey), { status: 200 }),
      ]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("ok");
  });

  it("transient: 503 twice surfaces transient result", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      retries: 1,
      fetchFn: fakeFetch([new Response("", { status: 503 }), new Response("", { status: 503 })]),
    });
    const out = await f.fetch("test-pub");
    expect(out.kind).toBe("transient");
  });

  it("registry_error: 401 surfaces registry_error", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response("", { status: 401 })]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("registry_error");
  });

  it("registry_error: body not exactly 44 trimmed chars is rejected", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response("AAAA", { status: 200 })]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("registry_error");
  });

  it("registry_error: appended trailing garbage rejected (S5 hardening)", async () => {
    const { pubkey } = generateEd25519Keypair();
    const valid = encodeBase64(pubkey);
    const padded = `${valid}EXTRA-ATTACKER-BYTES==`;
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: fakeFetch([new Response(padded, { status: 200 })]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("registry_error");
  });

  it("transient: fetch rejection treated as transient", async () => {
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      retries: 0,
      fetchFn: fakeFetch([new Error("ECONNRESET")]),
    });
    expect((await f.fetch("test-pub")).kind).toBe("transient");
  });

  it("builds URL as <baseUrl>/publishers/<id>.key", async () => {
    const { pubkey } = generateEd25519Keypair();
    const seen: string[] = [];
    const f = createPublisherKeyFetcher({
      baseUrl: "https://reg.example",
      fetchFn: (async (url: string | URL | Request) => {
        seen.push(String(url));
        return new Response(encodeBase64(pubkey), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await f.fetch("test-pub");
    expect(seen[0]).toBe("https://reg.example/publishers/test-pub.key");
  });
});

describe("createRegistryClient — fetchLatestVersion", () => {
  it("returns version + channel on a 200 with valid JSON", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ version: "1.1.0", channel: "stable" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = createRegistryClient({ baseUrl: "https://r", fetchFn });
    const res = await client.fetchLatestVersion(
      "com.example.a",
      "stable",
      new AbortController().signal,
    );
    expect(res).toEqual({ version: "1.1.0", channel: "stable" });
  });

  it("returns null on 404", async () => {
    const fetchFn = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const client = createRegistryClient({ baseUrl: "https://r", fetchFn });
    const res = await client.fetchLatestVersion(
      "com.example.x",
      "stable",
      new AbortController().signal,
    );
    expect(res).toBeNull();
  });

  it("throws on 5xx", async () => {
    const fetchFn = (async () => new Response("oops", { status: 503 })) as unknown as typeof fetch;
    const client = createRegistryClient({ baseUrl: "https://r", fetchFn });
    await expect(
      client.fetchLatestVersion("com.example.a", "stable", new AbortController().signal),
    ).rejects.toThrow(/503/);
  });

  it("rejects unexpected JSON shape", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ wrong: true }), { status: 200 })) as unknown as typeof fetch;
    const client = createRegistryClient({ baseUrl: "https://r", fetchFn });
    await expect(
      client.fetchLatestVersion("com.example.a", "stable", new AbortController().signal),
    ).rejects.toThrow(/schema/i);
  });
});

describe("createRegistryClient — fetchManifest", () => {
  it("returns manifest + tarball metadata on 200", async () => {
    const pubkey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const sig = `${"A".repeat(86)}==`;
    const manifest = {
      id: "com.example.a",
      version: "1.1.0",
      updateChannel: "stable",
      publisher: { id: "pub", key: pubkey },
      signature: sig,
      permissions: { network: [], filesystem: { read: [], write: [] } },
    };
    const body = {
      manifest,
      manifestHash: "d".repeat(64),
      entryHash: "e".repeat(64),
      tarballUrl: "https://r/x-1.1.0.tar.gz",
      tarballSizeBytes: 4242,
    };
    const fetchFn = (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const client = createRegistryClient({ baseUrl: "https://r", fetchFn });
    const res = await client.fetchManifest("com.example.a", "1.1.0", new AbortController().signal);
    expect(res.manifest.version).toBe("1.1.0");
    expect(res.tarballUrl).toBe("https://r/x-1.1.0.tar.gz");
    expect(res.tarballSizeBytes).toBe(4242);
  });

  it("rejects malformed payload (manifestHash wrong length)", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ manifest: {}, manifestHash: "short" }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = createRegistryClient({ baseUrl: "https://r", fetchFn });
    await expect(
      client.fetchManifest("com.example.a", "1.1.0", new AbortController().signal),
    ).rejects.toThrow();
  });
});
