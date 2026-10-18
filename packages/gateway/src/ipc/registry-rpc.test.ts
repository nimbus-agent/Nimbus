import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

import { publisherKeyFingerprint } from "../extensions/install-from-local.ts";
import {
  type RegistryIndex,
  registryIndexSigningBytes,
} from "../extensions/registry/index-format.ts";
import { getRegistry, insertRegistry } from "../extensions/registry/registry-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { encodeBase64 } from "../util/base64.ts";
import {
  dispatchRegistryRpc,
  type RegistryFetchBag,
  type RegistryOwnerGate,
} from "./registry-rpc.ts";

const KEYPAIR = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ROOT_KEY = encodeBase64(KEYPAIR.publicKey);
const FINGERPRINT = publisherKeyFingerprint(ROOT_KEY);
const NOW = Date.parse("2026-10-18T12:00:00Z");

function signedIndex(sequence: number, generatedAt = "2026-10-18T12:00:00Z"): RegistryIndex {
  const base = {
    format: 1 as const,
    rootKey: ROOT_KEY,
    sequence,
    generatedAt,
    extensions: {},
  };
  const sig = nacl.sign.detached(registryIndexSigningBytes(base), KEYPAIR.secretKey);
  return { ...base, signature: encodeBase64(sig) };
}

let db: Database;
let tmp: string;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 71);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-rpc-"));
  writeFileSync(join(tmp, "index.json"), JSON.stringify(signedIndex(3)));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fetchBag = (over: Partial<RegistryFetchBag> = {}): RegistryFetchBag => ({
  fetchFn: () => Promise.reject(new Error("unexpected network")),
  enforceAirGap: () => false,
  now: () => NOW,
  production: false,
  ...over,
});

function gateRecorder(answer: boolean): { gate: RegistryOwnerGate; asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    gate: async (a) => {
      asked.push(a);
      return answer;
    },
  };
}

function ledgerCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;
}

function call(
  method: string,
  params: unknown,
  o: { gate?: RegistryOwnerGate; fetch?: RegistryFetchBag } = {},
) {
  return dispatchRegistryRpc({
    method,
    params,
    db,
    fetch: o.fetch ?? fetchBag(),
    ...(o.gate === undefined ? {} : { ownerGate: o.gate }),
  });
}

describe("registry.add", () => {
  test("pins the key after approval", async () => {
    const g = gateRecorder(true);
    const out = await call("registry.add", { name: "main", url: tmp }, { gate: g.gate });
    expect(out).toEqual({
      kind: "hit",
      value: {
        name: "main",
        url: tmp,
        rootFingerprint: FINGERPRINT,
        extensionCount: 0,
        generatedAt: "2026-10-18T12:00:00Z",
      },
    });
    expect(g.asked).toEqual([
      {
        type: "registry.add",
        payload: {
          name: "main",
          url: tmp,
          rootFingerprint: FINGERPRINT,
          extensionCount: 0,
          generatedAt: "2026-10-18T12:00:00Z",
        },
      },
    ]);
    const row = getRegistry(db, "main");
    expect(row?.rootKey).toBe(ROOT_KEY);
    expect(row?.lastSequence).toBe(3);
  });

  test("a denial stores nothing and reports ERR_REGISTRY_ADD_NOT_APPROVED", async () => {
    const g = gateRecorder(false);
    await expect(
      call("registry.add", { name: "main", url: tmp }, { gate: g.gate }),
    ).rejects.toThrow("ERR_REGISTRY_ADD_NOT_APPROVED");
    expect(getRegistry(db, "main")).toBeUndefined();
  });

  test("records the index fetch even when denied (remote), but stores no registry row", async () => {
    const g = gateRecorder(false);
    const fetchFn = () => Promise.resolve(new Response(JSON.stringify(signedIndex(1))));
    await expect(
      call(
        "registry.add",
        { name: "main", url: "https://reg.example/r" },
        { gate: g.gate, fetch: fetchBag({ fetchFn }) },
      ),
    ).rejects.toThrow("ERR_REGISTRY_ADD_NOT_APPROVED");
    expect(ledgerCount()).toBe(1);
    expect(
      (db.query("SELECT source_type FROM egress_ledger").get() as { source_type: string })
        .source_type,
    ).toBe("registry");
    expect(getRegistry(db, "main")).toBeUndefined();
  });

  test("a wrong --fingerprint refuses before prompting", async () => {
    const g = gateRecorder(true);
    await expect(
      call(
        "registry.add",
        { name: "main", url: tmp, fingerprint: "0".repeat(32) },
        { gate: g.gate },
      ),
    ).rejects.toThrow("ERR_REGISTRY_FINGERPRINT_MISMATCH");
    expect(g.asked).toEqual([]);
    expect(getRegistry(db, "main")).toBeUndefined();
  });

  test("a matching fingerprint is trimmed and lowercased, then prompts", async () => {
    const g = gateRecorder(true);
    await call(
      "registry.add",
      { name: "main", url: tmp, fingerprint: `  ${FINGERPRINT.toUpperCase()} ` },
      { gate: g.gate },
    );
    expect(g.asked).toHaveLength(1);
  });

  test("a malformed fingerprint is refused with the expected shape, before any fetch", async () => {
    const g = gateRecorder(true);
    await expect(
      call("registry.add", { name: "main", url: tmp, fingerprint: "abc" }, { gate: g.gate }),
    ).rejects.toThrow("must be 32 hex characters");
    expect(g.asked).toEqual([]);
  });

  test("refuses an existing name and an existing url", async () => {
    const g = gateRecorder(true);
    await call("registry.add", { name: "main", url: tmp }, { gate: g.gate });
    await expect(
      call("registry.add", { name: "main", url: "/other" }, { gate: g.gate }),
    ).rejects.toThrow("ERR_REGISTRY_EXISTS");
    await expect(
      call("registry.add", { name: "second", url: tmp }, { gate: g.gate }),
    ).rejects.toThrow("ERR_REGISTRY_EXISTS");
    expect(g.asked).toHaveLength(1);
  });

  test("refuses without an owner gate and for an invalid name", async () => {
    await expect(call("registry.add", { name: "main", url: tmp })).rejects.toThrow(
      "requires the owner's HITL gate",
    );
    const g = gateRecorder(true);
    await expect(
      call("registry.add", { name: "Bad Name", url: tmp }, { gate: g.gate }),
    ).rejects.toThrow("ERR_INVALID_PARAMS");
  });
});

describe("registry.list", () => {
  test("reads the database only and marks an index older than 30 days stale", async () => {
    for (const [name, generatedAt] of [
      ["fresh", "2026-10-10T00:00:00Z"],
      ["old", "2026-08-01T00:00:00Z"],
    ] as const) {
      insertRegistry(db, {
        name,
        url: `/r/${name}`,
        rootKey: ROOT_KEY,
        rootFingerprint: FINGERPRINT,
        lastSequence: 1,
        lastGeneratedAt: generatedAt,
        addedAt: 1,
      });
    }
    const out = await call("registry.list", {});
    const value = (out as { value: { registries: Array<Record<string, unknown>> } }).value;
    expect(value.registries.map((r) => [r["name"], r["stale"], r["extensionCount"]])).toEqual([
      ["fresh", false, null],
      ["old", true, null],
    ]);
    expect(ledgerCount()).toBe(0);
  });
});

describe("registry.refresh", () => {
  test("reports per-registry results, a failure does not stop the rest", async () => {
    const g = gateRecorder(true);
    await call("registry.add", { name: "main", url: tmp }, { gate: g.gate });
    insertRegistry(db, {
      name: "gone",
      url: join(tmp, "missing"),
      rootKey: ROOT_KEY,
      rootFingerprint: FINGERPRINT,
      lastSequence: 1,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: 1,
    });
    const out = (await call("registry.refresh", {})) as {
      value: {
        results: Array<{
          name: string;
          ok: boolean;
          error?: string;
          sequence?: number;
          extensionCount?: number;
        }>;
      };
    };
    const byName = Object.fromEntries(out.value.results.map((r) => [r.name, r]));
    expect(byName["main"]).toEqual({ name: "main", ok: true, sequence: 3, extensionCount: 0 });
    expect(byName["gone"]?.ok).toBe(false);
    expect(byName["gone"]?.error).toContain("ERR_REGISTRY_");
  });

  test("an unknown name is ERR_REGISTRY_NOT_FOUND", async () => {
    await expect(call("registry.refresh", { name: "nope" })).rejects.toThrow(
      "ERR_REGISTRY_NOT_FOUND",
    );
  });
});

describe("registry.remove", () => {
  test("returns the ids of extensions installed from it", async () => {
    const g = gateRecorder(true);
    await call("registry.add", { name: "main", url: tmp }, { gate: g.gate });
    db.run(
      "INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, source_registry, source_root_fingerprint, source_channel) VALUES ('acme.tool', '1.0.0', '/x', 'h', 'e', 1, 1, 1, 'main', ?, 'stable')",
      [FINGERPRINT],
    );
    const out = await call("registry.remove", { name: "main" });
    expect(out).toEqual({
      kind: "hit",
      value: { removed: true, orphanedExtensions: ["acme.tool"] },
    });
    expect(getRegistry(db, "main")).toBeUndefined();
    expect(await call("registry.remove", { name: "main" })).toEqual({
      kind: "hit",
      value: { removed: false, orphanedExtensions: [] },
    });
  });
});

test("an unknown registry method is a miss", async () => {
  expect(await call("registry.nope", {})).toEqual({ kind: "miss" });
});
