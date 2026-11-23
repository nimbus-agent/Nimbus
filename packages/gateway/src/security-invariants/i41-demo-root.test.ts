import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { fakeVault, read, readAssembleFamily } from "../../test/helpers/security-invariants.ts";
import { ConsentCoordinatorImpl } from "../ipc/consent.ts";
import { createStreamRegistry } from "../ipc/engine-ask-stream.ts";
import { dispatchIndexReembedRpc } from "../ipc/index-reembed-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../ipc/server/context.ts";
import { demoRefusal } from "../ipc/server/demo-gate.ts";
import { tryDispatchDemoRpc } from "../ipc/server/dispatchers.ts";
import { bootPolicyFor } from "../platform/demo-boot.ts";
import {
  createDarwinPaths,
  createLinuxPaths,
  createWindowsPaths,
  type PlatformPaths,
} from "../platform/paths.ts";
import { ProviderRateLimiter } from "../sync/rate-limiter.ts";
import { SyncScheduler } from "../sync/scheduler.ts";
import { unboundSyncCapabilities } from "../sync/sync-capabilities.ts";
import type { SyncRuntimeContext } from "../sync/types.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { EphemeralVault } from "../vault/ephemeral.ts";
import { createNimbusVault } from "../vault/factory.ts";

describe("I41 — a demo-rooted process never reaches the real install", () => {
  // HOME/USERPROFILE too: `createDarwinPaths` reads `homedir()`, which follows these in-process
  // (verified 2026-09-18 on Bun 1.3.14) — so without them the darwin resolver computes paths under
  // the developer's REAL home. Nothing is written here, but the Global Constraint is unconditional.
  const ENV_KEYS = [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "TMPDIR",
    "NIMBUS_DEMO",
    "NIMBUS_CONFIG_DIR",
    "NIMBUS_GATEWAY_SOCKET",
  ] as const;
  let saved: Record<string, string | undefined> = {};
  let currentRoot: string | undefined;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    const root = mkdtempSync(join(tmpdir(), "nimbus-i41-"));
    currentRoot = root;
    process.env["HOME"] = join(root, "home");
    process.env["USERPROFILE"] = join(root, "home");
    process.env["APPDATA"] = join(root, "roaming");
    process.env["LOCALAPPDATA"] = join(root, "local");
    process.env["XDG_CONFIG_HOME"] = join(root, "xdg-config");
    process.env["XDG_DATA_HOME"] = join(root, "xdg-data");
    process.env["XDG_RUNTIME_DIR"] = join(root, "run");
    process.env["TMPDIR"] = join(root, "tmp");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (currentRoot !== undefined) {
      rmSync(currentRoot, { recursive: true, force: true });
      currentRoot = undefined;
    }
  });

  function isInside(child: string, parent: string): boolean {
    const rel = relative(parent, child);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  /**
   * Clause (1)+(2). A SUBTREE rule, not "nothing under the real configDir": on macOS configDir and
   * dataDir are the same directory, so the demo root necessarily sits under the real config dir.
   * What matters is that every demo path is inside a subtree that holds no real path.
   */
  function isolationViolations(real: PlatformPaths, demo: PlatformPaths): string[] {
    const demoRoot = join(real.dataDir, "demo");
    const out: string[] = [];
    for (const k of ["configDir", "dataDir", "logDir", "extensionsDir"] as const) {
      if (!isInside(demo[k], demoRoot)) out.push(`demo ${k} is outside the demo root: ${demo[k]}`);
      if (real[k] === demoRoot || isInside(real[k], demoRoot)) {
        out.push(`real ${k} lies inside the demo root: ${real[k]}`);
      }
    }
    if (demo.tempDir === real.tempDir) out.push(`tempDir is shared: ${demo.tempDir}`);
    if (demo.socketPath === real.socketPath) out.push(`socket is shared: ${demo.socketPath}`);
    return out;
  }

  const RESOLVERS = [
    ["win32", createWindowsPaths],
    ["darwin", createDarwinPaths],
    ["linux", createLinuxPaths],
  ] as const;

  for (const [os, resolve] of RESOLVERS) {
    test(`clauses 1–2 (${os}): every demo path is inside <realDataDir>/demo and no real path is`, () => {
      const real = resolve();
      process.env["NIMBUS_DEMO"] = "1";
      const demo = resolve();
      expect(demo.demo).toBe(true);
      expect(isolationViolations(real, demo)).toEqual([]);
    });

    test(`negative control (${os}): without the flag the same check reports violations`, () => {
      const real = resolve();
      const violations = isolationViolations(real, resolve());
      expect(violations.length).toBeGreaterThan(0);
      // `length > 0` alone is satisfiable by the tempDir/socket equality checks even if
      // `isInside` were broken (e.g. always returning `true`) — assert a SUBTREE violation is
      // actually present, so a broken `isInside` fails this test rather than passing vacuously.
      expect(violations).toContain(`demo configDir is outside the demo root: ${real.configDir}`);
    });

    test(`refusal (${os}): demo + a real-root override never resolves at all`, () => {
      process.env["NIMBUS_DEMO"] = "1";
      process.env["NIMBUS_GATEWAY_SOCKET"] = join(tmpdir(), "elsewhere.sock");
      expect(() => resolve()).toThrow("NIMBUS_GATEWAY_SOCKET");
    });
  }

  test("clause 3: a demo-rooted process gets an EphemeralVault, never an OS credential store", async () => {
    process.env["NIMBUS_DEMO"] = "1";
    const demo = createLinuxPaths();
    const vault = await createNimbusVault(demo);
    expect(vault).toBeInstanceOf(EphemeralVault);
  });

  test("clause 4: the demo boot policy disables the reap and the env sidecars (negative control: real enables both)", () => {
    const real = createLinuxPaths();
    process.env["NIMBUS_DEMO"] = "1";
    const demo = createLinuxPaths();
    expect(bootPolicyFor(real)).toEqual({
      reapAppContainers: true,
      envSidecars: true,
      syncScheduler: true,
      updaterStartupCheck: true,
      telemetryFlush: true,
      embeddingRuntime: true,
      extensionsAutoUpdate: true,
      chatops: true,
      osNotifications: true,
    });
    expect(bootPolicyFor(demo)).toEqual({
      reapAppContainers: false,
      envSidecars: false,
      syncScheduler: false,
      updaterStartupCheck: false,
      telemetryFlush: false,
      embeddingRuntime: false,
      extensionsAutoUpdate: false,
      chatops: false,
      osNotifications: false,
    });
  });

  test("clause 4 wiring: assemble.ts calls the reap and the sidecars exactly once each, each behind the policy", async () => {
    const src = await read("packages/gateway/src/platform/assemble.ts");
    expect(src.match(/reapAppContainersAtBoot\(/g)?.length).toBe(1);
    expect(src).toMatch(/if \(bootPolicy\.reapAppContainers\) \{\s*void reapAppContainersAtBoot\(/);
    expect(src.match(/collectSidecarsFromEnv\(db,/g)?.length).toBe(1);
    expect(src).toMatch(/if \(bootPolicy\.envSidecars\) \{\s*collectSidecarsFromEnv\(db,/);
    expect(src).toContain("const bootPolicy = bootPolicyFor(paths);");
    // OS toasts (pre-S3 E): the ONE runtime construction is gated on the demo boot policy.
    expect(src.match(/createNotificationsRuntime\(\{/g)?.length).toBe(1);
    expect(src).toMatch(/createNotificationsRuntime\(\{\s*allowed: bootPolicy\.osNotifications,/);
  });

  test("clause 3 wiring: linux.ts resolves paths before probing the real OS keyring, and skips the probe entirely in demo mode", async () => {
    const src = await read("packages/gateway/src/platform/linux.ts");
    expect(src.match(/assertLinuxSecretToolAvailable\(\)/g)?.length).toBe(1);
    expect(src).toMatch(
      /const paths = createLinuxPaths\(\);\s*if \(paths\.demo !== true\) \{\s*assertLinuxSecretToolAvailable\(\);\s*\}/,
    );
  });

  // Clause (5): `demo.*` is claimed only by a demo-rooted gateway; everywhere else the namespace
  // is unclaimed and the request falls through to JSON-RPC `-32601 Method not found`. The live
  // socket-level proof (a real `createIpcServer` answering `demo.seed` one way with `demo: true`
  // and the other way without it) lives in `ipc/server/server.test.ts` — this is the lighter unit
  // pin over the sub-dispatcher itself, plus the LAN denylist entry.

  function demoDispatchCtx(demo: boolean | undefined): ServerCtx {
    const db = new Database(":memory:");
    return {
      options: {
        listenPath: "",
        vault: fakeVault(),
        version: "test",
        localIndex: { getDatabase: () => db },
        configDir: "/demo-config",
        dataDir: "/demo-data",
        ...(demo === undefined ? {} : { demo }),
      },
      consentImpl: new ConsentCoordinatorImpl(() => undefined),
      startedAtMs: Date.now(),
      streamRegistry: createStreamRegistry(),
      broadcastNotification: () => {},
      getAgentInvokeHandler: () => undefined,
      getWorkflowRunHandler: () => undefined,
      getClientKind: () => "unknown",
      // `as unknown as ServerCtx`, not `any`: tryDispatchDemoRpc reads only `ctx.options`, never
      // the class-typed `localIndex` field beyond `.getDatabase()`, so a hand-built fake is safe.
    } as unknown as ServerCtx;
  }

  test("clause 5: tryDispatchDemoRpc claims demo.seed ONLY when ctx.options.demo === true", async () => {
    // Not demo-rooted (undefined, then explicitly false): falls through to the skip sentinel —
    // the caller's `Method not found`, not a runtime refusal — even though localIndex/configDir/
    // dataDir are all present, so the gate is `demo === true` and not merely "deps configured".
    expect(await tryDispatchDemoRpc(demoDispatchCtx(undefined), "demo.seed", {})).toBe(
      phase4RpcSkipped,
    );
    expect(await tryDispatchDemoRpc(demoDispatchCtx(false), "demo.seed", {})).toBe(
      phase4RpcSkipped,
    );

    // Demo-rooted: the method is CLAIMED — it reaches real seeding logic rather than the skip
    // sentinel. An invalid-params rejection is the observable: it can only fire from inside
    // `dispatchDemoRpc`'s own `requireSeedParams`, which is unreachable from the skip path.
    await expect(
      tryDispatchDemoRpc(demoDispatchCtx(true), "demo.seed", { nowMs: "not-a-number" }),
    ).rejects.toThrow(/ERR_INVALID_PARAMS/);
  });

  test("clause 5: checkLanMethodAllowed refuses demo.seed over LAN", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "peer:x", writeAllowed: true };
    expect(() => checkLanMethodAllowed("demo.seed", peer)).toThrow(/ERR_METHOD_NOT_ALLOWED/);
  });

  // Clause (6): a demo-rooted gateway is inert — its scheduler is constructed but can never run a
  // job, four host-global boot actions are skipped, and a write gate refuses everything outside a
  // small connector-read allow-list plus three explicitly named writes.

  test("clause 6: a SyncScheduler constructed with syncDisabled rejects forceSync with ERR_SYNC_DISABLED", async () => {
    const pino = (await import("pino")).default;
    const db = openMemoryIndexDatabase();
    const ctx: SyncRuntimeContext = {
      ...unboundSyncCapabilities(),
      db,
      vault: fakeVault(),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(),
      sandboxCwd: tmpdir(),
      credentialFor: () => ({ credential: "personal" }),
      runTeamList: async () => [],
      depth: "full",
    };
    const scheduler = new SyncScheduler(ctx, undefined, { syncDisabled: true });
    // No `register()` first: `forceSync` checks `syncDisabled` before it ever consults whether a
    // syncable is registered, so an unregistered service still proves the reject fires FIRST.
    await expect(scheduler.forceSync("demo-svc")).rejects.toThrow("ERR_SYNC_DISABLED");
  });

  test("clause 6: index.reembed refuses ERR_EMBEDDINGS_DISABLED on a demo gateway", async () => {
    // `resolveEmbedder`'s local arm calls `createLocalEmbedder` directly, bypassing the boot-path
    // `createEmbeddingRuntimeNonBlocking` gate — this is the OTHER place a demo gateway could
    // otherwise download the MiniLM model or make outbound calls. The throw fires before `db`/
    // `vault`/`logger` are ever touched, so a minimal fake ctx is enough to pin it.
    await expect(
      dispatchIndexReembedRpc(
        "index.reembed",
        {},
        // Not `any`: unreachable fields — the demo check throws before `db`/`vault`/`logger` are
        // ever read, so this minimal fake never needs to satisfy their real types.
        {
          paths: { dataDir: "/demo-data", demo: true },
          notify: () => {},
        } as unknown as Parameters<typeof dispatchIndexReembedRpc>[2],
      ),
    ).rejects.toThrow(/ERR_EMBEDDINGS_DISABLED/);
  });

  test("clause 6: demoRefusal refuses connector.auth with ERR_DEMO_FORBIDDEN, but admits the three read methods", () => {
    const refusal = demoRefusal("connector.auth");
    expect(refusal).toBeDefined();
    expect(refusal?.message).toContain("ERR_DEMO_FORBIDDEN");
    expect(demoRefusal("connector.listStatus")).toBeUndefined();
    expect(demoRefusal("connector.status")).toBeUndefined();
    expect(demoRefusal("connector.healthHistory")).toBeUndefined();
    for (const m of [
      "vault.set",
      "vault.delete",
      "data.import",
      "extension.install",
      "extension.eval",
      "pack.install",
      "pack.remove",
    ]) {
      expect(demoRefusal(m)?.message).toContain("ERR_DEMO_FORBIDDEN");
    }
  });

  test("clause 6 wiring: server.ts calls demoRefusal inside `if (ctx.options.demo === true)` before any dispatcher", async () => {
    const src = await read("packages/gateway/src/ipc/server/server.ts");
    const fnAt = src.indexOf("async function dispatchMethod(");
    const guardAt = src.indexOf("if (ctx.options.demo === true) {");
    const refusalAt = src.indexOf("const refusal = demoRefusal(method);");
    const firstDispatcherAt = src.indexOf("tryDispatchSessionRpc(");
    expect(fnAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(-1);
    expect(firstDispatcherAt).toBeGreaterThan(-1);
    expect(fnAt).toBeLessThan(guardAt);
    expect(guardAt).toBeLessThan(refusalAt);
    expect(refusalAt).toBeLessThan(firstDispatcherAt);
  });

  test("clause 6 wiring: assemble.ts starts the sync scheduler exactly once, and only inside `if (syncEnabled)`", async () => {
    // The scheduler is built and started in `platform/assemble/scheduler-mesh.ts`.
    const src = await read("packages/gateway/src/platform/assemble/scheduler-mesh.ts");
    const family = Object.values(await readAssembleFamily()).join("\n");
    expect(family.match(/syncScheduler\.start\(\);/g)?.length).toBe(1);
    expect(src.match(/syncScheduler\.start\(\);/g)?.length).toBe(1);
    // Bounded quantifier, not `[\s\S]*?` unbounded: assemble.ts has TWO `if (syncEnabled) {`
    // blocks, and the first (filesystem-root registration) closes long before `start()`. An
    // unbounded scan would happily stretch across both and pass even if `start()` sat outside
    // every guard — the bound is what forces the match onto the block that actually wraps it.
    expect(src).toMatch(/if \(syncEnabled\) \{[\s\S]{0,400}?syncScheduler\.start\(\);\s*\}/);
  });

  test("clause 6 wiring: the ONE SyncScheduler in assemble.ts is constructed with syncDisabled when the policy says so", async () => {
    // The start() pin above is not enough on its own: `forceSync` and each job's
    // `.finally → tick()` bypass `start()` entirely, so a demo scheduler is inert only because it
    // is BUILT with `syncDisabled`. Deleting this spread would leave a never-started scheduler that
    // `connector.sync`'s `forceSync` still drives — and no other test here would notice.
    const src = await read("packages/gateway/src/platform/assemble/scheduler-mesh.ts");
    const family = Object.values(await readAssembleFamily()).join("\n");
    expect(family.match(/new SyncScheduler\(/g)?.length).toBe(1);
    expect(src.match(/new SyncScheduler\(/g)?.length).toBe(1);
    expect(src).toContain("const syncEnabled = bootPolicyFor(paths).syncScheduler;");
    // Inside the constructor call itself: sliced from `new SyncScheduler(` to the call's own close
    // (the first `});` at the statement's two-space indent — the options object's callbacks close
    // deeper), so a matching spread in some LATER call cannot satisfy this.
    const start = src.indexOf("const syncScheduler = new SyncScheduler(syncContext, undefined, {");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n  });", start);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).toContain("...(syncEnabled ? {} : { syncDisabled: true }),");
  });

  test("clause 6 wiring: ChatOps boots only when the boot policy allows it", async () => {
    const root = await read("packages/gateway/src/platform/assemble.ts");
    const src = await read("packages/gateway/src/platform/assemble/chatops-boot.ts");
    const family = Object.values(await readAssembleFamily()).join("\n");
    // One call (plus the definition), handed the policy flag; the guard returns before building anything.
    expect(family.match(/(?<!function )bootChatopsIntoAssembly\(/g)?.length).toBe(1);
    expect(root.match(/(?<!function )bootChatopsIntoAssembly\(/g)?.length).toBe(1);
    expect(root).toContain("chatopsAllowedByBootPolicy: bootPolicy.chatops,");
    expect(src).toMatch(
      /if \(!chatopsCfg\.enabled \|\| !chatopsAllowedByBootPolicy\) return undefined;/,
    );
  });

  test("clause 6 wiring: assemble.ts gates the updater startup check, the telemetry flush and the extensions auto-update daemon on the boot policy", async () => {
    const src = await read("packages/gateway/src/platform/assemble.ts");
    const updater = await read("packages/gateway/src/platform/assemble/updater-boot.ts");
    const family = Object.values(await readAssembleFamily()).join("\n");
    // Call COUNTS first, like the reap/sidecar pins: a guarded call proves nothing if a second,
    // unguarded one sits elsewhere in the assembly. `wireUpdaterIntoIpc`'s own definition (in
    // `assemble/updater-boot.ts`) is excluded by the lookbehind.
    expect(family.match(/(?<!function )wireUpdaterIntoIpc\(/g)?.length).toBe(1);
    expect(family.match(/function wireUpdaterIntoIpc\(/g)?.length).toBe(1);
    expect(family.match(/startTelemetryFlushScheduler\(/g)?.length).toBe(1);
    expect(src).toMatch(/if \(bootPolicy\.updaterStartupCheck\) \{\s*wireUpdaterIntoIpc\(/);
    expect(src).toMatch(
      /if \(bootPolicy\.telemetryFlush\) \{\s*const telemetryStop = startTelemetryFlushScheduler\(/,
    );
    // `extensionsAutoUpdate` is one of two ANDed preconditions (not env-disabled), not a lone
    // `if (bootPolicy.X)` — pin the exact conjunction, not just presence. The daemon is built ONCE.
    expect(updater).toMatch(
      /if \(!autoUpdateDisabled && bootPolicyFor\(paths\)\.extensionsAutoUpdate\) \{/,
    );
    expect(family.match(/createAutoUpdateRuntime\(/g)?.length).toBe(1);
    expect(updater.match(/createAutoUpdateRuntime\(/g)?.length).toBe(1);
    // One air-gap switch (spec § 8.8): the daemon and the `registry.*` IPC methods share the SAME
    // registry fetch deps object, whose `enforceAirGap` is the LLM router's.
    expect(updater).toMatch(/fetch: registryFetch,/);
    expect(src).toMatch(/^\s*registryFetch,$/m);
    expect(src).toMatch(/enforceAirGap: \(\) => llmRegistry\.llmRouter\.enforcesAirGap\(\),/);
  });

  test("clause 6: a demo-rooted gateway runs no extension — the runtime predicate is false even with [extensions] runtime = true (negative control: real is true)", async () => {
    const { isExtensionRuntimeEnabled } = await import("../extensions/run-grant-env.ts");
    const real = createLinuxPaths();
    process.env["NIMBUS_DEMO"] = "1";
    const demo = createLinuxPaths();
    expect(isExtensionRuntimeEnabled({ runtime: true }, real)).toBe(true);
    expect(isExtensionRuntimeEnabled({ runtime: true }, demo)).toBe(false);
  });

  test("clause 6 wiring: assemble.ts builds the ONE extension slot source only behind the runtime predicate, and hands the IPC server the same answer", async () => {
    const src = await read("packages/gateway/src/platform/assemble.ts");
    const scheduler = await read("packages/gateway/src/platform/assemble/scheduler-mesh.ts");
    const family = Object.values(await readAssembleFamily()).join("\n");
    // Count first: a guarded construction proves nothing if a second, unguarded one sits elsewhere.
    expect(family.match(/createExtensionSlotSource\(/g)?.length).toBe(1);
    expect(scheduler).toMatch(/extensionRuntimeEnabled\s*\?\s*createExtensionSlotSource\(/);
    expect(family.match(/isExtensionRuntimeEnabled\(/g)?.length).toBe(1);
    expect(src).toMatch(
      /const extensionRuntimeEnabled = isExtensionRuntimeEnabled\(\s*\{ runtime: loadNimbusExtensionsRuntimeFromConfigDir\(paths\.configDir\) \},\s*paths,\s*\);/,
    );
    expect(src).toMatch(/extensionsRuntimeEnabled: extensionRuntimeEnabled,/);
  });

  test("clause 5/6 wiring: assemble.ts hands the IPC server `demo: paths.demo === true` in the options literal, never reassigned, before the ONE createIpcServer call", async () => {
    // `ctx.options.demo` is what BOTH the `demo.seed` claim (clause 5) and the `dispatchMethod`
    // write gate (clause 6) read; the sub-dispatcher tests above prove they honour it, and this is
    // the link that sets it from the resolved paths. Dropping the line leaves `demo` undefined —
    // every demo gateway would then answer `demo.seed` with Method not found and admit every
    // refused write, and every test that builds its own ctx would still pass.
    const src = await read("packages/gateway/src/platform/assemble.ts");
    const literalAt = src.indexOf("const ipcOpts: Parameters<typeof createIpcServer>[0] = {");
    expect(literalAt).toBeGreaterThan(-1);
    const literalEnd = src.indexOf("\n  };", literalAt);
    expect(literalEnd).toBeGreaterThan(literalAt);
    expect(src.slice(literalAt, literalEnd)).toMatch(/\n {4}demo: paths\.demo === true,\n/);
    // Exactly one `demo:` key in the whole file's IPC wiring, and no later override.
    expect(src.match(/\bdemo: paths\.demo === true\b/g)?.length).toBe(1);
    expect(src).not.toMatch(/ipcOpts\.demo\s*=/);
    expect(src).not.toMatch(/ipcOpts\s*=\s*\{/);
    // ORDER: the literal is built before the one server construction that consumes it.
    // (Code lines only: two `//` comments in the file also name `createIpcServer(`.)
    expect(src.match(/^(?![ \t]*\/\/).*\bcreateIpcServer\(/gm)?.length).toBe(1);
    const serverAt = src.indexOf("const ipc = createIpcServer(ipcOpts);");
    expect(serverAt).toBeGreaterThan(literalEnd);
  });

  test("clause 6 wiring: createEmbeddingRuntimeNonBlocking returns null on the boot policy BEFORE it builds any runtime", async () => {
    // The boot-path half of the embedding gate (`index.reembed` is the other half, pinned above).
    // Behind this check, `createDeferredEmbeddingRuntime` → `createEmbeddingRuntime` would load or
    // download the local MiniLM model on a demo gateway.
    const src = await read("packages/gateway/src/embedding/create-embedding-runtime.ts");
    expect(src).toMatch(/import \{ bootPolicyFor \} from "\.\.\/platform\/demo-boot\.ts";/);
    const fnAt = src.indexOf("export function createEmbeddingRuntimeNonBlocking(");
    expect(fnAt).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n}\n", fnAt);
    expect(fnEnd).toBeGreaterThan(fnAt);
    const body = src.slice(fnAt, fnEnd);
    // The FIRST statement of the body is the guard, on the function's own `paths` parameter, and
    // it returns — not logs, not falls through.
    expect(body).toMatch(
      /\): EmbeddingRuntime \| null \{\s*if \(!bootPolicyFor\(paths\)\.embeddingRuntime\) \{\s*return null;\s*\}/,
    );
    // ORDER: the guard precedes every runtime construction in the body.
    const guardAt = body.indexOf("if (!bootPolicyFor(paths).embeddingRuntime)");
    for (const construction of ["createDeferredEmbeddingRuntime(", "createEmbeddingRuntime(db"]) {
      const at = body.indexOf(construction);
      expect(at).toBeGreaterThan(guardAt);
    }
  });
});
