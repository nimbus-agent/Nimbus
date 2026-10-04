import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

// Imported AFTER cli-mocks: gateway state and the IPC client are the in-process fakes.
const { readGatewayState } = await import("../lib/gateway-process.ts");
const { getCliPlatformPaths } = await import("../paths.ts");
const { runShare, runVerifyShare } = await import("./share.ts");

/**
 * `share.dispatcher.test.ts` covers `runShare`/`runVerifyShare` only on their argument-error
 * paths and drives the command bodies through an injected client, so the step that joins the two
 * -- a parsed command actually sent over a gateway connection -- was never exercised.
 */
describe("runShare / runVerifyShare -- a parsed command goes out over the gateway", () => {
  const out = captureOutput();
  const calls: Array<{ method: string; params: unknown }> = [];
  let disconnects = 0;

  function gatewayAnswering(result: unknown): void {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {
          disconnects += 1;
        },
        onNotification: (): void => {},
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return result;
        },
      },
    });
  }

  beforeEach(async () => {
    // Prove the connection these tests open is the fake: the real state read would see the
    // developer's own gateway and fail this equality instead of sending it a share command.
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    const seen: unknown = await readGatewayState(getCliPlatformPaths());
    expect(seen).toEqual({ socketPath: FAKE_SOCKET_PATH });
    clearFixture();
    calls.length = 0;
    disconnects = 0;
    out.reset();
    process.exitCode = 0;
  });

  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  afterAll(() => {
    out.restore();
  });

  test("runShare sends the parsed subcommand, prints its answer, and disconnects", async () => {
    gatewayAnswering({ pubkey: "ed25519:abc123" });
    await runShare(["pubkey"]);
    expect(calls).toEqual([{ method: "share.pubkey", params: {} }]);
    expect(out.stdout).toBe("ed25519:abc123\n");
    expect(disconnects).toBe(1);
    expect(process.exitCode).toBe(0);
  });

  test("runVerifyShare sends a URL input through untouched and prints the signature verdict", async () => {
    gatewayAnswering({
      ok: true,
      signatureValid: true,
      expired: false,
      errors: [],
      contentHashValid: true,
    });
    await runVerifyShare(["https://shares.example.com/s/abc"]);
    expect(calls).toEqual([
      { method: "share.verify", params: { input: "https://shares.example.com/s/abc" } },
    ]);
    expect(out.stdout).toBe("signature: VALID\n");
    expect(out.stderr).toBe("");
    expect(disconnects).toBe(1);
  });
});
