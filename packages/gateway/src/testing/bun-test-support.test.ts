/**
 * The shared test helpers are relied on by dozens of connector and IPC suites, so a helper that
 * silently stops doing its job (a vault that drops keys, an "unbound" context that is actually
 * bound, a PKCE completer that never reaches its callback) would make those suites pass for the
 * wrong reason. These tests pin what each helper promises.
 *
 * The PKCE callback server is a real loopback `Bun.serve` on port 0 — no external network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import { OAUTH_PROVIDERS } from "../auth/oauth-registry.ts";
import {
  createMemoryVault,
  createOAuthConnectorTestSetup,
  createSyncTestContext,
  expectPrefixedCursorCodecRoundTrip,
  googlePkceOpenUrlCompleter,
  openMemoryIndexDatabase,
  registerGlobalFetchRestore,
  requestUrlString,
} from "./bun-test-support.ts";

describe("createMemoryVault", () => {
  test("stores, reads and deletes; an unknown key reads as null", async () => {
    const v = createMemoryVault();
    expect(await v.get("github.pat")).toBeNull();
    await v.set("github.pat", "ghp_1");
    expect(await v.get("github.pat")).toBe("ghp_1");
    await v.set("github.pat", "ghp_2");
    expect(await v.get("github.pat")).toBe("ghp_2");
    await v.delete("github.pat");
    expect(await v.get("github.pat")).toBeNull();
  });

  test("listKeys is sorted, and filters by prefix only when one is given", async () => {
    const v = createMemoryVault();
    for (const k of ["slack.token", "github.pat", "github.app_id", "gitlab.pat"]) {
      await v.set(k, "x");
    }
    const all = ["github.app_id", "github.pat", "gitlab.pat", "slack.token"];
    expect(await v.listKeys()).toEqual(all);
    expect(await v.listKeys("")).toEqual(all);
    expect(await v.listKeys("github.")).toEqual(["github.app_id", "github.pat"]);
    expect(await v.listKeys("git")).toEqual(["github.app_id", "github.pat", "gitlab.pat"]);
    expect(await v.listKeys("jira.")).toEqual([]);
  });

  test("two vaults never share state", async () => {
    const a = createMemoryVault();
    const b = createMemoryVault();
    await a.set("k", "v");
    expect(await b.get("k")).toBeNull();
    expect(await b.listKeys()).toEqual([]);
  });
});

describe("openMemoryIndexDatabase", () => {
  test("returns a migrated, private in-memory index", () => {
    const a = openMemoryIndexDatabase();
    const b = openMemoryIndexDatabase();
    try {
      a.run("INSERT INTO person (id, display_name, linked) VALUES ('p1', 'Ada', 1)");
      expect(a.query("SELECT display_name FROM person").all()).toEqual([{ display_name: "Ada" }]);
      expect(b.query("SELECT COUNT(*) AS n FROM person").get()).toEqual({ n: 0 });
      // The later person-handle migrations ran too, not just the base table.
      const cols = (a.query("PRAGMA table_info(person)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      );
      expect(cols).toContain("discord_user_id");
    } finally {
      a.close();
      b.close();
    }
  });
});

describe("createSyncTestContext", () => {
  test("without a service id the capabilities refuse, so a missed binding fails loudly", () => {
    const db = openMemoryIndexDatabase();
    try {
      const ctx = createSyncTestContext(db, createMemoryVault());
      expect(() => ctx.countItems("github", "pr")).toThrow(
        "countItems was called on an unbound SyncContext",
      );
      expect(ctx.depth).toBe("full");
      expect(ctx.sandboxCwd).toBe(os.tmpdir());
      expect(ctx.credentialFor("github")).toEqual({ credential: "personal" });
    } finally {
      db.close();
    }
  });

  test("with a service id the capabilities read the given db and vault", async () => {
    const db = openMemoryIndexDatabase();
    const vault = createMemoryVault();
    await vault.set("github.pat", "ghp_bound");
    try {
      const ctx = createSyncTestContext(db, vault, "github");
      expect(ctx.countItems("github", "pr")).toBe(0);
      expect(ctx.itemExists("github:nope")).toBe(false);
      expect(await ctx.getSecret("pat")).toBe("ghp_bound");
      expect(
        await ctx.runTeamList({ entry: "team-a", service: "github", listToolId: "github.list" }),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("createOAuthConnectorTestSetup seeds the provider's token and binds the connector", async () => {
    for (const [provider, serviceId] of [
      ["google", "gmail"],
      ["microsoft", "onedrive"],
    ] as const) {
      const { db, vault, ctx } = await createOAuthConnectorTestSetup(provider, serviceId);
      try {
        const raw = await vault.get(OAUTH_PROVIDERS[provider].vaultKey);
        expect(raw).not.toBeNull();
        const stored = JSON.parse(raw ?? "{}") as { accessToken: string; expiresAt: number };
        expect(stored.accessToken).toBe("t");
        expect(stored.expiresAt).toBeGreaterThan(Date.now());
        expect(ctx.countItems(serviceId, "email")).toBe(0);
      } finally {
        db.close();
      }
    }
  });
});

describe("requestUrlString", () => {
  test("accepts every fetch input shape", () => {
    expect(requestUrlString("https://a.example/x?q=1")).toBe("https://a.example/x?q=1");
    expect(requestUrlString(new URL("https://b.example/y"))).toBe("https://b.example/y");
    expect(requestUrlString(new Request("https://c.example/z"))).toBe("https://c.example/z");
  });
});

describe("registerGlobalFetchRestore", () => {
  test("the registered callback puts back the fetch that was live at registration", () => {
    const original = globalThis.fetch;
    const callbacks: Array<() => void> = [];
    registerGlobalFetchRestore((cb) => callbacks.push(cb));
    expect(callbacks).toHaveLength(1);
    const stub = (() => Promise.resolve(new Response("stub"))) as unknown as typeof fetch;
    globalThis.fetch = stub;
    try {
      expect(globalThis.fetch).toBe(stub);
      callbacks[0]?.();
      expect(globalThis.fetch).toBe(original);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("expectPrefixedCursorCodecRoundTrip", () => {
  const encode = (n: number): string => `cur:${n}`;
  const decode = (raw: string): number | undefined =>
    raw.startsWith("cur:") ? Number(raw.slice(4)) : undefined;

  test("passes for a codec that round-trips with its prefix", () => {
    expect(() =>
      expectPrefixedCursorCodecRoundTrip([1, 2, 30], encode, decode, "cur:"),
    ).not.toThrow();
  });

  test("fails when the encoding lacks the prefix, even though it round-trips", () => {
    // `String` and `Number` invert each other, so the round-trip half passes and only the prefix
    // check can reject this codec. (Decoding with the prefixed `decode` above would fail the
    // round-trip too, and could not show that the prefix is checked at all.)
    const unprefixed = (n: number): string => `${n}`;
    const parse = (raw: string): number => Number(raw);
    expect(parse(unprefixed(1))).toBe(1);
    expect(() => expectPrefixedCursorCodecRoundTrip([1], unprefixed, parse, "cur:")).toThrow();
  });

  test("fails when decode does not invert encode, even though the prefix is right", () => {
    expect(encode(7).startsWith("cur:")).toBe(true);
    expect(() => expectPrefixedCursorCodecRoundTrip([7], encode, () => 8, "cur:")).toThrow();
  });
});

describe("googlePkceOpenUrlCompleter", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  const hits: URL[] = [];

  afterEach(async () => {
    await server?.stop(true);
    server = undefined;
    hits.length = 0;
  });

  function startCallback(status = 200): number {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        hits.push(new URL(req.url));
        return new Response("done", { status });
      },
    });
    return server.port ?? 0;
  }

  function authUrl(params: Record<string, string>, host = "accounts.google.com"): string {
    const u = new URL(`https://${host}/o/oauth2/v2/auth`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  test("delivers the code and state to the redirect_uri", async () => {
    const port = startCallback();
    const complete = googlePkceOpenUrlCompleter("code-123", { expectAccountsHost: true });
    await complete(authUrl({ redirect_uri: `http://127.0.0.1:${port}/cb`, state: "st-9" }));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.pathname).toBe("/cb");
    expect(hits[0]?.searchParams.get("code")).toBe("code-123");
    expect(hits[0]?.searchParams.get("state")).toBe("st-9");
  });

  test("expectAccountsHost rejects an auth URL on another host before any callback", async () => {
    const port = startCallback();
    const complete = googlePkceOpenUrlCompleter("c", { expectAccountsHost: true });
    await expect(
      complete(
        authUrl({ redirect_uri: `http://127.0.0.1:${port}/cb`, state: "s" }, "evil.example"),
      ),
    ).rejects.toThrow();
    expect(hits).toEqual([]);
  });

  test("a missing or empty redirect_uri or state throws the configured message", async () => {
    const custom = googlePkceOpenUrlCompleter("c", { missingParamsMessage: "no params here" });
    for (const params of [
      { state: "s" },
      { redirect_uri: "", state: "s" },
      { redirect_uri: "http://127.0.0.1:1/cb" },
      { redirect_uri: "http://127.0.0.1:1/cb", state: "" },
    ]) {
      await expect(custom(authUrl(params))).rejects.toThrow("no params here");
    }
    await expect(googlePkceOpenUrlCompleter("c")(authUrl({}))).rejects.toThrow(
      "expected redirect_uri and state in auth URL",
    );
  });

  test("a non-http(s) redirect_uri is refused by name", async () => {
    const complete = googlePkceOpenUrlCompleter("c");
    await expect(
      complete(authUrl({ redirect_uri: "ftp://127.0.0.1/cb", state: "s" })),
    ).rejects.toThrow("PKCE test helper expected http(s) callback URL, got ftp:");
  });

  test("a non-2xx callback fails by default and passes with assertFetchOk: false", async () => {
    const port = startCallback(500);
    const url = authUrl({ redirect_uri: `http://127.0.0.1:${port}/cb`, state: "s" });
    await expect(googlePkceOpenUrlCompleter("c")(url)).rejects.toThrow();
    await expect(
      googlePkceOpenUrlCompleter("c", { assertFetchOk: false })(url),
    ).resolves.toBeUndefined();
    expect(hits).toHaveLength(2);
  });

  test("an https redirect_uri is fetched over TLS", async () => {
    // A raw TCP listener records the first byte the client sends, then hangs up. 0x16 is a TLS
    // handshake record — proof the https module opened a TLS session. (The plain http module
    // refuses an https: URL before connecting at all, so the failure alone would prove nothing.)
    const firstBytes: number[] = [];
    const raw = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          firstBytes.push(data[0] ?? -1);
          socket.end();
        },
      },
    });
    try {
      const complete = googlePkceOpenUrlCompleter("c");
      await expect(
        complete(authUrl({ redirect_uri: `https://127.0.0.1:${raw.port}/cb`, state: "s" })),
      ).rejects.toThrow();
      expect(firstBytes[0]).toBe(0x16);
    } finally {
      raw.stop(true);
    }
  });
});
