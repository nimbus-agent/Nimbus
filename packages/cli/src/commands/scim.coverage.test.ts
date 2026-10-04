import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

// Imported AFTER cli-mocks: gateway state and the IPC client are the in-process fakes.
const { readGatewayState } = await import("../lib/gateway-process.ts");
const { getCliPlatformPaths } = await import("../paths.ts");
const { runScim } = await import("./scim.ts");

/**
 * `scim.test.ts` always injects `readState`/`connect`, so the DEFAULTS `runScim` falls back to --
 * the real state read and the real client -- were never the ones under test. These pass no deps.
 */
describe("runScim with its DEFAULT seams", () => {
  const streams = createStreamCapture({ captureExit: true });

  beforeEach(async () => {
    // Prove the defaults resolve to the fakes before any test could dial: the real state read would
    // see the developer's own gateway and fail this equality instead.
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    const seen: unknown = await readGatewayState(getCliPlatformPaths());
    expect(seen).toEqual({ socketPath: FAKE_SOCKET_PATH });
    clearFixture();
    streams.stdoutChunks.length = 0;
    streams.stderrChunks.length = 0;
    streams.install();
  });

  afterEach(() => {
    streams.restore();
    clearFixture();
  });

  test("no running gateway: the not-running line, then exit 1, dialing nothing", async () => {
    const constructions: RecordedClientConstruction[] = [];
    setFixture({ clientConstructions: constructions });
    await expect(runScim(["status"])).rejects.toThrow("process.exit(1)");
    expect(streams.stderrChunks.join("")).toBe(
      "Gateway is not running. Start with: nimbus start\n",
    );
    expect(constructions).toEqual([]);
  });

  test("a running gateway is dialed at its recorded socket, the command runs, and it disconnects", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const constructions: RecordedClientConstruction[] = [];
    let connects = 0;
    let disconnects = 0;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: constructions,
      ipcClient: {
        connect: async (): Promise<void> => {
          connects += 1;
        },
        disconnect: async (): Promise<void> => {
          disconnects += 1;
        },
        call: async (method: string, params: unknown): Promise<unknown> => {
          calls.push({ method, params });
          return { users: ["ada@example.com"] };
        },
      },
    });
    await runScim(["list-users"]);
    expect(constructions.map((c) => c.socketPath)).toEqual([FAKE_SOCKET_PATH]);
    expect(connects).toBe(1);
    expect(calls).toEqual([{ method: "scim.listUsers", params: {} }]);
    expect(streams.stdoutChunks.join("")).toBe(
      `${JSON.stringify({ users: ["ada@example.com"] }, null, 2)}\n`,
    );
    expect(disconnects).toBe(1);
  });
});
