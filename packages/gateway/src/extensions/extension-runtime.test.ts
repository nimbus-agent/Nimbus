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
import { DEFAULT_RUNTIME_LAYOUT, type RuntimeLayout } from "../platform/runtime-layout.ts";
import { extensionStageRootFor, sandboxCwdFor } from "../platform/sandbox/sandbox-cwd.ts";
import { SANDBOX_CWD_ENV, SANDBOX_POLICY_ENV } from "../platform/sandbox/sandbox-policy.ts";
import { MockVault } from "../vault/mock.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import {
  buildExtensionRuntimeManifest,
  buildExtensionSpawnSpec,
  createExtensionSlotSource,
} from "./extension-runtime.ts";
import {
  copyRegularTree,
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
    for (const k of Object.keys(spec.env)) expect(allowed.has(k)).toBe(true);
    // The working directory is the fresh stage itself, never the long-lived per-policy leaf.
    expect(spec.env[SANDBOX_CWD_ENV]).toBe(s.stagePath);
  }

  test("compiled: the self-role runs the STAGED entry", () => {
    const { s } = staged();
    const spec = buildExtensionSpawnSpec(s, { runtimeReadPaths, layout: COMPILED_LAYOUT });
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
    const spec = buildExtensionSpawnSpec(s, { runtimeReadPaths, layout: DEV_LAYOUT });
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
});
