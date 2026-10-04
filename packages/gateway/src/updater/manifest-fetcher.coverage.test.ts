/**
 * Every manifest-shape refusal `fetchUpdateManifest` can raise, each pinned by its exact message.
 * A manifest that slips past one of these checks reaches the updater's download path with a field
 * it never validated, so the refusals are the boundary — not decoration.
 *
 * One loopback server serves whatever body the current case sets.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  fetchUpdateManifest,
  isPermittedSchemeForUpdater,
  ManifestFetchError,
} from "./manifest-fetcher.ts";

let server: ReturnType<typeof Bun.serve>;
let body = "";

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(body, { headers: { "content-type": "application/json" } }),
  });
});

afterAll(async () => {
  await server.stop(true);
});

const ASSET: Readonly<Record<string, string>> = {
  url: "https://example/bin",
  sha256: "a".repeat(64),
  signature: "sig",
};

function validManifest(): Record<string, unknown> {
  return {
    version: "1.2.3",
    pub_date: "2026-05-01T00:00:00Z",
    platforms: {
      "darwin-x86_64": { ...ASSET },
      "darwin-aarch64": { ...ASSET },
      "linux-x86_64": { ...ASSET },
      "windows-x86_64": { ...ASSET },
    },
  };
}

function serve(value: unknown): Promise<unknown> {
  body = JSON.stringify(value);
  return fetchUpdateManifest(`http://127.0.0.1:${server.port}/latest.json`, { timeoutMs: 5_000 });
}

async function refusal(p: Promise<unknown>): Promise<ManifestFetchError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ManifestFetchError);
    return err as ManifestFetchError;
  }
  throw new Error("expected a ManifestFetchError, but the manifest was accepted");
}

function withPlatform(target: string, asset: unknown): Record<string, unknown> {
  const m = validManifest();
  (m["platforms"] as Record<string, unknown>)[target] = asset;
  return m;
}

describe("fetchUpdateManifest — manifest shape", () => {
  test("a manifest that is not an object is refused", async () => {
    for (const value of [null, "1.2.3", 42, true]) {
      expect((await refusal(serve(value))).message).toBe("manifest must be an object");
    }
  });

  test("a non-string version is refused before any other field is read", async () => {
    const err = await refusal(serve({ ...validManifest(), version: 2, pub_date: 7 }));
    expect(err.message).toBe("manifest.version must be a string");
  });

  test("a missing or non-string pub_date is refused", async () => {
    const { pub_date: _drop, ...noDate } = validManifest();
    expect((await refusal(serve(noDate))).message).toBe("manifest.pub_date must be a string");
    expect((await refusal(serve({ ...validManifest(), pub_date: 20260501 }))).message).toBe(
      "manifest.pub_date must be a string",
    );
  });

  test("a manifest missing one required target names that target", async () => {
    const m = validManifest();
    delete (m["platforms"] as Record<string, unknown>)["windows-x86_64"];
    expect((await refusal(serve(m))).message).toBe(
      "manifest.platforms missing required target: windows-x86_64",
    );
  });
});

describe("fetchUpdateManifest — platform assets", () => {
  test("an asset that is not an object is refused by target", async () => {
    for (const asset of [null, "https://example/bin", 3]) {
      expect((await refusal(serve(withPlatform("linux-x86_64", asset)))).message).toBe(
        "platforms.linux-x86_64 must be an object",
      );
    }
  });

  const fields: Array<[string, string]> = [
    ["url", "platforms.darwin-aarch64.url must be a string"],
    ["sha256", "platforms.darwin-aarch64.sha256 must be a string"],
    ["signature", "platforms.darwin-aarch64.signature must be a string"],
  ];
  for (const [field, message] of fields) {
    test(`an asset whose ${field} is missing or not a string is refused`, async () => {
      const { [field]: _drop, ...without } = ASSET;
      expect((await refusal(serve(withPlatform("darwin-aarch64", without)))).message).toBe(message);
      expect(
        (await refusal(serve(withPlatform("darwin-aarch64", { ...ASSET, [field]: 99 })))).message,
      ).toBe(message);
    });
  }
});

describe("fetchUpdateManifest — accepted shapes", () => {
  test("notes are kept when they are a string and dropped otherwise", async () => {
    const withNotes = (await serve({ ...validManifest(), notes: "fixes" })) as { notes?: string };
    expect(withNotes.notes).toBe("fixes");
    const oddNotes = (await serve({ ...validManifest(), notes: { md: "x" } })) as object;
    expect("notes" in oddNotes).toBe(false);
  });

  test("extra platforms beyond the required four pass through untouched", async () => {
    const m = withPlatform("freebsd-x86_64", { url: 1 });
    const got = (await serve(m)) as { platforms: Record<string, unknown> };
    expect(got.platforms["freebsd-x86_64"]).toEqual({ url: 1 });
  });
});

describe("fetchUpdateManifest — refused URLs", () => {
  test("an unparseable URL is refused naming the raw string", async () => {
    const err = await refusal(fetchUpdateManifest("not a url", { timeoutMs: 1_000 }));
    expect(err.message).toBe(
      "manifest URL must be https:// (got not a url); only http://127.0.0.1 is permitted for local tests",
    );
  });

  test("a parseable non-https URL is refused naming its scheme", async () => {
    const err = await refusal(
      fetchUpdateManifest("ftp://127.0.0.1/latest.json", { timeoutMs: 1_000 }),
    );
    expect(err.message).toBe(
      "manifest URL must be https:// (got ftp:); only http://127.0.0.1 is permitted for local tests",
    );
  });
});

describe("isPermittedSchemeForUpdater", () => {
  test("https anywhere, and plain http only to a loopback name outside production", () => {
    expect(isPermittedSchemeForUpdater("https://updates.example/latest.json")).toBe(true);
    expect(isPermittedSchemeForUpdater("http://localhost:4000/latest.json")).toBe(true);
    expect(isPermittedSchemeForUpdater("http://127.0.0.1/latest.json")).toBe(true);
    // The IPv6 loopback, which `URL` reports BRACKETED: a comparison against a bare `::1` could
    // never match it.
    expect(isPermittedSchemeForUpdater("http://[::1]/latest.json")).toBe(true);
    expect(isPermittedSchemeForUpdater("http://[::1]:8080/latest.json")).toBe(true);
    expect(isPermittedSchemeForUpdater("http://[::2]/latest.json")).toBe(false);
    expect(isPermittedSchemeForUpdater("http://updates.example/latest.json")).toBe(false);
    expect(isPermittedSchemeForUpdater("file:///etc/passwd")).toBe(false);
    expect(isPermittedSchemeForUpdater("::not a url::")).toBe(false);
  });

  test("in production plain http is refused even to loopback, and https still passes", () => {
    const saved = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      expect(isPermittedSchemeForUpdater("http://127.0.0.1/latest.json")).toBe(false);
      expect(isPermittedSchemeForUpdater("http://localhost/latest.json")).toBe(false);
      expect(isPermittedSchemeForUpdater("http://[::1]/latest.json")).toBe(false);
      expect(isPermittedSchemeForUpdater("https://updates.example/latest.json")).toBe(true);
    } finally {
      if (saved === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = saved;
    }
  });
});
