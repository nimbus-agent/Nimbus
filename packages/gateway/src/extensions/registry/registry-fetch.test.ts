import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { type RegistryIndex, registryIndexSigningBytes } from "./index-format.ts";
import {
  fetchRegistryBytes,
  fetchUnpinnedIndex,
  fetchVerifiedIndex,
  type RegistryFetchDeps,
} from "./registry-fetch.ts";
import { getRegistry, insertRegistry } from "./registry-store.ts";

const KEYPAIR = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const OTHER = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 50));
const ROOT_KEY = encodeBase64(KEYPAIR.publicKey);

function signedIndex(sequence: number, kp = KEYPAIR): RegistryIndex {
  const base = {
    format: 1 as const,
    rootKey: encodeBase64(kp.publicKey),
    sequence,
    generatedAt: "2026-10-18T12:00:00Z",
    extensions: {},
  };
  const sig = nacl.sign.detached(registryIndexSigningBytes(base), kp.secretKey);
  return { ...base, signature: encodeBase64(sig) };
}

const bytesOf = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));
const META = { method: "registry.index" as const, maxBytes: 1024 };

let db: Database;
let tmp: string;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 71);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-regfetch-"));
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function ledgerCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;
}

function deps(over: Partial<RegistryFetchDeps> = {}): RegistryFetchDeps {
  return {
    db,
    fetchFn: (url, init) => fetch(url, init),
    enforceAirGap: () => false,
    now: () => 1000,
    production: false,
    ...over,
  };
}

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return `http://127.0.0.1:${server.port}/reg`;
}

function pinned(url: string, lastSequence = 5) {
  insertRegistry(db, {
    name: "main",
    url,
    rootKey: ROOT_KEY,
    rootFingerprint: "FP",
    lastSequence,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
  });
  const row = getRegistry(db, "main");
  if (row === undefined) throw new Error("registry row missing");
  return row;
}

describe("fetchRegistryBytes: remote", () => {
  test("appends exactly one registry row before the request", async () => {
    const url = serve(() => new Response("{}"));
    let rowsAtCall = -1;
    const d = deps({
      fetchFn: (u, init) => {
        rowsAtCall = ledgerCount();
        return fetch(u, init);
      },
    });
    await fetchRegistryBytes(d, { name: "main", url }, "index.json", META);
    expect(rowsAtCall).toBe(1);
    expect(ledgerCount()).toBe(1);
  });

  test("append failure means no request", async () => {
    db.run("DROP TABLE egress_ledger");
    let called = false;
    const d = deps({
      fetchFn: () => {
        called = true;
        return Promise.resolve(new Response("{}"));
      },
    });
    await expect(
      fetchRegistryBytes(d, { name: "main", url: "https://reg.example/" }, "index.json", META),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  test("air-gap refuses remote and appends nothing", async () => {
    let called = false;
    const d = deps({
      enforceAirGap: () => true,
      fetchFn: () => {
        called = true;
        return Promise.resolve(new Response("{}"));
      },
    });
    await expect(
      fetchRegistryBytes(d, { name: "main", url: "https://reg.example/" }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_AIR_GAP");
    expect(called).toBe(false);
    expect(ledgerCount()).toBe(0);
  });

  test("streaming cap aborts at maxBytes", async () => {
    const url = serve(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(600));
              c.enqueue(new Uint8Array(600));
              c.close();
            },
          }),
        ),
    );
    await expect(
      fetchRegistryBytes(deps(), { name: "main", url }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_TOO_LARGE");
  });

  test("content-length over the cap refuses before reading", async () => {
    const d = deps({
      fetchFn: () =>
        Promise.resolve({
          status: 200,
          headers: new Headers({ "content-length": "5000" }),
          body: null,
        } as unknown as Response),
    });
    await expect(
      fetchRegistryBytes(d, { name: "main", url: "https://reg.example/" }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_TOO_LARGE");
  });

  test("a redirect to http on a non-loopback host refuses", async () => {
    const d = deps({
      production: true,
      fetchFn: () =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: "http://evil.example/x" } }),
        ),
    });
    await expect(
      fetchRegistryBytes(d, { name: "main", url: "https://reg.example/" }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_TRANSPORT_REFUSED");
  });

  test("an https registry cannot redirect to loopback http, nor to file:", async () => {
    for (const location of ["http://127.0.0.1:1/x", "file:///etc/passwd"]) {
      const d = deps({
        fetchFn: () => Promise.resolve(new Response(null, { status: 302, headers: { location } })),
      });
      await expect(
        fetchRegistryBytes(d, { name: "main", url: "https://reg.example/" }, "index.json", META),
      ).rejects.toThrow("ERR_REGISTRY_TRANSPORT_REFUSED");
    }
  });

  test("follows up to three redirects, a fourth refuses", async () => {
    let n = 0;
    const d = deps({
      fetchFn: () => {
        n++;
        return Promise.resolve(
          n <= 3
            ? new Response(null, { status: 301, headers: { location: `/hop${n}` } })
            : new Response("ok"),
        );
      },
    });
    const out = await fetchRegistryBytes(
      d,
      { name: "main", url: "https://reg.example/" },
      "index.json",
      META,
    );
    expect(new TextDecoder().decode(out)).toBe("ok");

    const always = deps({
      fetchFn: () =>
        Promise.resolve(new Response(null, { status: 302, headers: { location: "/again" } })),
    });
    await expect(
      fetchRegistryBytes(always, { name: "main", url: "https://reg.example/" }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_UNREACHABLE");
  });

  test("a redirect hop appends its own row naming the hop's host", async () => {
    const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    try {
      const url = serve(
        () =>
          new Response(null, {
            status: 302,
            headers: { location: `http://127.0.0.1:${second.port}/x` },
          }),
      );
      await fetchRegistryBytes(deps(), { name: "main", url }, "index.json", META);
      const rows = db.query("SELECT payload_summary FROM egress_ledger ORDER BY id").all() as {
        payload_summary: string;
      }[];
      expect(rows).toHaveLength(2);
      expect(JSON.parse(rows[0]?.payload_summary ?? "{}").host).toBe(`127.0.0.1:${server?.port}`);
      expect(JSON.parse(rows[1]?.payload_summary ?? "{}").host).toBe(`127.0.0.1:${second.port}`);
    } finally {
      second.stop(true);
    }
  });

  test("an append failure on hop 2 means hop 2's request never happens", async () => {
    const calls: string[] = [];
    const d = deps({
      fetchFn: (u) => {
        calls.push(u);
        db.run("DROP TABLE egress_ledger");
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/next" } }));
      },
    });
    await expect(
      fetchRegistryBytes(d, { name: "main", url: "https://reg.example/" }, "index.json", META),
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  test("404 is NOT_FOUND, other non-2xx and network errors are UNREACHABLE", async () => {
    const mk = (status: number) =>
      deps({ fetchFn: () => Promise.resolve(new Response("x", { status })) });
    const reg = { name: "main", url: "https://reg.example/" };
    await expect(fetchRegistryBytes(mk(404), reg, "index.json", META)).rejects.toThrow(
      "ERR_REGISTRY_NOT_FOUND",
    );
    await expect(fetchRegistryBytes(mk(500), reg, "index.json", META)).rejects.toThrow(
      "ERR_REGISTRY_UNREACHABLE",
    );
    const boom = deps({ fetchFn: () => Promise.reject(new Error("ECONNREFUSED")) });
    await expect(fetchRegistryBytes(boom, reg, "index.json", META)).rejects.toThrow(
      "ERR_REGISTRY_UNREACHABLE",
    );
  });
});

describe("fetchRegistryBytes: local", () => {
  test("local fetch appends nothing and works under air-gap", async () => {
    const root = join(tmp, "Zoë Q", "reg");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "index.json"), "hello");
    const d = deps({
      enforceAirGap: () => true,
      fetchFn: () => Promise.reject(new Error("no network expected")),
    });
    const out = await fetchRegistryBytes(d, { name: "loc", url: root }, "index.json", META);
    expect(new TextDecoder().decode(out)).toBe("hello");
    expect(ledgerCount()).toBe(0);
  });

  test("missing root, missing file, and oversize file", async () => {
    const root = join(tmp, "reg");
    await expect(
      fetchRegistryBytes(deps(), { name: "loc", url: root }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_UNREACHABLE");
    mkdirSync(root);
    await expect(
      fetchRegistryBytes(deps(), { name: "loc", url: root }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_NOT_FOUND");
    writeFileSync(join(root, "index.json"), new Uint8Array(2000));
    await expect(
      fetchRegistryBytes(deps(), { name: "loc", url: root }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_TOO_LARGE");
  });

  test("a resource that is a directory is refused as not found", async () => {
    const root = join(tmp, "reg");
    mkdirSync(join(root, "index.json"), { recursive: true });
    await expect(
      fetchRegistryBytes(deps(), { name: "loc", url: root }, "index.json", META),
    ).rejects.toThrow("ERR_REGISTRY_NOT_FOUND");
  });
});

describe("fetchVerifiedIndex / fetchUnpinnedIndex", () => {
  test("rollback: lower sequence refuses and does not update the row", async () => {
    const url = serve(() => new Response(JSON.stringify(signedIndex(4))));
    const reg = pinned(url, 5);
    await expect(fetchVerifiedIndex(deps(), reg)).rejects.toThrow("ERR_REGISTRY_ROLLBACK");
    expect(getRegistry(db, "main")?.lastSequence).toBe(5);
    expect(getRegistry(db, "main")?.lastFetchedAt).toBeNull();
  });

  test("a stale fetch cannot lower a floor that advanced while it was in flight", async () => {
    const url = serve(() => new Response(JSON.stringify(signedIndex(6))));
    const reg = pinned(url, 5);
    const d = deps({
      fetchFn: async (u, init) => {
        const res = await fetch(u, init);
        db.run("UPDATE extension_registry SET last_sequence = 9 WHERE name = 'main'");
        return res;
      },
    });
    await expect(fetchVerifiedIndex(d, reg)).rejects.toThrow("ERR_REGISTRY_ROLLBACK");
    expect(getRegistry(db, "main")?.lastSequence).toBe(9);
  });

  test("equal sequence accepted and recorded", async () => {
    const url = serve(() => new Response(JSON.stringify(signedIndex(5))));
    const reg = pinned(url, 5);
    const idx = await fetchVerifiedIndex(deps(), reg);
    expect(idx.sequence).toBe(5);
    expect(getRegistry(db, "main")?.lastFetchedAt).toBe(1000);
  });

  test("higher sequence advances the stored sequence", async () => {
    const url = serve(() => new Response(JSON.stringify(signedIndex(9))));
    await fetchVerifiedIndex(deps(), pinned(url, 5));
    expect(getRegistry(db, "main")?.lastSequence).toBe(9);
  });

  test("changed root key refuses and never re-pins", async () => {
    const url = serve(() => new Response(JSON.stringify(signedIndex(9, OTHER))));
    const reg = pinned(url, 5);
    await expect(fetchVerifiedIndex(deps(), reg)).rejects.toThrow("ERR_REGISTRY_ROOT_KEY_CHANGED");
    const after = getRegistry(db, "main");
    expect(after?.rootKey).toBe(ROOT_KEY);
    expect(after?.lastSequence).toBe(5);
  });

  test("a tampered index fails the pinned signature check", async () => {
    const bad = { ...signedIndex(9), generatedAt: "2026-10-19T00:00:00Z" };
    const url = serve(() => new Response(JSON.stringify(bad)));
    await expect(fetchVerifiedIndex(deps(), pinned(url, 5))).rejects.toThrow(
      "ERR_REGISTRY_SIGNATURE_INVALID",
    );
  });

  test("unpinned fetch self-verifies, accepts any key, and records nothing in the store", async () => {
    const url = serve(() => new Response(bytesOf(signedIndex(3, OTHER))));
    const idx = await fetchUnpinnedIndex(deps(), { name: "new", url });
    expect(idx.rootKey).toBe(encodeBase64(OTHER.publicKey));
    expect(ledgerCount()).toBe(1);

    const bad = { ...signedIndex(3, OTHER), sequence: 4 };
    const url2 = serve(() => new Response(JSON.stringify(bad)));
    await expect(fetchUnpinnedIndex(deps(), { name: "new", url: url2 })).rejects.toThrow(
      "ERR_REGISTRY_SIGNATURE_INVALID",
    );
  });
});
