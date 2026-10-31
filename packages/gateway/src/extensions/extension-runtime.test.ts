import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertExtensionRow } from "../automation/extension-store.ts";
import { userMcpManifestFromRow } from "../connectors/lazy-mesh/user-mcp.ts";
import { LocalIndex } from "../index/local-index.ts";
import { DEFAULT_RUNTIME_LAYOUT, type RuntimeLayout } from "../platform/runtime-layout.ts";
import { extensionStageRootFor, sandboxCwdFor } from "../platform/sandbox/sandbox-cwd.ts";
import {
  isSandboxWrapperOnlyEnv,
  policyFromManifest,
  SANDBOX_CWD_ENV,
  SANDBOX_POLICY_ENV,
} from "../platform/sandbox/sandbox-policy.ts";
import { MockVault } from "../vault/mock.ts";
import { approveExtensionRun } from "./approve-run.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import {
  buildExtensionRuntimeManifest,
  buildExtensionSpawnSpec,
  createExtensionSlotSource,
  extensionSpawnPolicyForGrants,
} from "./extension-runtime.ts";
import {
  copyRegularTree,
  type StagedExtensionForSpawn,
  stageVerifiedExtension,
} from "./extension-stage.ts";
import { installExtensionFromLocalDirectory } from "./install-from-local.ts";
import { type ExtensionManifest, parseExtensionManifestJson } from "./manifest.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { getRunGrant, upsertRunGrant } from "./run-grant-store.ts";
import { extensionProcessEnv } from "./spawn-env.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import type { VerifiedExtensionForSpawn } from "./verified-extension.ts";
import { encodeBase64, generateEd25519Keypair, signManifest } from "./verify-signature.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

/** A real install tree on disk with its real digest, plus an empty sandbox root. */
function realInstall(serviceId = "ext_foo"): {
  v: VerifiedExtensionForSpawn;
  sandboxDir: string;
  /** The old per-policy leaf: no longer created or used by the runtime. */
  leaf: string;
  /** Where this service's per-spawn stages live. */
  stageRoot: string;
} {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-ext-runtime-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const installPath = join(root, "install");
  mkdirSync(join(installPath, "dist"), { recursive: true });
  writeFileSync(join(installPath, "nimbus.extension.json"), "{}");
  writeFileSync(join(installPath, "dist", "index.js"), 'import "./chunk.js";\n');
  writeFileSync(join(installPath, "dist", "chunk.js"), "export const x = 1;\n");
  const sandboxDir = join(root, "sandbox");
  return {
    v: {
      extensionId: "foo.bar",
      serviceId,
      version: "1.2.3",
      installPath,
      entryPath: join(installPath, "dist", "index.js"),
      grants: { network: ["api.example.com"], read: [join(root, "r1")], write: [join(root, "w1")] },
      treeDigest: computeExtensionTreeDigest(installPath),
      credentials: {},
    },
    sandboxDir,
    leaf: sandboxCwdFor(sandboxDir, `ext.${serviceId}`),
    stageRoot: extensionStageRootFor(sandboxDir, serviceId),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Every entry in a stage root (each is a per-spawn stage; nothing else is kept there). */
const stages = (stageRoot: string): string[] =>
  existsSync(stageRoot) ? readdirSync(stageRoot) : [];

const runtimeReadPaths = [join(process.cwd(), "bun-runtime")];

const DEV_LAYOUT: RuntimeLayout = {
  execPath: join(process.cwd(), "bun.exe"),
  moduleDir: join(process.cwd(), "packages", "gateway", "src", "platform"),
  gatewayEntry: join(process.cwd(), "packages", "gateway", "src", "index.ts"),
};
const COMPILED_LAYOUT: RuntimeLayout = {
  execPath: join(process.cwd(), "nimbus-gateway.exe"),
  moduleDir: "/$bunfs/root",
  gatewayEntry: "/$bunfs/root/index.ts",
};

describe("buildExtensionRuntimeManifest", () => {
  test("id, read = approved grants + runtime paths (no install path), write unchanged, network unchanged", () => {
    const { v } = realInstall();
    const m = buildExtensionRuntimeManifest(v, runtimeReadPaths);
    expect(m.id).toBe("ext.ext_foo");
    expect(m.version).toBe("1.2.3");
    expect(m.updateChannel).toBe("stable");
    expect(m.permissions.filesystem?.read).toEqual([...v.grants.read, ...runtimeReadPaths]);
    expect(m.permissions.filesystem?.read).not.toContain(v.installPath);
    expect(m.permissions.filesystem?.write).toEqual([...v.grants.write]);
    expect(m.permissions.filesystem?.write).not.toContain(v.installPath);
    expect(m.permissions.network).toEqual(["api.example.com"]);
  });
});

describe("an extension can never set ownerConfiguredNetwork or firstPartyPolicy (I43)", () => {
  test("a manifest file naming firstPartyPolicy parses without it", () => {
    const parsed = parseExtensionManifestJson(
      JSON.stringify({
        id: "x",
        version: "1.0.0",
        permissions: { network: ["10.0.0.1"], filesystem: { read: [], write: [] } },
        firstPartyPolicy: true,
      }),
    );
    expect((parsed as ExtensionManifest).firstPartyPolicy).toBeUndefined();
    expect("firstPartyPolicy" in parsed).toBe(false);
  });

  test("neither the spawn manifest nor the spawn policy carries firstPartyPolicy", () => {
    const { v } = realInstall();
    const m = buildExtensionRuntimeManifest(v, runtimeReadPaths);
    expect("firstPartyPolicy" in m).toBe(false);
    expect("firstPartyPolicy" in policyFromManifest(m)).toBe(false);
    expect(
      "firstPartyPolicy" in extensionSpawnPolicyForGrants(v.serviceId, v.grants, runtimeReadPaths),
    ).toBe(false);
  });

  test("a manifest file naming it parses without it", () => {
    const parsed = parseExtensionManifestJson(
      JSON.stringify({
        id: "x",
        version: "1.0.0",
        permissions: { network: ["10.0.0.1"], filesystem: { read: [], write: [] } },
        ownerConfiguredNetwork: ["10.0.0.1"],
      }),
    );
    expect((parsed as ExtensionManifest).ownerConfiguredNetwork).toBeUndefined();
    expect("ownerConfiguredNetwork" in parsed).toBe(false);
  });

  test("neither the spawn manifest nor the spawn policy carries it", () => {
    const { v } = realInstall();
    const m = buildExtensionRuntimeManifest(v, runtimeReadPaths);
    expect("ownerConfiguredNetwork" in m).toBe(false);
    expect("ownerConfiguredNetwork" in policyFromManifest(m)).toBe(false);
    expect(
      "ownerConfiguredNetwork" in
        extensionSpawnPolicyForGrants(v.serviceId, v.grants, runtimeReadPaths),
    ).toBe(false);
  });
});

describe("no manifest file or user MCP row can set firstPartyWildcardHosts (I43)", () => {
  const WILDCARDS = ["*.sharepoint.com", "*.blob.core.windows.net"];

  test("a manifest file naming it parses without it, and so does its policy", () => {
    const parsed = parseExtensionManifestJson(
      JSON.stringify({
        id: "x",
        version: "1.0.0",
        permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
        firstPartyPolicy: true,
        firstPartyWildcardHosts: WILDCARDS,
      }),
    );
    expect((parsed as ExtensionManifest).firstPartyWildcardHosts).toBeUndefined();
    expect("firstPartyWildcardHosts" in parsed).toBe(false);
    expect("firstPartyWildcardHosts" in policyFromManifest(parsed)).toBe(false);
  });

  test("neither the spawn manifest nor the spawn policy of an extension carries it", () => {
    const { v } = realInstall();
    const m = buildExtensionRuntimeManifest(v, runtimeReadPaths);
    expect("firstPartyWildcardHosts" in m).toBe(false);
    expect("firstPartyWildcardHosts" in policyFromManifest(m)).toBe(false);
    expect(
      "firstPartyWildcardHosts" in
        extensionSpawnPolicyForGrants(v.serviceId, v.grants, runtimeReadPaths),
    ).toBe(false);
  });

  test("a user MCP row, even one whose --net holds a wildcard, yields a manifest without it", () => {
    const r = userMcpManifestFromRow({
      service_id: "mcp_x",
      command: "/bin/echo",
      args_json: "[]",
      created_at: 0,
      read_paths_json: "[]",
      net_hosts_json: JSON.stringify(WILDCARDS),
      model_access: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect("firstPartyWildcardHosts" in r.manifest).toBe(false);
    expect("firstPartyWildcardHosts" in policyFromManifest(r.manifest)).toBe(false);
  });
});

describe("extensionSpawnPolicyForGrants", () => {
  test("is exactly the policy the spawn manifest carries, so a preflight asks about what spawns", () => {
    const { v } = realInstall();
    expect(extensionSpawnPolicyForGrants(v.serviceId, v.grants, runtimeReadPaths)).toEqual(
      policyFromManifest(buildExtensionRuntimeManifest(v, runtimeReadPaths)),
    );
  });
});

describe("buildExtensionSpawnSpec", () => {
  function staged(): { s: StagedExtensionForSpawn } {
    const { v, stageRoot } = realInstall();
    return { s: stageVerifiedExtension(v, stageRoot) };
  }

  function assertWrapped(spec: { env: Record<string, string> }, s: StagedExtensionForSpawn): void {
    const manifest = buildExtensionRuntimeManifest(s, runtimeReadPaths);
    const policy = JSON.parse(spec.env[SANDBOX_POLICY_ENV] ?? "null") as {
      id: string;
      permissions: unknown;
    };
    expect(policy.id).toBe(manifest.id);
    expect(policy.permissions).toEqual(JSON.parse(JSON.stringify(manifest.permissions)));
    const allowed = new Set([
      ...Object.keys(extensionProcessEnv({})),
      SANDBOX_POLICY_ENV,
      SANDBOX_CWD_ENV,
    ]);
    // The wrapper strips the wrapper-only pair before the child, and only a network policy gets it.
    for (const k of Object.keys(spec.env)) {
      expect(allowed.has(k) || isSandboxWrapperOnlyEnv(k)).toBe(true);
    }
    // The working directory is the fresh stage itself, never the long-lived per-policy leaf.
    expect(spec.env[SANDBOX_CWD_ENV]).toBe(s.stagePath);
  }

  test("compiled: the self-role runs the STAGED entry", () => {
    const { s } = staged();
    const spec = buildExtensionSpawnSpec(s, {
      runtimeReadPaths,
      layout: COMPILED_LAYOUT,
      credentialEnv: {},
    });
    // The sandbox wrapper prefix comes from the live layout; the confined command is the layout's
    // own executable re-entered in the extension role.
    expect(spec.args.slice(-3)).toEqual([
      COMPILED_LAYOUT.execPath,
      "__nimbus-extension",
      s.entryPath,
    ]);
    assertWrapped(spec, s);
  });

  test("dev tree: the inline role runs the STAGED entry with no .env and no auto-install, loading no gateway source", () => {
    const { s } = staged();
    const spec = buildExtensionSpawnSpec(s, {
      runtimeReadPaths,
      layout: DEV_LAYOUT,
      credentialEnv: {},
    });
    const tail = spec.args.slice(-6);
    expect(tail[0]).toBe(DEV_LAYOUT.execPath);
    expect(tail.slice(1, 4)).toEqual(["--no-env-file", "--no-install", "-e"]);
    expect(tail[4]).toBe(devInlineRole());
    expect(tail[5]).toBe(s.entryPath);
    // The sandbox wrapper itself still runs from the LIVE gateway entry (unconfined; selfSpawn
    // reads the default layout, not DEV_LAYOUT); the confined command after it is the bare
    // interpreter, never the gateway entry.
    // Compared against the LIVE layout, not DEV_LAYOUT, whose paths derive from `process.cwd()`
    // and so only coincide with it when the suite runs from the repo root.
    const wrapperEntry = DEFAULT_RUNTIME_LAYOUT.gatewayEntry;
    expect(spec.args.indexOf(wrapperEntry)).toBe(0);
    expect(spec.args.lastIndexOf(wrapperEntry)).toBe(0);
    for (const a of tail) {
      expect(a === wrapperEntry || a === DEV_LAYOUT.gatewayEntry).toBe(false);
    }
    assertWrapped(spec, s);
  });
});

/** The inline role exactly as the dev-tree spec carries it (it is not exported). */
function devInlineRole(): string {
  const { v, stageRoot } = realInstall();
  const spec = buildExtensionSpawnSpec(stageVerifiedExtension(v, stageRoot), {
    runtimeReadPaths,
    layout: DEV_LAYOUT,
    credentialEnv: {},
  });
  return spec.args.at(-2) ?? "";
}

describe("the dev-tree inline role", () => {
  test("carries no backslash (a backslash escape in -e code reached the Windows child mangled)", () => {
    const code = devInlineRole();
    expect(code).toContain("await import(pathToFileURL(entry).href);");
    expect(code).not.toContain("\\");
    // A throwing entry prints its stack too, as the compiled self-role does.
    expect(code).toContain("console.error(err.stack)");
  });

  test("imports an absolute entry, and refuses a relative one with exit 2", async () => {
    const inline = devInlineRole();
    const { v } = realInstall();
    writeFileSync(v.entryPath, 'console.log("ENTRY-RAN");\n');
    const ok = Bun.spawn([process.execPath, "-e", inline, v.entryPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(ok.stdout).text()).toContain("ENTRY-RAN");
    expect(await ok.exited).toBe(0);
    const bad = Bun.spawn([process.execPath, "-e", inline, "dist/x.js"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(bad.stderr).text()).toContain("needs an absolute entry path");
    expect(await bad.exited).toBe(2);
  });
});

describe("stageVerifiedExtension", () => {
  test("stages a fresh <uuid> copy under the stage root whose digest equals the verified one", () => {
    const { v, stageRoot, leaf } = realInstall();
    const s = stageVerifiedExtension(v, stageRoot);
    expect(stages(stageRoot)).toHaveLength(1);
    expect(stages(stageRoot)[0]).toMatch(UUID_RE);
    expect(s.stagePath).toBe(join(stageRoot, stages(stageRoot)[0] ?? ""));
    expect(s.entryPath).toBe(join(s.stagePath, "dist", "index.js"));
    expect(existsSync(s.entryPath)).toBe(true);
    expect(computeExtensionTreeDigest(s.stagePath)).toBe(v.treeDigest);
    // The install tree itself is untouched and not where the entry points.
    expect(s.installPath).toBe(v.installPath);
    expect(s.entryPath.startsWith(v.installPath)).toBe(false);
    // The old per-policy leaf is not created at all.
    expect(existsSync(leaf)).toBe(false);
  });

  test("a copy tampered between copy and digest refuses RUN_TREE_CHANGED and leaves no stage", () => {
    const { v, stageRoot } = realInstall();
    let err: unknown;
    try {
      stageVerifiedExtension(v, stageRoot, {
        copyTree: (from, to) => {
          copyRegularTree(from, to);
          writeFileSync(join(to, "dist", "chunk.js"), "evil();\n");
        },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExtensionRunGrantError);
    expect((err as ExtensionRunGrantError).code).toBe("ERR_EXTENSION_RUN_TREE_CHANGED");
    expect(stages(stageRoot)).toEqual([]);
  });

  test("a copy that cannot be made refuses RUN_TREE_CHANGED and leaves no stage", () => {
    const { v, stageRoot } = realInstall();
    expect(() =>
      stageVerifiedExtension(v, stageRoot, {
        copyTree: (_from, to) => {
          mkdirSync(to);
          throw new Error("disk full");
        },
      }),
    ).toThrow(ExtensionRunGrantError);
    expect(stages(stageRoot)).toEqual([]);
  });

  test("a non-regular entry in the tree refuses rather than being reproduced", () => {
    const { v, stageRoot } = realInstall();
    expect(() =>
      stageVerifiedExtension(v, stageRoot, {
        copyTree: () => {
          throw new Error("extension tree holds a non-regular entry");
        },
      }),
    ).toThrow(ExtensionRunGrantError);
  });

  test("an entry outside its install tree refuses ENTRY_OUTSIDE and leaves no stage", () => {
    const { v, stageRoot } = realInstall();
    const err = (() => {
      try {
        stageVerifiedExtension(
          { ...v, entryPath: join(v.installPath, "..", "elsewhere.js") },
          stageRoot,
        );
      } catch (e) {
        return e;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ExtensionRunGrantError);
    expect((err as ExtensionRunGrantError).code).toBe("ERR_EXTENSION_ENTRY_OUTSIDE");
    expect(stages(stageRoot)).toEqual([]);
  });

  test("EVERYTHING already in the stage root is swept: earlier stages and planted files alike", () => {
    const { v, stageRoot } = realInstall();
    const first = stageVerifiedExtension(v, stageRoot);
    mkdirSync(join(stageRoot, "node_modules", "evil"), { recursive: true });
    writeFileSync(join(stageRoot, "bunfig.toml"), 'preload = ["./evil.ts"]\n');
    writeFileSync(join(stageRoot, ".env"), "EVIL=1\n");
    const second = stageVerifiedExtension(v, stageRoot);
    expect(stages(stageRoot)).toEqual([second.stagePath.slice(stageRoot.length + 1)]);
    expect(existsSync(first.stagePath)).toBe(false);
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
      credentials_json: "{}",
    });
  }
  return db;
}

describe("createExtensionSlotSource", () => {
  const env = {} as ExtensionRunGrantEnv;
  const mk = (db: Database, allowed: boolean, verify: never, sandboxDir = "x") =>
    createExtensionSlotSource({
      db,
      vault: new MockVault(),
      env,
      sandboxDir,
      runtimeReadPaths: () => [],
      isConnectorAllowed: () => allowed,
      verify,
    });

  test("isAllowed reads the policy predicate; disabledExtensionIdFor names only an approved-but-disabled extension", () => {
    const db = seed();
    expect(mk(db, true, (async () => {}) as never).isAllowed("ext_a")).toBe(true);
    expect(mk(db, false, (async () => {}) as never).isAllowed("ext_a")).toBe(false);
    const src = mk(db, true, (async () => {}) as never);
    expect(src.disabledExtensionIdFor("ext_b")).toBe("b.off");
    expect(src.disabledExtensionIdFor("ext_a")).toBeUndefined();
    expect(src.disabledExtensionIdFor("ext_zzz")).toBeUndefined();
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
    const { v } = realInstall();
    const src = mk(seed(), true, (async () => ({ ...v, serviceId: "ext_other" })) as never);
    await expect(src.prepareSpawn("ext_a")).rejects.toMatchObject({
      code: "ERR_EXTENSION_RUN_CHANGED",
    });
  });

  test("happy path stages under ext-stage/<serviceId>, the spec runs the staged entry with the stage as cwd", async () => {
    const { v, sandboxDir, stageRoot, leaf } = realInstall("ext_a");
    const src = mk(seed(), true, (async () => v) as never, sandboxDir);
    const p = await src.prepareSpawn("ext_a");
    expect(p.extensionId).toBe("foo.bar");
    expect(p.serviceId).toBe("ext_a");
    expect(stages(stageRoot)).toHaveLength(1);
    const stagePath = join(stageRoot, stages(stageRoot)[0] ?? "");
    expect(p.spec.args.at(-1)).toBe(join(stagePath, "dist", "index.js"));
    expect(p.spec.env[SANDBOX_CWD_ENV]).toBe(stagePath);
    expect(existsSync(leaf)).toBe(false);
    const policy = JSON.parse(p.spec.env[SANDBOX_POLICY_ENV] ?? "null") as {
      permissions: { filesystem: { read: string[] } };
    };
    expect(policy.permissions.filesystem.read).not.toContain(v.installPath);
  });

  test("discard deletes the stage this preparation made, and only that one", async () => {
    const { v, sandboxDir, stageRoot } = realInstall("ext_a");
    const src = mk(seed(), true, (async () => v) as never, sandboxDir);
    const p = await src.prepareSpawn("ext_a");
    expect(stages(stageRoot)).toHaveLength(1);
    p.discard();
    expect(stages(stageRoot)).toEqual([]);
    expect(existsSync(stageRoot)).toBe(true);
  });
});

describe("prepareSpawn: credentials reach the child only through extensionProcessEnv (I1/I43)", () => {
  const ID = "com.example.readwise";
  const TOKEN = "rw-secret-token-value";
  const OTHER = "unrelated-secret-value";

  /**
   * A real signed install, bound through a fixture continuity entry to the legacy `readwise`
   * connector and approved through `approveExtensionRun`; the slot source uses the REAL verifier
   * with the same table. Nothing here spawns a process.
   */
  async function boundFixture(token: string) {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-ext-cred-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const db = new Database(":memory:");
    cleanups.push(() => db.close());
    LocalIndex.ensureSchema(db);
    mkdirSync(join(root, "data"), { recursive: true });
    const env: ExtensionRunGrantEnv = {
      platform: process.platform,
      protectedRoots: [join(root, "data"), join(root, "config")],
      runtimeReadPaths: [join(root, "bun-bin")],
      realpath: (p) => realpathSync.native(p),
    };
    const vault = new MockVault();
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    const kp = generateEd25519Keypair();
    const manifest: Record<string, unknown> = {
      id: ID,
      version: "1.0.0",
      entry: "dist/index.js",
      credentials: { token: { env: "READWISE_TOKEN" } },
      publisher: { id: "rw-pub", key: encodeBase64(kp.pubkey) },
    };
    manifest["signature"] = await signManifest(manifest, kp.privkey);
    const publisherKeyPath = join(root, "pub.key");
    writeFileSync(publisherKeyPath, `${encodeBase64(kp.pubkey)}\n`);
    writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest));
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    await installExtensionFromLocalDirectory({
      db,
      extensionsDir: join(root, "data", "extensions"),
      sourcePath: src,
      approve: async () => true,
      vault,
      publisherKeyPath,
    });
    db.run("UPDATE extension SET source_root_fingerprint = 'root-fp' WHERE id = ?", [ID]);
    const table: ContinuityEntry[] = [
      {
        legacyServiceId: "readwise",
        extensionId: ID,
        publisherKey: encodeBase64(kp.pubkey),
        sourceRootFingerprint: "root-fp",
        credentials: { token: "readwise.token" },
        expectedPermissions: { network: [], read: [], write: [] },
        itemTypes: [],
      },
    ];
    await approveExtensionRun(ID, {
      db,
      env,
      gate: async () => true,
      runtimeEnabled: true,
      now: () => 1,
      continuityTable: table,
    });
    // The granted (legacy) key, plus secrets the extension was never granted: among them the key
    // its OWN keyspace would use had it not been bound.
    await vault.set("readwise.token", token);
    await vault.set("github.pat", OTHER);
    await vault.set("ext.ext_com_example_readwise.token", OTHER);
    const serviceId = getRunGrant(db, ID)?.service_id ?? "";
    const source = createExtensionSlotSource({
      db,
      vault,
      env,
      sandboxDir: join(root, "sandbox"),
      runtimeReadPaths: () => [join(root, "bun-bin")],
      isConnectorAllowed: () => true,
      continuityTable: table,
    });
    return { source, serviceId };
  }

  const allowedKeys = (extra: readonly string[]): Set<string> =>
    new Set([
      ...Object.keys(extensionProcessEnv({})),
      SANDBOX_POLICY_ENV,
      SANDBOX_CWD_ENV,
      ...extra,
    ]);

  test("spawn env carries READWISE_TOKEN from the granted key only", async () => {
    const { source, serviceId } = await boundFixture(TOKEN);
    expect(serviceId).toBe("ext_com_example_readwise");
    const p = await source.prepareSpawn(serviceId);
    expect(p.spec.env["READWISE_TOKEN"]).toBe(TOKEN);
    const allowed = allowedKeys(["READWISE_TOKEN"]);
    for (const k of Object.keys(p.spec.env)) expect(allowed.has(k)).toBe(true);
    // No ungranted secret reaches the child under any name, and no value travels in argv.
    expect(Object.values(p.spec.env)).not.toContain(OTHER);
    expect(JSON.stringify(p.spec.args)).not.toContain(TOKEN);
    expect(JSON.stringify(p.spec.args)).not.toContain(OTHER);
    p.discard();
  });

  test("blank vault value -> env var absent, not empty", async () => {
    const { source, serviceId } = await boundFixture("   ");
    const p = await source.prepareSpawn(serviceId);
    expect(Object.hasOwn(p.spec.env, "READWISE_TOKEN")).toBe(false);
    const allowed = allowedKeys([]);
    for (const k of Object.keys(p.spec.env)) expect(allowed.has(k)).toBe(true);
    p.discard();
  });

  test("a refused verification reads no credential from the Vault", async () => {
    const reads: string[] = [];
    const vault = new MockVault();
    const get = vault.get.bind(vault);
    vault.get = async (k: string) => {
      reads.push(k);
      return get(k);
    };
    const src = createExtensionSlotSource({
      db: seed(),
      vault,
      env: {} as ExtensionRunGrantEnv,
      sandboxDir: "x",
      runtimeReadPaths: () => [],
      isConnectorAllowed: () => true,
      verify: (async () => {
        throw new ExtensionRunGrantError("ERR_EXTENSION_RUN_CHANGED", "changed");
      }) as never,
    });
    await expect(src.prepareSpawn("ext_a")).rejects.toMatchObject({
      code: "ERR_EXTENSION_RUN_CHANGED",
    });
    expect(reads).toEqual([]);
  });
});
