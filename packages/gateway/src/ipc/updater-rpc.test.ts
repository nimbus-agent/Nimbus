import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { ManifestFetchError, Updater } from "../updater/updater.ts";
import { jsonResponse, makeKeypair } from "../updater/updater-test-fixtures.ts";
import { dispatchUpdaterRpc, UpdaterRpcError } from "./updater-rpc.ts";
import { expectRpcError } from "./updater-rpc-test-helpers.ts";

let server: Server<unknown>;
const kp = makeKeypair();

/**
 * Minimal stub that satisfies the structural shape of Updater expected by
 * dispatchUpdaterRpc without using mock.module (process-global in Bun).
 * Cast through `unknown` so TypeScript strict-mode accepts it.
 */
function makeStubUpdater(overrides: {
  getStatus?: () => ReturnType<Updater["getStatus"]>;
  checkNow?: () => ReturnType<Updater["checkNow"]>;
  applyUpdate?: () => Promise<void>;
}): Updater {
  const stub = {
    getStatus:
      overrides.getStatus ??
      (() => ({ state: "idle" as const, currentVersion: "0.0.0", configUrl: "" })),
    checkNow: overrides.checkNow ?? (() => Promise.reject(new Error("not implemented"))),
    applyUpdate: overrides.applyUpdate ?? (() => Promise.reject(new Error("not implemented"))),
  };
  return stub as unknown as Updater;
}

describe("dispatchUpdaterRpc", () => {
  afterEach(() => {
    server?.stop(true);
  });

  test("getStatus returns current state", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => jsonResponse({ version: "0.1.0" }),
    });
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 1000,
    });
    const result = (await dispatchUpdaterRpc("updater.getStatus", {}, { updater: u })) as Record<
      string,
      unknown
    >;
    expect(result["state"]).toBeDefined();
    expect(result["currentVersion"]).toBe("0.1.0");
  });

  test("unknown method rejected", async () => {
    await expect(
      dispatchUpdaterRpc("updater.bogus", {}, { updater: undefined }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("returns -32603 with ERR_UPDATER_MANIFEST_UNREACHABLE in message when fetch fails", async () => {
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: "http://127.0.0.1:1/does-not-exist",
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 500,
    });
    await expectRpcError(
      dispatchUpdaterRpc("updater.checkNow", {}, { updater: u }),
      -32603,
      /ERR_UPDATER_MANIFEST_UNREACHABLE/,
    );
  });

  // ── switch branch=2: case "updater.checkNow" success path ────────────────
  test("checkNow success returns result from updater", async () => {
    const expected = {
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
    };
    const stub = makeStubUpdater({
      checkNow: () => Promise.resolve(expected),
    });
    const result = await dispatchUpdaterRpc("updater.checkNow", {}, { updater: stub });
    expect(result).toEqual(expected);
  });

  // ── switch branch=2: case "updater.checkNow" — line=34 block=2 branch=1
  // non-ManifestFetchError is re-thrown as-is (not wrapped) ─────────────────
  test("checkNow re-throws non-ManifestFetchError errors unchanged", async () => {
    const originalError = new TypeError("unexpected internal failure");
    const stub = makeStubUpdater({
      checkNow: () => Promise.reject(originalError),
    });
    const caught = await dispatchUpdaterRpc("updater.checkNow", {}, { updater: stub }).catch(
      (e: unknown) => e,
    );
    expect(caught).toBe(originalError);
    expect(caught).not.toBeInstanceOf(UpdaterRpcError);
  });

  // ── switch branch=2: case "updater.checkNow" — ManifestFetchError is wrapped
  // (this exercises the taken=0 branch=0 of block=2 via stub so we own the path)
  test("checkNow wraps ManifestFetchError from stub as UpdaterRpcError -32603", async () => {
    const stub = makeStubUpdater({
      checkNow: () => Promise.reject(new ManifestFetchError("stub manifest unreachable")),
    });
    await expectRpcError(
      dispatchUpdaterRpc("updater.checkNow", {}, { updater: stub }),
      -32603,
      /ERR_UPDATER_MANIFEST_UNREACHABLE/,
    );
  });

  // ── switch branch=3: case "updater.applyUpdate" success path ─────────────
  test("applyUpdate success returns jobId object", async () => {
    const stub = makeStubUpdater({
      applyUpdate: () => Promise.resolve(),
    });
    const result = (await dispatchUpdaterRpc(
      "updater.applyUpdate",
      {},
      { updater: stub },
    )) as Record<string, unknown>;
    expect(typeof result["jobId"]).toBe("string");
    expect((result["jobId"] as string).length).toBeGreaterThan(0);
  });

  // ── line=44 block=3 branch=0: err instanceof Error → true
  // ── line=45 block=4 branch=0: /signature|hash/i match → signature error wrapped
  test("applyUpdate wraps Error with 'signature' in message as UpdaterRpcError -32603", async () => {
    const stub = makeStubUpdater({
      applyUpdate: () => Promise.reject(new Error("Ed25519 signature verification failed")),
    });
    await expectRpcError(
      dispatchUpdaterRpc("updater.applyUpdate", {}, { updater: stub }),
      -32603,
      /ERR_UPDATER_SIGNATURE_INVALID/,
    );
  });

  // ── line=44 block=3 branch=0: err instanceof Error → true
  // ── line=45 block=4 branch=0: /signature|hash/i match → hash error wrapped
  test("applyUpdate wraps Error with 'hash' in message as UpdaterRpcError -32603", async () => {
    const stub = makeStubUpdater({
      applyUpdate: () => Promise.reject(new Error("binary hash mismatch: expected abc got def")),
    });
    await expectRpcError(
      dispatchUpdaterRpc("updater.applyUpdate", {}, { updater: stub }),
      -32603,
      /ERR_UPDATER_SIGNATURE_INVALID.*hash mismatch/,
    );
  });

  // ── line=44 block=3 branch=0: err instanceof Error → true
  // ── line=45 block=4 branch=1: /signature|hash/i no match → re-thrown as-is
  test("applyUpdate re-throws Error whose message does not match signature/hash", async () => {
    const originalError = new Error("disk full");
    const stub = makeStubUpdater({
      applyUpdate: () => Promise.reject(originalError),
    });
    const caught = await dispatchUpdaterRpc("updater.applyUpdate", {}, { updater: stub }).catch(
      (e: unknown) => e,
    );
    expect(caught).toBe(originalError);
    expect(caught).not.toBeInstanceOf(UpdaterRpcError);
  });

  // ── line=44 block=3 branch=1: err instanceof Error → false (non-Error thrown)
  // ── line=45 block=4 branch=1: String(err) does not match → re-thrown
  test("applyUpdate re-throws non-Error non-matching thrown value as-is", async () => {
    const thrown = { code: "WEIRD_FAILURE" };
    const stub = makeStubUpdater({
      applyUpdate: () => Promise.reject(thrown),
    });
    const caught = await dispatchUpdaterRpc("updater.applyUpdate", {}, { updater: stub }).catch(
      (e: unknown) => e,
    );
    expect(caught).toBe(thrown);
    expect(caught).not.toBeInstanceOf(UpdaterRpcError);
  });

  // ── line=44 block=3 branch=1: err instanceof Error → false
  // ── line=45 block=4 branch=0: String(err) matches /signature|hash/ → wrapped
  test("applyUpdate wraps non-Error thrown value whose string contains 'signature' as UpdaterRpcError", async () => {
    const stub = makeStubUpdater({
      applyUpdate: () => Promise.reject("signature check failed"),
    });
    await expectRpcError(
      dispatchUpdaterRpc("updater.applyUpdate", {}, { updater: stub }),
      -32603,
      /ERR_UPDATER_SIGNATURE_INVALID.*signature check failed/,
    );
  });

  // ── switch branch=4: case "updater.rollback" ─────────────────────────────
  test("rollback returns ok:true", async () => {
    const stub = makeStubUpdater({});
    const result = (await dispatchUpdaterRpc("updater.rollback", {}, { updater: stub })) as Record<
      string,
      unknown
    >;
    expect(result["ok"]).toBe(true);
  });

  // ── default branch (already covered by existing test — kept for reference)
  test("unknown method returns UpdaterRpcError -32601 even when updater is set", async () => {
    const stub = makeStubUpdater({});
    await expectRpcError(
      dispatchUpdaterRpc("updater.unknown", {}, { updater: stub }),
      -32601,
      /ERR_UPDATER_UNKNOWN_METHOD/,
    );
  });

  // ── line=21: ctx.updater falsy ─ updater configured path
  test("no updater throws UpdaterRpcError -32602", async () => {
    await expectRpcError(
      dispatchUpdaterRpc("updater.getStatus", {}, { updater: undefined }),
      -32602,
      /ERR_UPDATER_NOT_CONFIGURED/,
    );
  });
});
