// Local-auth detect/adopt (S? local-auth-reuse slice) end-to-end: a REAL gateway subprocess
// driven over IPC.
//
// Every other test for this feature calls `dispatchConnectorRpc` directly, so all of them would
// still pass with the outer routing unwired — the "both ends tested, dead feature" shape this
// repo has shipped before (see `explain-last.e2e.test.ts`, `exec-e2e.test.ts`). Here the two new
// methods are driven over a REAL socket (a named pipe on Windows): `connector.detectLocalAuth`
// and `connector.adoptLocalAuth` must be routed by `tryDispatchConnectorRpc`
// (`ipc/server/dispatchers.ts`), the HITL consent round-trip must genuinely cross the wire, and
// the gate must run BEFORE any spawn or Vault write.
//
// No real network call: gh's adoption path here is DENIED, so `gh auth token` is never spawned
// and no credential probe reaches api.github.com. The gh-APPROVE path (which would probe GitHub)
// is already covered by unit tests with an injected probe. `aws` probes nothing either way.
// `gcloud` probes nothing either way either — `connectorAuthGcp`'s gcloud arm only writes Vault
// keys and registers the sync schedule (see its own doc comment in `ipc/connector-rpc-handlers/
// auth.ts`), so its APPROVE path here needs no injected probe to stay network-free.
//
// Embeddings are skipped (NIMBUS_SKIP_EMBEDDING_RUNTIME=1); nothing here needs the index.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { createNimbusVault } from "../../src/vault/factory.ts";

// --- TestIpcClient + until copied verbatim from exec-e2e.test.ts ---

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
const SHIM = join(import.meta.dir, "_fixtures", "local-auth-shim.ts");

/**
 * The CLI child processes (`gh`/`aws`/`kubectl`) spawn through `extensionProcessEnv()` (I1),
 * which scopes the child env down to a fixed baseline (`PATH`, `HOME`, `TEMP`, …) plus whatever
 * `cliEnvFor` explicitly forwards — `NIMBUS_SHIM_LOG` is neither, so setting it on the GATEWAY's
 * own spawn env never reaches these shims. Each wrapper bakes the log path into its own script
 * text instead and sets it locally before invoking `bun`, which is unaffected by I1 (that scoping
 * governs only what the gateway passes when spawning the wrapper, not what the wrapper's own
 * script subsequently sets for its child).
 */
function writeShims(binDir: string, shimLog: string): void {
  for (const name of ["gh", "aws", "kubectl", "gcloud"]) {
    if (process.platform === "win32") {
      writeFileSync(
        join(binDir, `${name}.cmd`),
        `@echo off\r\nset "NIMBUS_SHIM_LOG=${shimLog}"\r\nbun "${SHIM}" ${name} %*\r\n`,
      );
    } else {
      const p = join(binDir, name);
      writeFileSync(
        p,
        `#!/bin/sh\nexport NIMBUS_SHIM_LOG="${shimLog}"\nexec bun "${SHIM}" ${name} "$@"\n`,
      );
      chmodSync(p, 0o755);
    }
  }
}

describe("local auth over a real gateway", () => {
  const tmp = mkdtempSync(join(tmpdir(), "nimbus-localauth-e2e-"));
  const binDir = join(tmp, "bin");
  const shimLog = join(tmp, "shim.log");
  const paths = {
    configDir: join(tmp, "config"),
    dataDir: join(tmp, "data"),
    logDir: join(tmp, "logs"),
    socketPath:
      process.platform === "win32"
        ? `\\\\.\\pipe\\nimbus-localauth-${process.pid}-${randomUUID().slice(0, 8)}`
        : join(tmp, "gw.sock"),
    extensionsDir: join(tmp, "extensions"),
    tempDir: join(tmp, "tmp"),
  };
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let gatewayLog = "";
  const client = new TestIpcClient();

  beforeAll(async () => {
    for (const d of [binDir, paths.configDir, paths.dataDir, join(tmp, "gh"), join(tmp, "kube")]) {
      mkdirSync(d, { recursive: true });
    }
    writeShims(binDir, shimLog);
    writeFileSync(
      join(tmp, "gh", "hosts.yml"),
      "github.com:\n    users:\n        octocat:\n    user: octocat\n",
    );
    writeFileSync(join(tmp, "kube", "config"), "apiVersion: v1\nkind: Config\n");
    proc = Bun.spawn(["bun", RUNNER], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...(process.env as Record<string, string>),
        PATH: `${binDir}${delimiter}${process.env["PATH"] ?? ""}`,
        GH_CONFIG_DIR: join(tmp, "gh"),
        KUBECONFIG: join(tmp, "kube", "config"),
        NIMBUS_E2E_PATHS_JSON: JSON.stringify(paths),
        NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
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
  }, 90_000);

  afterAll(async () => {
    client.close();
    proc?.kill();
    await proc?.exited.catch(() => {});
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("detect lists every source through the real routing", async () => {
    const findings = await client.call<Array<{ source: string; status: string }>>(
      "connector.detectLocalAuth",
      {},
    );
    // The gcloud shim reports an active account with no default project, so `detectGcloud`
    // returns `needs_project` — a real `gcloud config list --format json` round-trip through
    // the real routing, not a stub.
    expect(findings.map((f) => [f.source, f.status])).toEqual([
      ["gh", "available"],
      ["aws", "available"],
      ["kubectl", "available"],
      ["gcloud", "needs_project"],
    ]);
  });

  test("a DENIED gh adoption never runs gh auth token and stores nothing", async () => {
    client.onNotification("consent.request", (params) => {
      void client.call("consent.respond", { requestId: params["requestId"], approved: false });
    });
    const out = await client.call<{ status?: string }>("connector.adoptLocalAuth", {
      source: "gh",
      account: "octocat",
    });
    expect(out.status).toBe("rejected");
    const ran = readFileSync(shimLog, "utf8");
    expect(ran).not.toContain('"auth","token"');
    client.clearNotificationHandlers();
  });

  test("an APPROVED aws adoption stores the profile and its region (no network)", async () => {
    let prompt = "";
    client.onNotification("consent.request", (params) => {
      prompt = String(params["prompt"] ?? "");
      void client.call("consent.respond", { requestId: params["requestId"], approved: true });
    });
    const out = await client.call<{ ok?: boolean; service?: string }>("connector.adoptLocalAuth", {
      source: "aws",
      profile: "dev",
    });
    expect(out).toMatchObject({ ok: true, service: "aws" });
    expect(prompt).toContain("connector.adoptLocalAuth");
    expect(prompt).toContain("No credentials are copied");
    client.clearNotificationHandlers();
  });

  test("an APPROVED gcloud adoption stores the auth source and project (no network)", async () => {
    let prompt = "";
    client.onNotification("consent.request", (params) => {
      prompt = String(params["prompt"] ?? "");
      void client.call("consent.respond", { requestId: params["requestId"], approved: true });
    });
    // `needs_project` (the first test above) is still offerable — `resolveTarget`
    // (adopt-local-auth.ts) accepts a caller-supplied project on top of it.
    const out = await client.call<{ ok?: boolean; service?: string }>("connector.adoptLocalAuth", {
      source: "gcloud",
      project: "acme-prod",
    });
    expect(out).toMatchObject({ ok: true, service: "gcp" });
    expect(prompt).toContain("connector.adoptLocalAuth");
    expect(prompt).toContain("Nothing is copied");
    client.clearNotificationHandlers();
  });

  test("the approved values are in the gateway's own vault", async () => {
    proc?.kill();
    await proc?.exited.catch(() => {});
    const vault = await createNimbusVault(paths);
    expect(await vault.get("aws.profile")).toBe("dev");
    expect(await vault.get("aws.default_region")).toBe("eu-west-1");
    expect(await vault.get("github.pat")).toBeNull();
    expect(await vault.get("gcp.auth_source")).toBe("gcloud");
    expect(await vault.get("gcp.project_id")).toBe("acme-prod");
  });
});
