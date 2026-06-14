import { describe, test } from "bun:test";
import { dispatchUpdaterRpc } from "../../../src/ipc/updater-rpc.ts";
import { expectRpcError } from "../../../src/ipc/updater-rpc-test-helpers.ts";
import { makeKeypair } from "../../../src/updater/testing/updater-test-fixtures.ts";
import { Updater } from "../../../src/updater/updater.ts";

const kp = makeKeypair();

describe("updater + air-gap", () => {
  test("when updater is not configured, returns rpcCode -32602", async () => {
    await expectRpcError(
      dispatchUpdaterRpc("updater.checkNow", {}, { updater: undefined }),
      -32602,
      /ERR_UPDATER_NOT_CONFIGURED/,
    );
  });

  test("fetch failure surfaces as -32603 with ERR_UPDATER_MANIFEST_UNREACHABLE in message", async () => {
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: "http://127.0.0.1:1/no",
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
});
