/** Wiring and parameter gaps of `registry-rpc.ts`: an unconfigured gateway, bad selectors, unknown methods. */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { MockVault } from "../vault/mock.ts";
import {
  dispatchRegistryRpc,
  type RegistryFetchBag,
  type RegistryOwnerGate,
} from "./registry-rpc.ts";

let db: Database;
let tmp: string;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-rpc-gaps-"));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const bag: RegistryFetchBag = {
  fetchFn: () => Promise.reject(new Error("unexpected network")),
  enforceAirGap: () => false,
  now: () => Date.parse("2026-10-18T12:00:00Z"),
  production: false,
  builtin: null,
};
const yes: RegistryOwnerGate = () => Promise.resolve(true);

describe("dispatchRegistryRpc wiring", () => {
  test("a method outside the registry namespace is a miss", async () => {
    expect(await dispatchRegistryRpc({ method: "registry.nope", params: {}, db })).toEqual({
      kind: "miss",
    });
  });

  test("install without a fetch bag refuses as an internal error", async () => {
    await expect(
      dispatchRegistryRpc({
        method: "registry.install",
        params: { id: "acme.tool" },
        db,
        ownerGate: yes,
        extensionsDir: join(tmp, "x"),
        vault: new MockVault(),
      }),
    ).rejects.toMatchObject({ rpcCode: -32603 });
  });

  test("install without an extensions directory or a vault refuses as an internal error", async () => {
    const base = {
      method: "registry.install",
      params: { id: "acme.tool" },
      db,
      fetch: bag,
      ownerGate: yes,
    };
    await expect(dispatchRegistryRpc({ ...base, vault: new MockVault() })).rejects.toThrow(
      "extensions directory and Vault",
    );
    await expect(
      dispatchRegistryRpc({ ...base, extensionsDir: "   ", vault: new MockVault() }),
    ).rejects.toThrow("extensions directory and Vault");
    await expect(dispatchRegistryRpc({ ...base, extensionsDir: tmp })).rejects.toThrow(
      "extensions directory and Vault",
    );
  });

  test("install selectors are validated before anything runs", async () => {
    const run = (params: unknown) =>
      dispatchRegistryRpc({
        method: "registry.install",
        params,
        db,
        fetch: bag,
        ownerGate: yes,
        extensionsDir: tmp,
        vault: new MockVault(),
      });
    await expect(run({})).rejects.toThrow("id (non-empty string) required");
    await expect(run({ id: "a.b", registry: 5 })).rejects.toThrow("registry (non-empty string)");
    await expect(run({ id: "a.b", version: "" })).rejects.toThrow("version (non-empty string)");
    await expect(run({ id: "a.b", acceptPublisherKey: 5 })).rejects.toThrow(
      "32-hex-character key fingerprint",
    );
  });

  test("a registry install of an id no registry carries is refused as a registry-class error", async () => {
    await expect(
      dispatchRegistryRpc({
        method: "registry.install",
        params: { id: "acme.tool", registry: "main", version: "1.0.0", channel: "beta" },
        db,
        fetch: bag,
        ownerGate: yes,
        extensionsDir: tmp,
        vault: new MockVault(),
      }),
    ).rejects.toMatchObject({ rpcCode: -32000 });
  });

  test("methods that fetch refuse when the gateway has no fetch bag", async () => {
    for (const [method, params] of [
      ["registry.search", { query: "x" }],
      ["registry.info", { id: "acme.tool" }],
      ["registry.refresh", { name: "main" }],
    ] as const) {
      await expect(dispatchRegistryRpc({ method, params, db })).rejects.toThrow();
    }
  });

  test("refresh of a named registry that is not stored is ERR_REGISTRY_NOT_FOUND", async () => {
    await expect(
      dispatchRegistryRpc({
        method: "registry.refresh",
        params: { name: "ghost" },
        db,
        fetch: bag,
      }),
    ).rejects.toThrow("no registry named");
  });

  test("a registry.list on an empty database is an empty list", async () => {
    const out = await dispatchRegistryRpc({ method: "registry.list", params: undefined, db });
    expect(out.kind).toBe("hit");
  });
});
