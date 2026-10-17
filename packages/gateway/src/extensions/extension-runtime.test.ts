import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { insertExtensionRow } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { sandboxCwdFor } from "../platform/sandbox/sandbox-cwd.ts";
import { SANDBOX_CWD_ENV, SANDBOX_POLICY_ENV } from "../platform/sandbox/sandbox-policy.ts";
import { MockVault } from "../vault/mock.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import {
  buildExtensionRuntimeManifest,
  buildExtensionSpawnSpec,
  createExtensionSlotSource,
} from "./extension-runtime.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { upsertRunGrant } from "./run-grant-store.ts";
import { extensionProcessEnv } from "./spawn-env.ts";
import type { VerifiedExtensionForSpawn } from "./verified-extension.ts";

const installPath = join(process.cwd(), "install-root");
const verified: VerifiedExtensionForSpawn = {
  extensionId: "foo.bar",
  serviceId: "ext_foo",
  version: "1.2.3",
  installPath,
  entryPath: join(installPath, "dist", "index.js"),
  grants: {
    network: ["api.example.com"],
    read: [join(process.cwd(), "r1")],
    write: [join(process.cwd(), "w1")],
  },
};
const runtimeReadPaths = [join(process.cwd(), "bun-runtime")];

describe("buildExtensionRuntimeManifest", () => {
  test("id, ordered read list, write never includes installPath, network unchanged", () => {
    const m = buildExtensionRuntimeManifest(verified, runtimeReadPaths);
    expect(m.id).toBe("ext.ext_foo");
    expect(m.version).toBe("1.2.3");
    expect(m.updateChannel).toBe("stable");
    expect(m.permissions.filesystem?.read).toEqual([
      ...verified.grants.read,
      installPath,
      ...runtimeReadPaths,
    ]);
    expect(m.permissions.filesystem?.write).toEqual([...verified.grants.write]);
    expect(m.permissions.filesystem?.write).not.toContain(installPath);
    expect(m.permissions.network).toEqual(["api.example.com"]);
  });
});

describe("buildExtensionSpawnSpec", () => {
  test("policy env matches manifest, argv ends with the self role + entry, env is scoped", () => {
    const sandboxDir = join(process.cwd(), "sandbox-root");
    const spec = buildExtensionSpawnSpec(verified, { runtimeReadPaths, sandboxDir });
    const manifest = buildExtensionRuntimeManifest(verified, runtimeReadPaths);
    const policy = JSON.parse(spec.env[SANDBOX_POLICY_ENV] ?? "null") as {
      id: string;
      permissions: unknown;
    };
    expect(policy.id).toBe(manifest.id);
    expect(policy.permissions).toEqual(JSON.parse(JSON.stringify(manifest.permissions)));
    expect(spec.args.slice(-2)).toEqual(["__nimbus-extension", verified.entryPath]);
    const allowed = new Set([
      ...Object.keys(extensionProcessEnv({})),
      SANDBOX_POLICY_ENV,
      SANDBOX_CWD_ENV,
    ]);
    for (const k of Object.keys(spec.env)) expect(allowed.has(k)).toBe(true);
    expect(spec.env[SANDBOX_CWD_ENV]).toBe(sandboxCwdFor(sandboxDir, "ext.ext_foo"));
  });
});

function seed(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  for (const [id, enabled] of [
    ["a.on", true],
    ["b.off", false],
  ] as const) {
    insertExtensionRow(db, {
      id,
      version: "1.0.0",
      install_path: join(process.cwd(), id),
      manifest_hash: "h",
      entry_hash: "e",
      enabled: enabled ? 1 : 0,
      installed_at: 1,
      last_verified_at: 1,
    });
    upsertRunGrant(db, {
      extension_id: id,
      service_id: id === "a.on" ? "ext_a" : "ext_b",
      version: "1.0.0",
      tree_digest: "d",
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
    });
  }
  return db;
}

describe("createExtensionSlotSource", () => {
  const env = {} as ExtensionRunGrantEnv;
  const mk = (db: Database, allowed: boolean, verify: never) =>
    createExtensionSlotSource({
      db,
      vault: new MockVault(),
      env,
      sandboxDir: "x",
      runtimeReadPaths: () => [],
      isConnectorAllowed: () => allowed,
      verify,
    });

  test("listServiceIds excludes disabled rows", () => {
    const calls: unknown[] = [];
    const src = mk(seed(), true, (async () => {
      calls.push(1);
    }) as never);
    expect(src.listServiceIds()).toEqual(["ext_a"]);
    expect(calls).toHaveLength(0);
  });

  test("policy refusal happens before the verifier", async () => {
    const calls: unknown[] = [];
    const src = mk(seed(), false, (async () => {
      calls.push(1);
    }) as never);
    await expect(src.prepareSpawn("ext_a")).rejects.toMatchObject({
      code: "ERR_EXTENSION_RUN_POLICY",
    });
    expect(calls).toHaveLength(0);
  });

  test("unknown service id is not approved", async () => {
    const src = mk(seed(), true, (async () => {}) as never);
    const err = await src.prepareSpawn("ext_zzz").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionRunGrantError);
    expect((err as ExtensionRunGrantError).code).toBe("ERR_EXTENSION_RUN_NOT_APPROVED");
  });

  test("a verified service id that differs from the requested one is RUN_CHANGED", async () => {
    const src = mk(seed(), true, (async () => ({ ...verified, serviceId: "ext_other" })) as never);
    await expect(src.prepareSpawn("ext_a")).rejects.toMatchObject({
      code: "ERR_EXTENSION_RUN_CHANGED",
    });
  });

  test("happy path returns the spec", async () => {
    const src = mk(seed(), true, (async () => ({ ...verified, serviceId: "ext_a" })) as never);
    const p = await src.prepareSpawn("ext_a");
    expect(p.extensionId).toBe("foo.bar");
    expect(p.serviceId).toBe("ext_a");
    expect(p.spec.args.slice(-2)[0]).toBe("__nimbus-extension");
  });
});
