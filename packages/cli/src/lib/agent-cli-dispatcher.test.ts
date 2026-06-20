import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./agent-cli-dispatcher.ts");
const { runAgentCli } = mod;

const { stderrChunks, install, restore } = createStreamCapture({ captureExit: true });

afterAll(() => {
  restore();
});

function isAnyBrief(x: unknown): x is { gaps: readonly { category: string }[] } {
  return typeof x === "object" && x !== null && Array.isArray((x as { gaps?: unknown }).gaps);
}

describe("runAgentCli", () => {
  beforeEach(() => {
    stderrChunks.length = 0;
    install();
  });
  afterEach(() => {
    clearFixture();
    restore();
  });

  it("exits 1 when the gateway is not running", async () => {
    setFixture({ gatewayState: undefined });
    await expect(
      runAgentCli({
        agentName: "x",
        ipcMethod: "agents.x",
        callParams: {},
        guard: isAnyBrief,
        json: false,
      }),
    ).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("exits 2 and stringifies a NON-Error rejection from the IPC call", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async () => {},
        disconnect: async () => {},
        // Throw a bare string (not an Error) → exercises the `String(err)` arm.
        call: async () => {
          throw "plain string failure";
        },
        onNotification: () => {},
      },
    });
    await expect(
      runAgentCli({
        agentName: "x",
        ipcMethod: "agents.x",
        callParams: {},
        guard: isAnyBrief,
        json: false,
      }),
    ).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("plain string failure");
  });
});
