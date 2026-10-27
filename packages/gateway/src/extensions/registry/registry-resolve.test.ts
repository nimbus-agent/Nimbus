import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint, RegistryError } from "@nimbus-dev/registry-format";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { generateEd25519Keypair } from "../../util/ed25519.ts";
import { buildTestRegistry, resignIndex } from "./__fixtures__/build-test-registry.ts";
import { BUILTIN_REGISTRY_NAME } from "./builtin-registry.ts";
import type { RegistryFetchDeps } from "./registry-fetch.ts";
import { registryTargets, resolveRegistryEntry } from "./registry-resolve.ts";
import { insertRegistry } from "./registry-store.ts";

const ID = "com.example.resolve";

let db: Database;
let tmp: string;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-regresolve-"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const deps = (): RegistryFetchDeps => ({
  db,
  fetchFn: () => Promise.reject(new Error("no network in this test")),
  enforceAirGap: () => false,
  now: () => 1000,
  production: false,
  // Neutral test default: never reach the real official registry host.
  builtin: null,
});

/** A local registry folder `name` carrying ID, added to the database. Returns the folder. */
async function addRegistry(name: string, id = ID): Promise<string> {
  const dir = join(tmp, name);
  const built = await buildTestRegistry(dir, { id, versions: [{ version: "1.0.0" }] });
  insertRegistry(db, {
    name,
    url: dir,
    rootKey: built.rootKey,
    rootFingerprint: publisherKeyFingerprint(built.rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
    lastIndexSha256: null,
  });
  return dir;
}

async function refusal(p: Promise<unknown>): Promise<RegistryError> {
  const settled = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(settled).toBeInstanceOf(RegistryError);
  return settled as RegistryError;
}

describe("resolveRegistryEntry", () => {
  test("one registry carrying the id resolves to it", async () => {
    await addRegistry("alpha");
    await addRegistry("beta", "com.example.other");
    expect((await resolveRegistryEntry(deps(), ID, undefined)).reg.name).toBe("alpha");
  });

  test("two verified registries carrying the id: ambiguous", async () => {
    await addRegistry("alpha");
    await addRegistry("beta");
    const e = await refusal(resolveRegistryEntry(deps(), ID, undefined));
    expect(e.code).toBe("ERR_REGISTRY_AMBIGUOUS");
    expect(e.message).toContain("alpha, beta");
  });

  test("a bare id while another registry is unreachable is refused, never resolved by reachability", async () => {
    await addRegistry("alpha");
    const beta = await addRegistry("beta");
    rmSync(beta, { recursive: true, force: true });
    const e = await refusal(resolveRegistryEntry(deps(), ID, undefined));
    expect(e.code).toBe("ERR_REGISTRY_AMBIGUOUS");
    expect(e.message).toContain("beta: unreachable");
    expect(e.message).toContain("--registry <name>");
    // A qualified lookup is about that registry only.
    expect((await resolveRegistryEntry(deps(), ID, "alpha")).reg.name).toBe("alpha");
  });

  test("a bare id while another registry fails verification is refused, naming the verification code", async () => {
    await addRegistry("alpha");
    const beta = await addRegistry("beta");
    const indexPath = join(beta, "index.json");
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
    writeFileSync(indexPath, JSON.stringify({ ...index, generatedAt: "2026-10-19T00:00:00Z" }));
    const e = await refusal(resolveRegistryEntry(deps(), ID, undefined));
    expect(e.code).toBe("ERR_REGISTRY_AMBIGUOUS");
    expect(e.message).toContain("beta: failed verification: ERR_REGISTRY_SIGNATURE_INVALID");
  });

  test("an id no reachable registry carries, while another failed, is refused the same way", async () => {
    await addRegistry("alpha", "com.example.other");
    const beta = await addRegistry("beta");
    rmSync(beta, { recursive: true, force: true });
    expect((await refusal(resolveRegistryEntry(deps(), ID, undefined))).code).toBe(
      "ERR_REGISTRY_AMBIGUOUS",
    );
  });

  test("every target failing verification surfaces the verification code, not NOT_FOUND", async () => {
    const alpha = await addRegistry("alpha");
    db.run("UPDATE extension_registry SET last_sequence = 5 WHERE name = 'alpha'");
    const indexPath = join(alpha, "index.json");
    resignIndex(indexPath, {
      ...(JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>),
      sequence: 4,
    });
    const bare = await refusal(resolveRegistryEntry(deps(), ID, undefined));
    expect(bare.code).toBe("ERR_REGISTRY_ROLLBACK");
    expect(bare.message).toContain("alpha: failed verification: ERR_REGISTRY_ROLLBACK");
    expect((await refusal(resolveRegistryEntry(deps(), ID, "alpha"))).code).toBe(
      "ERR_REGISTRY_ROLLBACK",
    );
  });

  test("a verification failure wins over an unreachable one when nothing verified", async () => {
    const alpha = await addRegistry("alpha");
    await addRegistry("beta");
    rmSync(alpha, { recursive: true, force: true });
    // beta is now pinned to a key other than the one its index is signed with.
    db.run("UPDATE extension_registry SET root_key = ? WHERE name = 'beta'", [
      encodeBase64(generateEd25519Keypair().pubkey),
    ]);
    const e = await refusal(resolveRegistryEntry(deps(), ID, undefined));
    expect(e.code).toBe("ERR_REGISTRY_ROOT_KEY_CHANGED");
    expect(e.message).toContain("alpha: unreachable");
  });

  test("every target unreachable: ERR_REGISTRY_UNREACHABLE", async () => {
    const alpha = await addRegistry("alpha");
    rmSync(alpha, { recursive: true, force: true });
    const e = await refusal(resolveRegistryEntry(deps(), ID, undefined));
    expect(e.code).toBe("ERR_REGISTRY_UNREACHABLE");
    expect(e.message).toContain("alpha: unreachable");
  });

  test("no registry carries it and nothing failed: ERR_REGISTRY_NOT_FOUND", async () => {
    await addRegistry("alpha", "com.example.other");
    expect((await refusal(resolveRegistryEntry(deps(), ID, undefined))).code).toBe(
      "ERR_REGISTRY_NOT_FOUND",
    );
  });
});

describe("bare resolution and the built-in registry under air gap (B31)", () => {
  /** A remote built-in on another trust root than the owner's folders; never actually fetched. */
  const remoteBuiltin = () => ({
    url: "https://registry.nimbus.test/",
    rootKey: encodeBase64(generateEd25519Keypair().pubkey),
  });

  /** Deps whose every network request is counted (and refused). */
  function airGapDeps(airGap: boolean): { d: RegistryFetchDeps; requests: string[] } {
    const requests: string[] = [];
    return {
      requests,
      d: {
        ...deps(),
        fetchFn: (url) => {
          requests.push(url);
          return Promise.reject(new Error("no network in this test"));
        },
        enforceAirGap: () => airGap,
        builtin: remoteBuiltin(),
      },
    };
  }

  test("air-gapped bare install resolves from owner registries without the builtin", async () => {
    await addRegistry("alpha");
    const { d, requests } = airGapDeps(true);
    expect(registryTargets(d, undefined).map((r) => r.name)).toEqual(["alpha"]);
    expect((await resolveRegistryEntry(d, ID, undefined)).reg.name).toBe("alpha");
    expect(requests).toEqual([]);
  });

  test("air-gapped bare install of an id no owner registry carries names the skipped built-in", async () => {
    const official = "com.example.official-only";
    const skipped = `no configured registry carries "${official}"; the official registry ${BUILTIN_REGISTRY_NAME} was not consulted because [llm] enforce_air_gap is on`;
    // No owner registries at all: the most common air-gapped owner.
    const none = airGapDeps(true);
    expect(registryTargets(none.d, undefined)).toEqual([]);
    const e0 = await refusal(resolveRegistryEntry(none.d, official, undefined));
    expect(e0.code).toBe("ERR_REGISTRY_NOT_FOUND");
    expect(e0.message).toBe(`ERR_REGISTRY_NOT_FOUND: ${skipped}`);
    expect(none.requests).toEqual([]);
    // An owner registry that does not carry the id: the same refusal.
    await addRegistry("alpha");
    const one = airGapDeps(true);
    const e1 = await refusal(resolveRegistryEntry(one.d, official, undefined));
    expect(e1.message).toBe(`ERR_REGISTRY_NOT_FOUND: ${skipped}`);
    expect(one.requests).toEqual([]);
    // Without a built-in to skip, nothing extra is claimed.
    const e2 = await refusal(
      resolveRegistryEntry({ ...one.d, builtin: null }, official, undefined),
    );
    expect(e2.message).toBe(`ERR_REGISTRY_NOT_FOUND: no registry carries "${official}"`);
  });

  test("named --registry nimbus-official under air gap still refuses ERR_REGISTRY_AIR_GAP", async () => {
    await addRegistry("alpha");
    const { d, requests } = airGapDeps(true);
    expect(registryTargets(d, BUILTIN_REGISTRY_NAME).map((r) => r.name)).toEqual([
      BUILTIN_REGISTRY_NAME,
    ]);
    const e = await refusal(resolveRegistryEntry(d, ID, BUILTIN_REGISTRY_NAME));
    // AIR_GAP is one of the "could not be reached" codes, so the lookup's own code is UNREACHABLE;
    // the cause it names is the air-gap refusal, and no request left the process.
    expect(e.code).toBe("ERR_REGISTRY_UNREACHABLE");
    expect(e.message).toContain(`${BUILTIN_REGISTRY_NAME}: unreachable (ERR_REGISTRY_AIR_GAP`);
    expect(requests).toEqual([]);
  });

  test("offline (no air gap) bare install with an unreachable builtin is still ambiguous", async () => {
    await addRegistry("alpha");
    const { d, requests } = airGapDeps(false);
    expect(registryTargets(d, undefined).map((r) => r.name)).toEqual([
      "alpha",
      BUILTIN_REGISTRY_NAME,
    ]);
    const e = await refusal(resolveRegistryEntry(d, ID, undefined));
    expect(e.code).toBe("ERR_REGISTRY_AMBIGUOUS");
    expect(e.message).toContain(`${BUILTIN_REGISTRY_NAME}: unreachable`);
    expect(e.message).toContain("--registry <name>");
    expect(requests).toEqual(["https://registry.nimbus.test/index.json"]);
  });
});
