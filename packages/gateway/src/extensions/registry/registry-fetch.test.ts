import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RegistryIndex,
  registryIndexDigest,
  registryIndexSigningBytes,
  signTrustStatement,
  type TrustStatement,
  trustStatementId,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { trustStoreCounts } from "../trust/trust-store.ts";
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

function signedIndex(
  sequence: number,
  kp = KEYPAIR,
  generatedAt = "2026-10-18T12:00:00Z",
): RegistryIndex {
  const base = {
    format: 1 as const,
    rootKey: encodeBase64(kp.publicKey),
    sequence,
    generatedAt,
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
  runIndexedSchemaMigrations(db, 76);
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
    lastIndexSha256: null,
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

describe("fetchRegistryBytes: caller signal and edge responses", () => {
  const REMOTE = { name: "main", url: "https://reg.example/r" };

  test("an already-aborted caller signal aborts the request as UNREACHABLE", async () => {
    const caller = new AbortController();
    caller.abort(new Error("owner cancelled"));
    let sawAborted: boolean | undefined;
    const d = deps({
      fetchFn: async (_u, init) => {
        sawAborted = init?.signal?.aborted;
        throw new Error("The operation was aborted");
      },
    });
    await expect(fetchRegistryBytes(d, REMOTE, "index.json", META, caller.signal)).rejects.toThrow(
      "ERR_REGISTRY_UNREACHABLE",
    );
    expect(sawAborted).toBe(true);
  });

  test("a caller abort while the request is in flight reaches the request", async () => {
    const caller = new AbortController();
    const d = deps({
      fetchFn: (_u, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted mid-flight")));
          caller.abort();
        }),
    });
    await expect(fetchRegistryBytes(d, REMOTE, "index.json", META, caller.signal)).rejects.toThrow(
      /ERR_REGISTRY_UNREACHABLE.*aborted mid-flight/,
    );
  });

  test("a live caller signal lets the request complete, and a later abort touches nothing", async () => {
    const caller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const d = deps({
      fetchFn: async (_u, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Response("abc", { status: 200 });
      },
    });
    const out = await fetchRegistryBytes(d, REMOTE, "index.json", META, caller.signal);
    expect(new TextDecoder().decode(out)).toBe("abc");
    // The caller's listener was removed: aborting it now no longer reaches the finished request.
    caller.abort();
    expect(requestSignal?.aborted).toBe(false);
  });

  test("a 2xx answer with no body reads as zero bytes", async () => {
    const d = deps({ fetchFn: async () => new Response(null, { status: 204 }) });
    const out = await fetchRegistryBytes(d, REMOTE, "index.json", META);
    expect(out.byteLength).toBe(0);
  });

  test("a redirect with a missing or empty Location is UNREACHABLE", async () => {
    for (const headers of [{}, { location: "" }]) {
      const d = deps({ fetchFn: async () => new Response(null, { status: 302, headers }) });
      await expect(fetchRegistryBytes(d, REMOTE, "index.json", META)).rejects.toThrow(
        /ERR_REGISTRY_UNREACHABLE.*without a Location/,
      );
    }
  });

  test("a non-Error rejection from the transport is UNREACHABLE with a generic reason", async () => {
    const d = deps({
      fetchFn: () => Promise.reject("socket hang up" as unknown as Error),
    });
    await expect(fetchRegistryBytes(d, REMOTE, "index.json", META)).rejects.toThrow(
      /ERR_REGISTRY_UNREACHABLE.*registry request failed/,
    );
  });

  test("a local registry path that is a file, not a directory, is UNREACHABLE", async () => {
    const file = join(tmp, "not-a-dir");
    writeFileSync(file, "x");
    await expect(
      fetchRegistryBytes(deps(), { name: "loc", url: file }, "index.json", META),
    ).rejects.toThrow(/ERR_REGISTRY_UNREACHABLE.*not a directory/);
  });
});

describe("fetchVerifiedIndex: the row changes during the fetch", () => {
  test("a registry removed while its index was in flight refuses ROOT_KEY_CHANGED", async () => {
    const url = serve(() => new Response(JSON.stringify(signedIndex(7))));
    const reg = pinned(url, 5);
    const d = deps({
      fetchFn: async (u, init) => {
        const res = await fetch(u, init);
        db.run("DELETE FROM extension_registry WHERE name = 'main'");
        return res;
      },
    });
    await expect(fetchVerifiedIndex(d, reg)).rejects.toThrow(
      /ERR_REGISTRY_ROOT_KEY_CHANGED.*removed or re-pinned/,
    );
    expect(getRegistry(db, "main")).toBeUndefined();
  });

  test("a registry re-pinned to another key while in flight refuses ROOT_KEY_CHANGED", async () => {
    const url = serve(() => new Response(JSON.stringify(signedIndex(7))));
    const reg = pinned(url, 5);
    const otherKey = encodeBase64(OTHER.publicKey);
    const d = deps({
      fetchFn: async (u, init) => {
        const res = await fetch(u, init);
        db.run("UPDATE extension_registry SET root_key = ? WHERE name = 'main'", [otherKey]);
        return res;
      },
    });
    await expect(fetchVerifiedIndex(d, reg)).rejects.toThrow("ERR_REGISTRY_ROOT_KEY_CHANGED");
    expect(getRegistry(db, "main")?.rootKey).toBe(otherKey);
    expect(getRegistry(db, "main")?.lastSequence).toBe(5);
  });
});

describe("fetchVerifiedIndex: equivocation", () => {
  // A and B share sequence 3 and the root key but differ in content: a force-pushed gh-pages.
  const A = signedIndex(3);
  const B = signedIndex(3, KEYPAIR, "2026-10-30T00:00:00Z");

  function serving(initial: RegistryIndex): { url: string; set(i: RegistryIndex): void } {
    let current = initial;
    const url = serve(() => new Response(JSON.stringify(current)));
    return { url, set: (i) => (current = i) };
  }

  test("the same document again is accepted; different content at that sequence is refused", async () => {
    const s = serving(A);
    pinned(s.url, 2);
    await fetchVerifiedIndex(deps(), getRegistry(db, "main") ?? pinned(s.url));
    expect(getRegistry(db, "main")?.lastIndexSha256).toBe(registryIndexDigest(A));
    const again = await fetchVerifiedIndex(deps(), getRegistry(db, "main") ?? pinned(s.url));
    expect(again.sequence).toBe(3);
    s.set(B);
    await expect(
      fetchVerifiedIndex(deps(), getRegistry(db, "main") ?? pinned(s.url)),
    ).rejects.toThrow("ERR_REGISTRY_EQUIVOCATION");
    expect(getRegistry(db, "main")?.lastIndexSha256).toBe(registryIndexDigest(A));
    s.set(signedIndex(4));
    expect(
      (await fetchVerifiedIndex(deps(), getRegistry(db, "main") ?? pinned(s.url))).sequence,
    ).toBe(4);
  });

  test("a row from before V76 (no hash) adopts the first document at its sequence", async () => {
    const s = serving(B);
    const reg = pinned(s.url, 3);
    expect(reg.lastIndexSha256).toBeNull();
    await fetchVerifiedIndex(deps(), reg);
    expect(getRegistry(db, "main")?.lastIndexSha256).toBe(registryIndexDigest(B));
  });

  test("a stale snapshot loses the race to a fetch that recorded other content", async () => {
    const s = serving(B);
    const stale = pinned(s.url, 3);
    const d = deps({
      fetchFn: async (u, init) => {
        const res = await fetch(u, init);
        db.run("UPDATE extension_registry SET last_index_sha256 = ? WHERE name = 'main'", [
          registryIndexDigest(A),
        ]);
        return res;
      },
    });
    await expect(fetchVerifiedIndex(d, stale)).rejects.toThrow("ERR_REGISTRY_EQUIVOCATION");
    expect(getRegistry(db, "main")?.lastIndexSha256).toBe(registryIndexDigest(A));
  });
});

describe("fetchVerifiedIndex: trust statements in the index", () => {
  const ROOT_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 1);

  async function rootRevoke(): Promise<TrustStatement> {
    return signTrustStatement(
      {
        kind: "key.revoke",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: ROOT_KEY,
        publisherId: "acme",
        keyFingerprint: "0".repeat(32),
        reason: "leaked",
      },
      ROOT_SEED,
    );
  }

  function indexWith(sequence: number, statements: unknown): RegistryIndex {
    const base = {
      format: 1 as const,
      rootKey: ROOT_KEY,
      sequence,
      generatedAt: "2026-10-18T12:00:00Z",
      extensions: {},
      statements,
    };
    const sig = nacl.sign.detached(registryIndexSigningBytes(base), KEYPAIR.secretKey);
    return { ...base, signature: encodeBase64(sig) };
  }

  test("newly stored statements reach the enforcement hook once; a re-fetch reports nothing", async () => {
    const s = await rootRevoke();
    const idx = indexWith(6, [s]);
    const url = serve(() => new Response(JSON.stringify(idx)));
    const seen: string[][] = [];
    const withHook = {
      ...deps(),
      onTrustRecorded: (ids: readonly string[]) => void seen.push([...ids]),
    };
    await fetchVerifiedIndex(withHook, pinned(url, 5));
    expect(seen).toEqual([[trustStatementId(s)]]);
    await fetchVerifiedIndex(withHook, getRegistry(db, "main") ?? pinned(url, 5));
    expect(seen).toHaveLength(1);
  });

  test("a throwing hook never fails the fetch", async () => {
    const idx = indexWith(6, [await rootRevoke()]);
    const url = serve(() => new Response(JSON.stringify(idx)));
    const out = await fetchVerifiedIndex(
      {
        ...deps(),
        onTrustRecorded: () => {
          throw new Error("hook");
        },
      },
      pinned(url, 5),
    );
    expect(out.sequence).toBe(6);
  });

  test("a root-signed revocation in a pinned index is stored, scoped to that registry", async () => {
    const idx = indexWith(6, [await rootRevoke()]);
    const url = serve(() => new Response(JSON.stringify(idx)));
    await fetchVerifiedIndex(deps(), pinned(url, 5));
    expect(trustStoreCounts(db).revocations).toBe(1);
    expect(
      db.query("SELECT signer_role, scope_registry, source FROM trust_statement").get(),
    ).toEqual({ signer_role: "registry", scope_registry: "main", source: "registry:main" });
  });

  test("a hostile statements field does not fail the fetch", async () => {
    const url = serve(() => new Response(JSON.stringify(indexWith(6, "not a list"))));
    const idx = await fetchVerifiedIndex(deps(), pinned(url, 5));
    expect(idx.sequence).toBe(6);
    expect(trustStoreCounts(db).revocations).toBe(0);
  });

  test("an unpinned fetch (registry add) stores no statement", async () => {
    const idx = indexWith(3, [await rootRevoke()]);
    const url = serve(() => new Response(JSON.stringify(idx)));
    await fetchUnpinnedIndex(deps(), { name: "new", url });
    expect(trustStoreCounts(db).revocations).toBe(0);
  });
});
