// `nimbus tool run` (`toolgen.invoke`) end-to-end: a REAL gateway subprocess driven over IPC.
//
// This does NOT exist to catch a routing gap -- `dispatchers.ts`'s outer router prefix-matches
// `toolgen.` wholesale (`method.startsWith("toolgen.")`), so the "handler present, routing entry
// missing" defect `explain-last.e2e.test.ts` guards against cannot occur for this namespace. What
// nothing below this layer exercises is CLI-shaped-request -> real IPC socket -> the real
// `invokeSavedTool` gate -> a real confined spawn -> the real result crossing back, all through
// production wiring (`platform/assemble.ts`'s `toolgenInvokeDeps`), not an injected `spawn` closure
// the way both `toolgen-invoke-gate.test.ts` and the sibling integration test use.
//
// A saved tool is only ever loaded into a gateway's registry at BOOT (`loadSavedToolsIntoRegistry`,
// called once from `platform/assemble.ts`) -- saving a tool in a live session does not make it
// invocable in that same process (`registerSaved` has exactly one production caller, and it is not
// `saveGeneratedTool`). So a fixture tool cannot be created+saved over this file's own IPC
// connection and then invoked over it; it has to exist on disk (and in `generated_tool`) BEFORE the
// gateway subprocess this file drives is started -- exactly as it would after a real restart. The
// fixture-creation half below is therefore in-process setup (closely modelled on
// `test/integration/toolgen/toolgen-saved-spawn.test.ts`'s "gateway A"), never the code under test;
// the code under test is only what happens after the real subprocess boots and `toolgen.invoke`
// crosses its real socket.
//
// The fixture tool's body deliberately never calls `nimbusFetch`: the production `ToolgenBroker`
// wired in `platform/assemble.ts` performs REAL DNS resolution and a REAL `fetch()` with no test
// hook (`toolgen-network-denied.test.ts` and the sibling integration suite reach the broker
// in-process specifically to substitute a stub server, which is not available to a real subprocess
// here). A tool whose body only computes over its own input never reaches the broker at all, so
// this file makes no outbound network request and needs none.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_NIMBUS_TOOL_GENERATION_TOML } from "../../src/config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../src/index/migrations/runner.ts";
import { createSandboxRunner } from "../../src/platform/sandbox/sandbox-runner.ts";
import { ToolgenBroker } from "../../src/toolgen/toolgen-broker.ts";
import {
  buildToolSpawnSpec,
  type GeneratedToolHandle,
  ioFromSpawnedChild,
  wireExitCallback,
  wireToolProtocol,
} from "../../src/toolgen/toolgen-client.ts";
import { assertToolConfinement } from "../../src/toolgen/toolgen-confinement.ts";
import { createDraftToolClosure, type DraftGeneration } from "../../src/toolgen/toolgen-draft.ts";
import { createGeneratedTool, type ToolgenGateDeps } from "../../src/toolgen/toolgen-gate.ts";
import {
  TOOLGEN_SIGNING_PRIVKEY,
  TOOLGEN_SIGNING_PUBKEY,
} from "../../src/toolgen/toolgen-keypair.ts";
import { ToolgenRegistry } from "../../src/toolgen/toolgen-registry.ts";
import { saveGeneratedTool, type ToolgenSaveDeps } from "../../src/toolgen/toolgen-save-gate.ts";
import { toolScriptDir, writeToolScript } from "../../src/toolgen/toolgen-script-store.ts";
import type { CreateGeneratedToolRequest } from "../../src/toolgen/toolgen-types.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const IS_CI = process.env["CI"] === "true";

// Same override, same reason, as `toolgen-saved-spawn.test.ts` / `exec-e2e.test.ts`: under
// `bun test`, `process.execPath` is the installed `~/.bun/bin/bun.exe`, not this repo's own
// `src-native` build, and the sandbox runner probes at construction -- so this must be set before
// the first `createSandboxRunner()` call, which the fixture setup below makes. This covers the
// FIXTURE's own `spawnConfined` (a test-authored reimplementation of `spawnGeneratedTool`, like
// every other toolgen test that spawns anything).
const WIN_BUILT_HELPER = join(
  import.meta.dir,
  "../../src-native/sandbox-helper-win32/nimbus-sandbox-helper.exe",
);
if (process.platform === "win32" && process.env["NIMBUS_SANDBOX_HELPER_PATH"] === undefined) {
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] = WIN_BUILT_HELPER;
}

/**
 * This file's happy-path test is the FIRST in this repository to exercise the REAL, unmodified
 * `spawnGeneratedTool` (`toolgen-client.ts`) inside a REAL gateway subprocess -- not a
 * `spawnConfined` reimplementation. That path launches the confining child through
 * `wrapServerSpec`'s `__nimbus-sandbox` re-exec role (`sandbox-wrapper.ts`), whose env is built by
 * `extensionProcessEnv` (I1) -- which deliberately does NOT forward `NIMBUS_SANDBOX_HELPER_PATH`
 * (every other toolgen test avoids the real spawn path for exactly this reason; their docstrings
 * say so directly). So the re-exec'd wrapper process falls back to `defaultHelperPath()`
 * (`join(dirname(process.execPath), "nimbus-sandbox-helper.exe")`) with no way for an env override
 * to reach it -- the env var above helps the FIXTURE's own spawn, never this one. The only correct
 * fix is the one a real installed Nimbus relies on too: the helper physically present next to the
 * running executable.
 *
 * `process.execPath` is the SAME `bun.exe` for the outer test process, the gateway subprocess, and
 * its re-exec'd wrapper (`bun test`'s only entry point), so copying the already-CI-built
 * `src-native` binary there, temporarily, satisfies the DEFAULT resolution for all three without
 * touching `extensionProcessEnv`'s scoping at all. **This is deliberately NOT a module-scope side
 * effect**: `dirname(process.execPath)` is shared, real, global filesystem state (this developer's
 * `~/.bun/bin`, or CI's runner-wide Bun install), not this file's own sandbox -- leaving a stray
 * copy there for the whole `bun test` run once broke `platform/sandbox/win32.test.ts`, which
 * asserts that exact path is empty by default (its own docstring even names the shared-process
 * risk, for the ENV var; this is the filesystem-state version of the same trap). So the copy is
 * scoped to the one test that needs it, installed just before the gateway boots and removed in that
 * test's own `finally`, restoring whatever was there before (nothing, on a machine with no other
 * Nimbus install) the moment this test is done -- never for the life of the whole file.
 */
function installDefaultHelperForThisTest(): { readonly restore: () => void } {
  if (process.platform !== "win32") return { restore: () => {} };
  const defaultHelper = join(dirname(process.execPath), "nimbus-sandbox-helper.exe");
  if (existsSync(defaultHelper) || !existsSync(WIN_BUILT_HELPER)) {
    // Already present (another install, or a previous run that failed to clean up) or nothing to
    // copy -- either way this test did not create it, so it must not delete it either.
    return { restore: () => {} };
  }
  copyFileSync(WIN_BUILT_HELPER, defaultHelper);
  return {
    restore: () => {
      try {
        rmSync(defaultHelper, { force: true });
      } catch {
        /* best-effort -- a locked/missing file here must not mask the test's real outcome */
      }
    },
  };
}

const sandboxAvailable = await (async () => {
  try {
    const runner = await createSandboxRunner();
    return (
      runner.canConfine({
        id: "tool-run-e2e-probe",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      }) === null
    );
  } catch {
    return false;
  }
})();

/**
 * One loud, named failure when CI cannot confine, matching `exec-e2e.test.ts`'s identical
 * precondition guard -- a skip and a pass read the same in a CI summary, and this makes the
 * difference visible instead.
 */
describe.skipIf(sandboxAvailable || !IS_CI)("nimbus tool run e2e — CI sandbox precondition", () => {
  test("fails loudly instead of silently skipping the spawn-dependent case", () => {
    expect(
      "tool-run-e2e: CI precondition unmet -- the platform sandbox cannot confine a no-network " +
        "policy, so no fixture tool can be created and no saved tool can be spawned. Install this " +
        "platform's sandbox dependency (scripts/linux/install-sandbox-deps.sh on Linux) and re-run.",
    ).toBeNull();
  });
});

function pipeOrSocket(dir: string, tag: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\nimbus-toolrun-${tag}-${process.pid}-${randomUUID().slice(0, 8)}`
    : join(dir, `gw-${tag}.sock`);
}

async function until(probe: () => boolean, what: string, ms: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (probe()) return;
    if (Date.now() - start > ms) {
      throw new Error(`timed out waiting for ${what} after ${String(ms)}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

type RpcReply = { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };

/** Minimal request/response JSON-RPC client, matching `explain-last.e2e.test.ts`'s `TinyIpcClient` —
 * `toolgen.invoke` is a plain call/reply method, no notification routing needed. */
class TinyIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: RpcReply) => void>();

  connect(socketPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
      sock.on("error", (e) => reject(e));
      sock.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let idx = this.buffer.indexOf("\n");
        while (idx !== -1) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line !== "") this.onLine(line);
          idx = this.buffer.indexOf("\n");
        }
      });
      this.sock = sock;
    });
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") return;
    const cb = this.pending.get(id);
    if (cb === undefined) return;
    this.pending.delete(id);
    cb(msg as RpcReply);
  }

  raw(method: string, params: unknown): Promise<RpcReply> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const reply = await this.raw(method, params);
    if (reply.error !== undefined) {
      throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
    }
    return reply.result as T;
  }

  disconnect(): void {
    this.sock?.destroy();
  }
}

async function startTestGateway(
  tag: string,
  configDir: string,
  dataDir: string,
  vaultSeeds: Record<string, string>,
): Promise<{ socketPath: string; log: () => string; stop: () => Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), `nimbus-toolrun-e2e-${tag}-`));
  const paths = {
    configDir,
    dataDir,
    logDir: join(tmp, "logs"),
    socketPath: pipeOrSocket(tmp, tag),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
  };
  mkdirSync(paths.logDir, { recursive: true });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
    NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
    NIMBUS_E2E_SEED_VAULT_JSON: JSON.stringify(vaultSeeds),
  };

  const proc = Bun.spawn(["bun", RUNNER], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
  let log = "";
  const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) log += decoder.decode(chunk);
  };
  void collect(proc.stdout as ReadableStream<Uint8Array>);
  void collect(proc.stderr as ReadableStream<Uint8Array>);

  try {
    await until(() => log.includes("[gateway] ready (e2e)"), `${tag} gateway bind`, 60_000);
  } catch (e) {
    proc.kill();
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(
      `${e instanceof Error ? e.message : String(e)}\n--- gateway output ---\n${log.slice(-4000)}`,
    );
  }

  let stopped = false;
  return {
    socketPath: paths.socketPath,
    log: () => log,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      proc.kill();
      try {
        await proc.exited;
      } catch {
        /* best-effort */
      }
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

// ---- Fixture construction ("gateway A"): in-process, never the code under test. See the
// file-level docstring for why this cannot be replaced by driving `toolgen.create`/`toolgen.save`
// over this file's own gateway connection. ----

function makeSharedVault(store: Map<string, string>): NimbusVault {
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    listKeys: async (prefix?: string) => {
      const keys = [...store.keys()];
      return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    },
  };
}

/** A drafted body that only computes over its own input -- see the file-level docstring on why
 * this fixture's tool deliberately never calls `nimbusFetch`. */
const fakeGenerate = async (_prompt: string): Promise<DraftGeneration | null> => ({
  text: JSON.stringify({
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
    // The generated wrapper's parameter is named `args` (`toolgen-stub.ts`'s `emitToolScript`:
    // `async function __invoke(args) { ...body... }`), never `input`.
    body: "return { ok: true, sum: Number(args.a) + Number(args.b) };",
  }),
  isLocal: true,
});

interface FixtureTool {
  readonly configDir: string;
  readonly dbPath: string;
  readonly toolId: string;
  readonly vaultSeeds: Record<string, string>;
}

/**
 * Creates and saves ONE real, signed, verified saved tool on disk, entirely in-process --
 * `createGeneratedTool` (with a real confined ephemeral spawn) followed by `saveGeneratedTool`
 * (a real Ed25519 signature over the canonical artifact). Requires the sandbox: the ephemeral
 * create-time spawn is a real confined subprocess, exactly as in production.
 */
async function buildSavedToolFixture(): Promise<FixtureTool> {
  const configDir = mkdtempSync(join(tmpdir(), "nimbus-toolrun-e2e-fixture-"));
  const dbPath = join(configDir, "nimbus.db");
  const vaultStore = new Map<string, string>();
  const vault = makeSharedVault(vaultStore);
  const db = new Database(dbPath);
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const registry = new ToolgenRegistry();
  const sandboxRunner = await createSandboxRunner();
  // Never actually dialed -- the fixture tool's body never calls `nimbusFetch` (file docstring).
  const broker = new ToolgenBroker({
    db,
    now: () => Date.now(),
    maxRequestsPerTool: DEFAULT_NIMBUS_TOOL_GENERATION_TOML.maxRequestsPerTool,
    requestTimeoutMs: DEFAULT_NIMBUS_TOOL_GENERATION_TOML.requestTimeoutMs,
    resolveHost: async () => [],
    readCredential: async () => null,
    approvedHostsFor: (toolId) => registry.findArtifact(toolId)?.approvedHosts ?? [],
    credentialHostsFor: (toolId) => registry.findArtifact(toolId)?.credentialHosts ?? [],
    doFetch: async () => {
      throw new Error("tool-run e2e fixture: the fixture tool's body never calls nimbusFetch");
    },
  });

  let handle: GeneratedToolHandle | undefined;
  try {
    const draftTool = createDraftToolClosure({
      generate: fakeGenerate,
      hasDraftRoute: async () => true,
      findEndpoints: async () => [],
    });
    const gateDeps: ToolgenGateDeps = {
      db,
      config: { ...DEFAULT_NIMBUS_TOOL_GENERATION_TOML, enabled: true },
      enforced: { capabilitiesDisabled: new Set<string>() },
      registry,
      draftTool,
      assertConfinement: (manifest) =>
        assertToolConfinement({ runner: sandboxRunner, manifest, cwd: configDir }),
      scriptDir: (toolId) => toolScriptDir(configDir, toolId),
      writeScript: (toolId, source) => writeToolScript(configDir, toolId, source),
      spawn: async (envelope) => {
        const spec = buildToolSpawnSpec(envelope, dirname(envelope.scriptPath));
        const env = { ...spec.env };
        if (process.env["NIMBUS_SANDBOX_HELPER_PATH"] !== undefined) {
          env["NIMBUS_SANDBOX_HELPER_PATH"] = process.env["NIMBUS_SANDBOX_HELPER_PATH"];
        }
        const child = Bun.spawn<"pipe", "pipe", "inherit">([spec.command, ...spec.args], {
          env,
          cwd: dirname(envelope.scriptPath),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "inherit",
        });
        const io = ioFromSpawnedChild(child);
        wireExitCallback(io, () => registry.markTerminated(envelope.artifact.toolId));
        const h = await wireToolProtocol(io, envelope, broker);
        handle = h;
        return h;
      },
      requestApproval: async () => true,
      bindCredentials: async () => [],
      revokeCredentials: async () => {},
      now: () => Date.now(),
      newId: () => randomUUID(),
    };

    const req: CreateGeneratedToolRequest = {
      sessionId: "fixture-session",
      description: "add two numbers",
      hosts: ["api.example.com"],
    };
    const createOutcome = await createGeneratedTool(req, gateDeps);
    if (createOutcome.status !== "registered") {
      throw new Error(`expected "registered", got ${JSON.stringify(createOutcome)}`);
    }
    const { toolId } = createOutcome;

    const saveDeps: ToolgenSaveDeps = {
      db,
      configDir,
      config: { enabled: true },
      enforced: { capabilitiesDisabled: new Set<string>() },
      registry,
      vault,
      requestApproval: async () => true,
      now: () => Date.now(),
    };
    const saveOutcome = await saveGeneratedTool({ toolId }, saveDeps);
    if (saveOutcome.status !== "saved") {
      throw new Error(`expected "saved", got ${JSON.stringify(saveOutcome)}`);
    }

    const pub = vaultStore.get(TOOLGEN_SIGNING_PUBKEY);
    const priv = vaultStore.get(TOOLGEN_SIGNING_PRIVKEY);
    if (pub === undefined || priv === undefined) {
      throw new Error("fixture: signing keypair missing from vault store after save");
    }

    return {
      configDir,
      dbPath,
      toolId,
      vaultSeeds: { [TOOLGEN_SIGNING_PUBKEY]: pub, [TOOLGEN_SIGNING_PRIVKEY]: priv },
    };
  } finally {
    await handle?.close();
    await registry.revokeAll();
    db.close();
  }
}

describe("toolgen.invoke over a real socket, no saved tool present", () => {
  test("an unknown/unsaved tool id is REFUSED with ERR_TOOLGEN_NOT_SAVED, before any spawn", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "nimbus-toolrun-e2e-empty-config-"));
    const dataDir = mkdtempSync(join(tmpdir(), "nimbus-toolrun-e2e-empty-data-"));
    writeFileSync(join(configDir, "nimbus.toml"), "[tool_generation]\nenabled = true\n");

    const gw = await startTestGateway("empty", configDir, dataDir, {});
    const client = new TinyIpcClient();
    try {
      await client.connect(gw.socketPath);
      const out = await client.call<Record<string, unknown>>("toolgen.invoke", {
        toolId: "never-existed",
        input: {},
      });
      expect(out).toEqual({
        status: "refused",
        toolId: "never-existed",
        code: "ERR_TOOLGEN_NOT_SAVED",
      });
    } finally {
      client.disconnect();
      await gw.stop();
      rmSync(configDir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("toolgen.invoke spawns and answers over a real socket", () => {
  test.skipIf(!sandboxAvailable)(
    "a saved tool created+saved before boot executes end to end through CLI -> IPC -> gate -> spawn",
    async () => {
      const fixture = await buildSavedToolFixture();
      const dataDir = mkdtempSync(join(tmpdir(), "nimbus-toolrun-e2e-data-"));
      mkdirSync(dataDir, { recursive: true });
      // The exact bytes gateway A wrote -- a real restart shares the database file, not an
      // in-process object, and this is that same sharing over an actual filesystem copy.
      copyFileSync(fixture.dbPath, join(dataDir, "nimbus.db"));
      for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(`${fixture.dbPath}${suffix}`)) {
          copyFileSync(`${fixture.dbPath}${suffix}`, join(dataDir, `nimbus.db${suffix}`));
        }
      }
      writeFileSync(join(fixture.configDir, "nimbus.toml"), "[tool_generation]\nenabled = true\n");

      // Only the REAL gateway subprocess's internal `spawnGeneratedTool` (via its `__nimbus-sandbox`
      // re-exec wrapper) needs this -- the fixture's own `spawn` closure above already forwards the
      // env override into a test-authored `Bun.spawn` call the way every other toolgen test does.
      // See `installDefaultHelperForThisTest`'s docstring for why this is installed and removed
      // right here rather than at module scope.
      const helper = installDefaultHelperForThisTest();
      let gw: Awaited<ReturnType<typeof startTestGateway>> | undefined;
      const client = new TinyIpcClient();
      try {
        gw = await startTestGateway("saved", fixture.configDir, dataDir, fixture.vaultSeeds);
        await client.connect(gw.socketPath);
        const out = await client.call<Record<string, unknown>>("toolgen.invoke", {
          toolId: fixture.toolId,
          input: { a: 2, b: 3 },
        });
        // A failure here is almost always in the spawned child, not this test -- surface the
        // gateway's own stdout/stderr (which includes the child's `stderr: "inherit"` output) so a
        // future regression does not need a second, manual run to diagnose.
        if (out["status"] !== "executed") {
          throw new Error(
            `toolgen.invoke did not execute: ${JSON.stringify(out)}\n--- gateway output ---\n${gw.log().slice(-6000)}`,
          );
        }
        expect(out["status"]).toBe("executed");
        expect(out["toolId"]).toBe(fixture.toolId);
        expect(out["result"]).toEqual({ ok: true, sum: 5 });
        expect(typeof out["durationMs"]).toBe("number");
      } finally {
        // Restored FIRST, before anything else in this block can throw and skip it -- shared
        // global filesystem state must not outlive this test under any exit path, including a
        // `startTestGateway` failure that never produced a `gw` to stop.
        helper.restore();
        client.disconnect();
        await gw?.stop();
        rmSync(fixture.configDir, { recursive: true, force: true });
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
