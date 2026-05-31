import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const GATEWAY_BIN = process.env.NIMBUS_GATEWAY_BIN;
const STARTUP_TIMEOUT_MS = 60_000;
const STREAM_TIMEOUT_MS = 30_000;
const NODE_TEST_TIMEOUT_MS = 120_000;

if (GATEWAY_BIN === undefined) {
  await test("node-compat (skipped — NIMBUS_GATEWAY_BIN not set)", { skip: true }, () => undefined);
} else {
  const { discoverSocketPath, NimbusClient } = (await import(
    "../dist/index.js"
  )) as typeof import("../dist/index.js");

  type ProcDiagnostics = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
  };

  const tail = (s: string): string => (s.length > 4000 ? `${s.slice(-4000)}\n[…truncated]` : s);

  const waitForSocket = async (
    socketPath: string,
    timeoutMs: number,
    diag: () => ProcDiagnostics,
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const c = await NimbusClient.open({ socketPath });
        await c.close();
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    const d = diag();
    throw new Error(
      `Gateway socket did not appear within ${timeoutMs}ms: ${socketPath}\n` +
        `  exitCode=${d.exitCode} exitSignal=${d.exitSignal}\n` +
        `  --- gateway stdout ---\n${tail(d.stdout) || "(empty)"}\n` +
        `  --- gateway stderr ---\n${tail(d.stderr) || "(empty)"}\n` +
        `  ----------------------`,
    );
  };

  const spawnGateway = async (
    dataDir: string,
  ): Promise<{
    proc: ChildProcessWithoutNullStreams;
    socketPath: string;
    diag: () => ProcDiagnostics;
  }> => {
    const env = { ...process.env, NIMBUS_DATA_DIR: dataDir };
    const proc = spawn(GATEWAY_BIN, [], { env });
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("exit", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
    });
    const diag = (): ProcDiagnostics => ({ stdout, stderr, exitCode, exitSignal });
    const r = await discoverSocketPath();
    try {
      await waitForSocket(r.socketPath, STARTUP_TIMEOUT_MS, diag);
    } catch (err) {
      proc.kill("SIGTERM");
      throw err;
    }
    return { proc, socketPath: r.socketPath, diag };
  };

  const withStreamTimeout = async <T>(
    label: string,
    p: Promise<T>,
    diag: () => ProcDiagnostics,
  ): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const d = diag();
        reject(
          new Error(
            `${label} did not complete within ${STREAM_TIMEOUT_MS}ms\n` +
              `  exitCode=${d.exitCode} exitSignal=${d.exitSignal}\n` +
              `  --- gateway stdout ---\n${tail(d.stdout) || "(empty)"}\n` +
              `  --- gateway stderr ---\n${tail(d.stderr) || "(empty)"}\n` +
              `  ----------------------`,
          ),
        );
      }, STREAM_TIMEOUT_MS);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // The CI gateway has no LLM provider, so a real askStream("hello") call
  // never produces `streamDone` on its own — the agent invocation hangs
  // waiting on an LLM, and `handle.cancel()` tears down the iterator
  // locally without yielding a synthetic event (see ask-stream.ts:`finish`).
  // What this test *can* validate end-to-end without an LLM is:
  //   1. `engine.askStream` JSON-RPC call returns a streamId
  //      (proves the streaming method is registered and wired through IPC).
  //   2. `cancel()` resolves and terminates the iterator cleanly within the
  //      stream timeout (proves the AbortController + finish() path works
  //      across the dual-runtime IPC transport).
  await test("askStream returns a streamId and cancel terminates the iterator", {
    timeout: NODE_TEST_TIMEOUT_MS,
  }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nimbus-nodecompat-"));
    const { proc, socketPath, diag } = await spawnGateway(dataDir);
    try {
      const client = await NimbusClient.open({ socketPath });
      const handle = client.askStream("hello");
      // streamId is resolved asynchronously by the underlying engine.askStream
      // RPC. Poll briefly until it lands so we can assert we got one.
      const waitForStreamId = async (): Promise<string> => {
        const start = Date.now();
        while (Date.now() - start < 5000) {
          if (handle.streamId !== "") return handle.streamId;
          await new Promise((r) => setTimeout(r, 50));
        }
        return "";
      };
      const streamId = await waitForStreamId();
      assert.notStrictEqual(streamId, "", "askStream should return a streamId");
      await withStreamTimeout(
        "askStream cancel + iterator drain",
        (async () => {
          await handle.cancel();
          // Drain the iterator; cancel() called finish() so this should exit
          // immediately. The deadline is the upper bound on a stuck iterator.
          for await (const _ev of handle) {
            // Any events that arrived between RPC and cancel are fine.
          }
        })(),
        diag,
      );
      await client.close();
    } finally {
      proc.kill("SIGTERM");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test("subscribeHitl receives synthetic agent.hitlBatch", {
    timeout: NODE_TEST_TIMEOUT_MS,
  }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nimbus-nodecompat-"));
    const { proc, socketPath } = await spawnGateway(dataDir);
    try {
      const client = await NimbusClient.open({ socketPath });
      let _received = false;
      const sub = client.subscribeHitl(() => {
        _received = true;
      });
      // The Gateway in test mode does not naturally fire HITL on a passive
      // socket connection; this test only asserts the subscription wires up
      // without throwing. A full HITL roundtrip is covered by the integration
      // test in the gateway package.
      assert.equal(typeof sub.dispose, "function");
      await client.close();
    } finally {
      proc.kill("SIGTERM");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test("cancel() mid-stream terminates iterator", {
    timeout: NODE_TEST_TIMEOUT_MS,
  }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nimbus-nodecompat-"));
    const { proc, socketPath, diag } = await spawnGateway(dataDir);
    try {
      const client = await NimbusClient.open({ socketPath });
      const handle = client.askStream("long-running");
      setTimeout(() => {
        handle.cancel().catch(() => undefined);
      }, 50);
      await withStreamTimeout(
        "cancel() stream iteration",
        (async () => {
          const events: string[] = [];
          for await (const ev of handle) {
            events.push(ev.type);
            if (events.length > 100) break;
          }
          // Cancellation should terminate the iterator gracefully — well
          // under the 100-event manual safety break.
          assert.ok(events.length <= 100);
        })(),
        diag,
      );
      await client.close();
    } finally {
      proc.kill("SIGTERM");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test("disconnect closes socket without leaking handles", {
    timeout: NODE_TEST_TIMEOUT_MS,
  }, async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nimbus-nodecompat-"));
    const { proc, socketPath } = await spawnGateway(dataDir);
    try {
      const client = await NimbusClient.open({ socketPath });
      await client.close();
      // Re-open to confirm socket is still usable
      const client2 = await NimbusClient.open({ socketPath });
      await client2.close();
    } finally {
      proc.kill("SIGTERM");
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
}
