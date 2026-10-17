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
import { LocalIndex } from "../index/local-index.ts";
import type { RuntimeLayout } from "../platform/runtime-layout.ts";
import { sandboxCwdFor } from "../platform/sandbox/sandbox-cwd.ts";
import { SANDBOX_CWD_ENV, SANDBOX_POLICY_ENV } from "../platform/sandbox/sandbox-policy.ts";
import { MockVault } from "../vault/mock.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import {
  buildExtensionRuntimeManifest,
  buildExtensionSpawnSpec,
  createExtensionSlotSource,
  DEV_EXTENSION_ROLE_INLINE_FOR_TEST,
} from "./extension-runtime.ts";
import {
  copyRegularTree,
  EXTENSION_STAGE_PREFIX,
  type StagedExtensionForSpawn,
  stageVerifiedExtension,
} from "./extension-stage.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { upsertRunGrant } from "./run-grant-store.ts";
import { extensionProcessEnv } from "./spawn-env.ts";
import { computeExtensionTreeDigest } from "./tree-digest.ts";
import type { VerifiedExtensionForSpawn } from "./verified-extension.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

/** A real install tree on disk with its real digest, plus an empty sandbox root. */
function realInstall(serviceId = "ext_foo"): {
  v: VerifiedExtensionForSpawn;
  sandboxDir: string;
  leaf: string;
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
    },
    sandboxDir,
    leaf: sandboxCwdFor(sandboxDir, `ext.${serviceId}`),
  };
}

const stages = (leaf: string): string[] =>
  existsSync(leaf) ? readdirSync(leaf).filter((n) => n.startsWith(EXTENSION_STAGE_PREFIX)) : [];

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

describe("buildExtensionSpawnSpec", () => {
  function staged(): { s: StagedExtensionForSpawn; sandboxDir: string } {
    const { v, sandboxDir, leaf } = realInstall();
    return { s: stageVerifiedExtension(v, leaf), sandboxDir };
  }

  function assertWrapped(
    spec: { env: Record<string, string> },
    s: StagedExtensionForSpawn,
    sandboxDir: string,
  ): void {
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
    for (const k of Object.keys(spec.env)) expect(allowed.has(k)).toBe(true);
    expect(spec.env[SANDBOX_CWD_ENV]).toBe(sandboxCwdFor(sandboxDir, "ext.ext_foo"));
  }

  test("compiled: the self-role runs the STAGED entry", () => {
    const { s, sandboxDir } = staged();
    const spec = buildExtensionSpawnSpec(s, {
      runtimeReadPaths,
      sandboxDir,
      layout: COMPILED_LAYOUT,
    });
    // The sandbox wrapper prefix comes from the live layout; the confined command is the layout's
    // own executable re-entered in the extension role.
    expect(spec.args.slice(-3)).toEqual([
      COMPILED_LAYOUT.execPath,
      "__nimbus-extension",
      s.entryPath,
    ]);
    assertWrapped(spec, s, sandboxDir);
  });

  test("dev tree: the inline role runs the STAGED entry, loading no gateway source", () => {
    const { s, sandboxDir } = staged();
    const spec = buildExtensionSpawnSpec(s, { runtimeReadPaths, sandboxDir, layout: DEV_LAYOUT });
    expect(spec.args.slice(-3)).toEqual(["-e", DEV_EXTENSION_ROLE_INLINE_FOR_TEST, s.entryPath]);
    // The sandbox wrapper itself still runs from the gateway entry (unconfined); the confined
    // command after it is the bare interpreter, not the gateway entry.
    expect(spec.args.indexOf(DEV_LAYOUT.gatewayEntry)).toBe(0);
    expect(spec.args.lastIndexOf(DEV_LAYOUT.gatewayEntry)).toBe(0);
    assertWrapped(spec, s, sandboxDir);
  });
});

describe("the dev-tree inline role", () => {
  test("carries no backslash (a backslash escape in -e code reached the Windows child mangled)", () => {
    expect(DEV_EXTENSION_ROLE_INLINE_FOR_TEST).not.toContain("\\");
  });

  test("imports an absolute entry, and refuses a relative one with exit 2", async () => {
    const { v } = realInstall();
    writeFileSync(v.entryPath, 'console.log("ENTRY-RAN");\n');
    const ok = Bun.spawn(
      [process.execPath, "-e", DEV_EXTENSION_ROLE_INLINE_FOR_TEST, v.entryPath],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await new Response(ok.stdout).text()).toContain("ENTRY-RAN");
    expect(await ok.exited).toBe(0);
    const bad = Bun.spawn(
      [process.execPath, "-e", DEV_EXTENSION_ROLE_INLINE_FOR_TEST, "dist/x.js"],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await new Response(bad.stderr).text()).toContain("needs an absolute entry path");
    expect(await bad.exited).toBe(2);
  });
});

describe("stageVerifiedExtension", () => {
  test("stages a copy under the leaf whose digest equals the verified one; the entry is inside it", () => {
    const { v, leaf } = realInstall();
    const s = stageVerifiedExtension(v, leaf);
    expect(s.stagePath.startsWith(join(leaf, EXTENSION_STAGE_PREFIX))).toBe(true);
    expect(s.entryPath).toBe(join(s.stagePath, "dist", "index.js"));
    expect(existsSync(s.entryPath)).toBe(true);
    expect(computeExtensionTreeDigest(s.stagePath)).toBe(v.treeDigest);
    // The install tree itself is untouched and not where the entry points.
    expect(s.installPath).toBe(v.installPath);
    expect(s.entryPath.startsWith(v.installPath)).toBe(false);
  });

  test("a copy tampered between copy and digest refuses RUN_TREE_CHANGED and leaves no stage", () => {
    const { v, leaf } = realInstall();
    let err: unknown;
    try {
      stageVerifiedExtension(v, leaf, {
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
    expect(stages(leaf)).toEqual([]);
  });

  test("a copy that cannot be made refuses RUN_TREE_CHANGED and leaves no stage", () => {
    const { v, leaf } = realInstall();
    expect(() =>
      stageVerifiedExtension(v, leaf, {
        copyTree: (_from, to) => {
          mkdirSync(to);
          throw new Error("disk full");
        },
      }),
    ).toThrow(ExtensionRunGrantError);
    expect(stages(leaf)).toEqual([]);
  });

  test("earlier run-* stages are swept; other leaf content is kept", () => {
    const { v, leaf } = realInstall();
    const first = stageVerifiedExtension(v, leaf);
    mkdirSync(join(leaf, "run-stale", "deep"), { recursive: true });
    writeFileSync(join(leaf, "keep.txt"), "x");
    const second = stageVerifiedExtension(v, leaf);
    expect(stages(leaf)).toEqual([second.stagePath.slice(leaf.length + 1)]);
    expect(existsSync(first.stagePath)).toBe(false);
    expect(existsSync(join(leaf, "keep.txt"))).toBe(true);
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

  test("happy path stages under ext.<serviceId>'s leaf and the spec runs the staged entry", async () => {
    const { v, sandboxDir } = realInstall("ext_a");
    const src = mk(seed(), true, (async () => v) as never, sandboxDir);
    const p = await src.prepareSpawn("ext_a");
    expect(p.extensionId).toBe("foo.bar");
    expect(p.serviceId).toBe("ext_a");
    const leaf = sandboxCwdFor(sandboxDir, "ext.ext_a");
    expect(stages(leaf)).toHaveLength(1);
    const entry = p.spec.args.at(-1) ?? "";
    expect(entry.startsWith(join(leaf, EXTENSION_STAGE_PREFIX))).toBe(true);
    const policy = JSON.parse(p.spec.env[SANDBOX_POLICY_ENV] ?? "null") as {
      permissions: { filesystem: { read: string[] } };
    };
    expect(policy.permissions.filesystem.read).not.toContain(v.installPath);
  });
});
