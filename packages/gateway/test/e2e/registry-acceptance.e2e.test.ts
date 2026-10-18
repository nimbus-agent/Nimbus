// The extension-registry dogfood scenario (spec § 11) end to end, against a REAL gateway
// subprocess over a REAL socket / named pipe: a signed local registry folder is added behind the
// owner's `registry.add` approval, searched, installed from (`extension.install` approval), the
// extension approved to run (`extension.run` approval); a v2 published to the folder is detected
// by the update daemon from the extension's source registry and applied (`extension.autoUpdate`
// approval), after which the old run approval no longer covers the code; and a v3 whose package
// differs by one byte from what the signed index lists is detected but refused at apply, leaving
// v2 in place. Invariant I44 is the property; the unit and integration layers prove each refusal,
// and this file proves the whole chain is wired through both dispatcher layers of a real gateway.
//
// The registry folder is built by the gateway-side fixture (`build-test-registry.ts`): the gateway
// test tree may not import CLI source, and the CLI's maintainer output is pinned to the gateway
// verifier separately (`__fixtures__/maintained-registry`). Every consent prompt is answered over
// the socket, as the owner would at a TTY. A local registry makes no network request, so the
// scenario appends no `registry` egress row, which is asserted too.
//
// The publisher id is unique per run: a registry install caches the publisher key in the Vault,
// and on macOS/Linux that is the machine-global keychain, so a fixed id could collide with
// another run's key. The cached key is evicted afterwards.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); nothing here needs the index.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evictPublisherKey } from "../../src/extensions/publisher-keys.ts";
import {
  buildTestRegistry,
  resignIndex,
} from "../../src/extensions/registry/__fixtures__/build-test-registry.ts";
import type { PlatformPaths } from "../../src/platform/paths.ts";
import { createNimbusVault } from "../../src/vault/factory.ts";

// --- TestIpcClient + until, as in extension-runtime.e2e.test.ts ---

type NotificationHandler = (params: Record<string, unknown>) => void;

class TestIpcClient {
  private sock: net.Socket | undefined;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: unknown }) => void>();
  private readonly notifyHandlers = new Map<string, NotificationHandler>();

  private failAllPending(reason: string): void {
    for (const [, cb] of this.pending) cb({ error: { message: reason } });
    this.pending.clear();
  }

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection(socketPath);
      sock.on("connect", () => resolve());
      sock.on("error", (e) => {
        reject(e);
        this.failAllPending(`socket error: ${e.message}`);
      });
      sock.on("close", () => this.failAllPending("socket closed"));
      sock.on("data", (chunk) => {
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

  onNotification(method: string, handler: NotificationHandler): void {
    this.notifyHandlers.set(method, handler);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg["id"];
    if (typeof id !== "number") {
      const method = msg["method"];
      if (typeof method === "string") {
        const handler = this.notifyHandlers.get(method);
        if (handler !== undefined) {
          handler((msg["params"] as Record<string, unknown> | undefined) ?? {});
        }
      }
      return;
    }
    const cb = this.pending.get(id);
    if (cb === undefined) return;
    this.pending.delete(id);
    cb(msg as { result?: unknown; error?: unknown });
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (msg) => {
        if (msg.error !== undefined) {
          reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
          return;
        }
        resolve(msg.result as T);
      });
      this.sock?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  clearNotificationHandlers(): void {
    this.notifyHandlers.clear();
  }

  close(): void {
    this.sock?.destroy();
  }
}

async function until<T>(probe: () => T | undefined, what: string, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

// --- end copied section ---

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const EXTENSION_ID = "com.example.accept";
const REGISTRY = "local";

type ExtensionListing = {
  id: string;
  version: string;
  runState: string;
  source_registry: string | null;
  source_channel: string | null;
};

type AvailableUpdate = {
  id: string;
  fromVersion: string;
  toVersion: string;
  sourceRegistry: string;
  verificationStatus: string;
};

type UpdateResult = { applied: boolean; reason?: string };

describe("registry acceptance: add, search, install, approve, update, tamper", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-regacc-e2e-"));
  const regDir = join(tmp, "registry");
  const publisherId = `e2e-acc-${randomUUID().slice(0, 8)}`;
  const paths: PlatformPaths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\nimbus-regacc-${process.pid}-${randomUUID().slice(0, 8)}`
        : join(tmp, "gw.sock"),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
    sandboxDir: join(tmp, "sandbox"),
  };
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";
  const client = new TestIpcClient();
  /** The action type of every consent prompt the gateway raised, in order (all approved). */
  const prompts: string[] = [];

  /** Rebuilds the folder with `versions`, re-signed at `sequence` (never below the last one seen). */
  async function publish(versions: string[], sequence: number): Promise<void> {
    await buildTestRegistry(regDir, {
      id: EXTENSION_ID,
      publisherId,
      versions: versions.map((version) => ({ version })),
    });
    const indexPath = join(regDir, "index.json");
    resignIndex(indexPath, {
      ...(JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>),
      sequence,
    });
  }

  async function listing(): Promise<ExtensionListing | undefined> {
    const out = await client.call<{ extensions: ExtensionListing[] }>("extension.list", {});
    return out.extensions.find((e) => e.id === EXTENSION_ID);
  }

  async function checkForUpdates(): Promise<AvailableUpdate[]> {
    return client.call<AvailableUpdate[]>("extension.checkForUpdates", { force: true });
  }

  function installedEntry(): string {
    return readFileSync(join(paths.extensionsDir, EXTENSION_ID, "dist", "index.js"), "utf8");
  }

  /** Runs `fn` and returns the action types of the prompts it raised. */
  async function promptsDuring(fn: () => Promise<unknown>): Promise<string[]> {
    const before = prompts.length;
    await fn();
    return prompts.slice(before);
  }

  beforeAll(async () => {
    await publish(["1.0.0"], 1);
    for (const d of [paths.configDir, paths.dataDir]) mkdirSync(d, { recursive: true });
    proc = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
        NIMBUS_NOTIFICATIONS: "off",
      },
    });
    const collect = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) gatewayLog += decoder.decode(chunk);
    };
    void collect(proc.stderr as ReadableStream<Uint8Array>);
    void collect(proc.stdout as ReadableStream<Uint8Array>);
    try {
      await until(
        () => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined),
        "gateway bind",
        60_000,
      );
    } catch (e) {
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n--- gateway output (tail) ---\n${gatewayLog.slice(-6000)}`,
      );
    }
    await client.connect(paths.socketPath);
    client.onNotification("consent.request", (params) => {
      // The prompt text names the action type (`Type: <type>`), which is what each step checks.
      const type = /^Type: (\S+)$/m.exec(String(params["prompt"] ?? ""))?.[1] ?? "unknown";
      prompts.push(type);
      // A socket closed by teardown rejects the reply; that must not surface as an unhandled rejection.
      void client
        .call("consent.respond", { requestId: params["requestId"], approved: true })
        .catch(() => {});
    });
  }, 180_000);

  afterAll(async () => {
    client.clearNotificationHandlers();
    client.close();
    proc?.kill();
    await proc?.exited.catch(() => {});
    try {
      // The install cached this run's publisher key; on macOS/Linux that is the real keychain.
      await evictPublisherKey(await createNimbusVault(paths), publisherId);
    } catch {
      /* best-effort -- the key is unique to this run and harmless if left */
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("registry.add pins the folder's root key behind the owner's approval", async () => {
    let added: { name: string; rootFingerprint: string; extensionCount: number } | undefined;
    const raised = await promptsDuring(async () => {
      added = await client.call("registry.add", { name: REGISTRY, url: regDir });
    });
    expect(raised).toEqual(["registry.add"]);
    expect(added?.name).toBe(REGISTRY);
    expect(added?.rootFingerprint).toMatch(/^[0-9a-f]{32}$/);
    expect(added?.extensionCount).toBe(1);
    const list = await client.call<{ registries: Array<{ name: string; stale: boolean }> }>(
      "registry.list",
      {},
    );
    expect(list.registries.map((r) => r.name)).toEqual([REGISTRY]);
  }, 60_000);

  test("registry.search finds the extension, tagged with its registry", async () => {
    const out = await client.call<{
      results: Array<{ registry: string; id: string; latestStable: string | null }>;
      errors: unknown[];
    }>("registry.search", { query: "accept" });
    expect(out.errors).toEqual([]);
    expect(out.results).toEqual([
      expect.objectContaining({ registry: REGISTRY, id: EXTENSION_ID, latestStable: "1.0.0" }),
    ]);
  }, 60_000);

  test("registry.install installs 1.0.0 behind the owner's approval and records the source", async () => {
    let installed: { version: string; sourceRegistry: string } | undefined;
    const raised = await promptsDuring(async () => {
      installed = await client.call("registry.install", { id: EXTENSION_ID });
    });
    expect(raised).toEqual(["extension.install"]);
    expect(installed).toMatchObject({ version: "1.0.0", sourceRegistry: REGISTRY });
    expect(installedEntry()).toContain('"1.0.0"');
    expect(await listing()).toMatchObject({
      version: "1.0.0",
      source_registry: REGISTRY,
      source_channel: "stable",
      runState: "no_grant",
    });
  }, 60_000);

  test("extension.approveRun lets it run (behind the owner's approval)", async () => {
    const raised = await promptsDuring(() =>
      client.call("extension.approveRun", { id: EXTENSION_ID }),
    );
    expect(raised).toEqual(["extension.run"]);
    expect((await listing())?.runState).toBe("ready");
  }, 60_000);

  test("a v2 published to the folder is detected from the source registry", async () => {
    await publish(["1.0.0", "2.0.0"], 2);
    const updates = await checkForUpdates();
    expect(updates).toEqual([
      expect.objectContaining({
        id: EXTENSION_ID,
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        sourceRegistry: REGISTRY,
        verificationStatus: "verified",
      }),
    ]);
  }, 60_000);

  test("extension.update applies v2 behind the owner's approval; the old run approval no longer covers it", async () => {
    let result: UpdateResult | undefined;
    const raised = await promptsDuring(async () => {
      result = await client.call<UpdateResult>("extension.update", {
        id: EXTENSION_ID,
        toVersion: "2.0.0",
      });
    });
    expect(raised).toEqual(["extension.autoUpdate"]);
    expect(result?.applied).toBe(true);
    expect(installedEntry()).toContain('"2.0.0"');
    const after = await listing();
    expect(after?.version).toBe("2.0.0");
    // The grant names 1.0.0 and its tree digest: the extension does not run until re-approved.
    expect(after?.runState).toBe("grant_stale");
  }, 60_000);

  test("a v3 whose package differs by one byte from the signed index is refused at apply; v2 stays", async () => {
    await publish(["1.0.0", "2.0.0", "3.0.0"], 3);
    const pkg = join(regDir, "extensions", EXTENSION_ID, "3.0.0", "package.tgz");
    const bytes = new Uint8Array(readFileSync(pkg));
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    writeFileSync(pkg, bytes);
    // Detection reads only the index and the manifest, both untouched, so v3 IS offered…
    const updates = await checkForUpdates();
    expect(updates).toEqual([
      expect.objectContaining({ id: EXTENSION_ID, toVersion: "3.0.0", sourceRegistry: REGISTRY }),
    ]);
    // …and applying it fetches the package, whose sha differs from the signed one: refused.
    const result = await client.call<UpdateResult>("extension.update", {
      id: EXTENSION_ID,
      toVersion: "3.0.0",
    });
    expect(result).toMatchObject({ applied: false, reason: "internal_error" });
    // The audit row names the phase: the package hash, not some unrelated failure.
    const audit = await client.call<Array<{ actionType: string; actionJson: string }>>(
      "audit.list",
      { limit: 50 },
    );
    const failed = audit.find((a) => a.actionType === "extension.autoUpdate.failed");
    expect(JSON.parse(failed?.actionJson ?? "{}")).toMatchObject({
      id: EXTENSION_ID,
      toVersion: "3.0.0",
      phase: "sha256_mismatch",
    });
    expect((await listing())?.version).toBe("2.0.0");
    expect(installedEntry()).toContain('"2.0.0"');
  }, 60_000);

  test("a local registry made no outbound request: no registry egress row was appended", async () => {
    const out = await client.call<{ rows: Array<{ sourceType: string; method: string }> }>(
      "egress.list",
      { limit: 10_000 },
    );
    // Non-vacuous: the ledger is live (the boot marker is a row), it just holds no registry row.
    expect(out.rows.some((r) => r.method === "egress.boot")).toBe(true);
    expect(out.rows.filter((r) => r.sourceType === "registry")).toEqual([]);
  }, 60_000);
});
