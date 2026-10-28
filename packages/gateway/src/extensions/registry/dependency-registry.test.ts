import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RegistryError } from "@nimbus-dev/registry-format";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { BUILTIN_REGISTRY_NAME, type BuiltinRegistryConfig } from "./builtin-registry.ts";
import { resolveDependencyRegistry } from "./dependency-registry.ts";
import type { RegistryFetchDeps } from "./registry-fetch.ts";
import { insertRegistry, type RegistryRow } from "./registry-store.ts";

const ROOT_A = "tBHSfVjFZzyMoSVR69FbZfMyUstbLdUcfGwHKIaY/qA=";
const BUILTIN: BuiltinRegistryConfig = { url: "https://official.example/reg/", rootKey: ROOT_A };

let db: Database;
let airGap = false;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  airGap = false;
});

afterEach(() => {
  db.close();
});

const deps = (builtin: BuiltinRegistryConfig | null = BUILTIN): RegistryFetchDeps => ({
  db,
  fetchFn: () => Promise.reject(new Error("no network in this test")),
  enforceAirGap: () => airGap,
  now: () => 1000,
  production: false,
  builtin,
});

function add(name: string, url: string, fingerprint = "a".repeat(32)): RegistryRow {
  const row = {
    name,
    url,
    rootKey: ROOT_A,
    rootFingerprint: fingerprint,
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
    lastIndexSha256: null,
  };
  insertRegistry(db, row);
  return { ...row, lastFetchedAt: null };
}

function refusal(f: () => unknown): RegistryError {
  try {
    f();
  } catch (e) {
    if (e instanceof RegistryError) return e;
    throw e;
  }
  throw new Error("expected a RegistryError");
}

describe("resolveDependencyRegistry", () => {
  test("no registry means the parent's", () => {
    const parent = add("mine", "https://mine.example/reg");
    expect(resolveDependencyRegistry(deps(), parent, "dep", { range: "^1.0.0" })).toBe(parent);
  });

  test("nimbus-official is the built-in", () => {
    const parent = add("mine", "https://mine.example/reg");
    const got = resolveDependencyRegistry(deps(), parent, "dep", {
      range: "^1.0.0",
      registry: "nimbus-official",
    });
    expect(got.name).toBe(BUILTIN_REGISTRY_NAME);
    expect(got.builtin).toBe(true);
  });

  test("nimbus-official with no built-in configured is not added", () => {
    const parent = add("mine", "https://mine.example/reg");
    const e = refusal(() =>
      resolveDependencyRegistry(deps(null), parent, "dep", {
        range: "^1.0.0",
        registry: "nimbus-official",
      }),
    );
    expect(e.code).toBe("ERR_DEPENDENCY_REGISTRY_NOT_ADDED");
  });

  test("the built-in URL is the built-in", () => {
    const parent = add("mine", "https://mine.example/reg");
    const got = resolveDependencyRegistry(deps(), parent, "dep", {
      range: "^1.0.0",
      registry: "https://official.example/reg",
    });
    expect(got.builtin).toBe(true);
  });

  test("an owner registry matches across a trailing slash and host case", () => {
    const parent = add("mine", "https://mine.example/reg");
    const other = add("other", "https://r.example/reg/");
    const got = resolveDependencyRegistry(deps(), parent, "dep", {
      range: "^1.0.0",
      registry: "https://R.example/reg",
    });
    expect(got.name).toBe(other.name);
  });

  test("an owner row wins over the built-in at the same URL", () => {
    const parent = add("mine", "https://mine.example/reg");
    add("copy", "https://official.example/reg");
    const got = resolveDependencyRegistry(deps(), parent, "dep", {
      range: "^1.0.0",
      registry: "https://official.example/reg/",
    });
    expect(got.name).toBe("copy");
  });

  test("two owner rows at one URL are ambiguous", () => {
    const parent = add("mine", "https://mine.example/reg");
    add("one", "https://dup.example/reg");
    add("two", "https://dup.example/reg/");
    const e = refusal(() =>
      resolveDependencyRegistry(deps(), parent, "dep", {
        range: "^1.0.0",
        registry: "https://dup.example/reg",
      }),
    );
    expect(e.code).toBe("ERR_REGISTRY_AMBIGUOUS");
  });

  test("an unadded URL is refused with the registry add command", () => {
    const parent = add("mine", "https://mine.example/reg");
    const e = refusal(() =>
      resolveDependencyRegistry(deps(), parent, "dep", {
        range: "^1.0.0",
        registry: "https://other.example/",
      }),
    );
    expect(e.code).toBe("ERR_DEPENDENCY_REGISTRY_NOT_ADDED");
    expect(e.message).toContain("nimbus registry add <name> https://other.example/");
  });

  test("a fingerprint that differs is refused", () => {
    const parent = add("mine", "https://mine.example/reg");
    add("other", "https://r.example/reg", "a".repeat(32));
    const e = refusal(() =>
      resolveDependencyRegistry(deps(), parent, "dep", {
        range: "^1.0.0",
        registry: "https://r.example/reg",
        rootKeyFingerprint: "b".repeat(32),
      }),
    );
    expect(e.code).toBe("ERR_DEPENDENCY_REGISTRY_KEY_MISMATCH");
    expect(e.message).toContain("a".repeat(32));
    expect(e.message).toContain("b".repeat(32));
  });

  test("a matching fingerprint is accepted", () => {
    const parent = add("mine", "https://mine.example/reg");
    const other = add("other", "https://r.example/reg", "a".repeat(32));
    const got = resolveDependencyRegistry(deps(), parent, "dep", {
      range: "^1.0.0",
      registry: "https://r.example/reg",
      rootKeyFingerprint: "a".repeat(32),
    });
    expect(got.name).toBe(other.name);
  });

  test("the built-in registry under air gap is refused with the air-gap reason", () => {
    const parent = add("mine", "https://mine.example/reg");
    airGap = true;
    for (const registry of ["nimbus-official", "https://official.example/reg"]) {
      const e = refusal(() =>
        resolveDependencyRegistry(deps(), parent, "dep", { range: "^1.0.0", registry }),
      );
      expect(e.code).toBe("ERR_REGISTRY_AIR_GAP");
      expect(e.message).toContain(
        "dep needs the official registry, which is not consulted while [llm] enforce_air_gap is on",
      );
    }
  });
});
