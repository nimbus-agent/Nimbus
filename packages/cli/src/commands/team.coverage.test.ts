import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  CLACK_CANCEL,
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import type { TeamRpcClient } from "./team.ts";

// Imported AFTER cli-mocks: the prompt, the gateway state and the IPC client are the in-process fakes.
const { readGatewayState } = await import("../lib/gateway-process.ts");
const { getCliPlatformPaths } = await import("../paths.ts");
const { runTeam, runTeamCommand } = await import("./team.ts");

type Call = { method: string; params: unknown };

const streams = createStreamCapture({ captureExit: true });

beforeEach(async () => {
  // `runTeam` binds the REAL gateway seams. Prove they resolve to the fakes before any test can
  // reach them: the real `readGatewayState` would read the developer's own state file here and
  // fail this equality, rather than letting a test dial a live gateway.
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

describe("team purge without --yes asks first -- and only an explicit yes purges", () => {
  function recordingClient(): { client: TeamRpcClient; calls: Call[] } {
    const calls: Call[] = [];
    return {
      calls,
      client: {
        call: async (method: string, params?: unknown) => {
          calls.push({ method, params });
          return { jobId: "job-1", localDeleted: 1 } as never;
        },
      },
    };
  }

  test.each([
    ["a no", false],
    ["a cancel (Esc / Ctrl-C)", CLACK_CANCEL],
  ])("%s aborts before team.purge is ever called", async (_label, answer) => {
    setFixture({ clackAnswer: answer });
    const { client, calls } = recordingClient();
    await runTeamCommand(["purge", "--user", "u1"], { client });
    expect(calls).toEqual([]);
    expect(streams.stdoutChunks.join("")).toBe("aborted\n");
  });

  test("an explicit yes goes on to team.purge for that user", async () => {
    setFixture({ clackAnswer: true });
    const { client, calls } = recordingClient();
    await runTeamCommand(["purge", "--user", "u1"], { client });
    expect(calls).toEqual([{ method: "team.purge", params: { externalId: "u1" } }]);
    expect(streams.stdoutChunks.join("")).toBe(
      "GDPR purge started for u1: job job-1 (1 local grant(s) revoked)\n",
    );
  });
});

describe("runTeam -- the real I/O seams", () => {
  test("a usage error exits 1 through the real process.exit", async () => {
    await expect(runTeam(["bogus"])).rejects.toThrow("process.exit(1)");
    expect(streams.stderrChunks.join("")).toStartWith("Unknown subcommand: bogus\n");
  });

  test("no running gateway exits 1 with the not-running message, dialing nothing", async () => {
    const constructions: RecordedClientConstruction[] = [];
    setFixture({ clientConstructions: constructions });
    await expect(runTeam(["discover"])).rejects.toThrow("process.exit(1)");
    expect(streams.stderrChunks.join("")).toContain("Gateway is not running");
    expect(constructions).toEqual([]);
  });

  test("a running gateway is dialed at its recorded socket, used once, then disconnected", async () => {
    const calls: Call[] = [];
    const constructions: RecordedClientConstruction[] = [];
    // One ordered log: a client that is called before it connects is not "dialed" at all.
    const lifecycle: string[] = [];
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: constructions,
      ipcClient: {
        connect: async (): Promise<void> => {
          lifecycle.push("connect");
        },
        disconnect: async (): Promise<void> => {
          lifecycle.push("disconnect");
        },
        call: async (method: string, params: unknown): Promise<unknown> => {
          lifecycle.push(`call ${method}`);
          calls.push({ method, params });
          return [{ delegatePeer: "peer:bob" }];
        },
      },
    });
    await runTeam(["delegations"]);
    expect(constructions.map((c) => c.socketPath)).toEqual([FAKE_SOCKET_PATH]);
    expect(lifecycle).toEqual(["connect", "call hitl.listDelegations", "disconnect"]);
    expect(calls).toEqual([{ method: "hitl.listDelegations", params: {} }]);
    expect(streams.stdoutChunks.join("")).toBe(
      `${JSON.stringify([{ delegatePeer: "peer:bob" }], null, 2)}\n`,
    );
  });

  test("a disconnect that fails after the command ran is swallowed, never turned into a failure", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {
          throw new Error("socket already closed");
        },
        call: async (): Promise<unknown> => [],
      },
    });
    await runTeam(["delegations"]);
    expect(streams.stdoutChunks.join("")).toBe("[]\n");
    expect(streams.stderrChunks).toEqual([]);
  });
});
