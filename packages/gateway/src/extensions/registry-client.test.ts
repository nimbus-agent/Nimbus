import { describe, expect, it, mock } from "bun:test";

import { createPublisherKeyFetcher } from "./registry-client.ts";
import { encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

function fakeFetch(responses: Array<Response | Error>): typeof fetch {
  let i = 0;
  return mock((_url: RequestInfo | URL) => {
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
    const padded = valid + "EXTRA-ATTACKER-BYTES==";
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
      fetchFn: (async (url: RequestInfo | URL) => {
        seen.push(String(url));
        return new Response(encodeBase64(pubkey), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await f.fetch("test-pub");
    expect(seen[0]).toBe("https://reg.example/publishers/test-pub.key");
  });
});
