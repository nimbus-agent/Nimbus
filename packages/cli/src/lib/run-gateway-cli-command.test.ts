import { describe, expect, test } from "bun:test";

import {
  GATEWAY_NOT_RUNNING_MESSAGE,
  type GatewayCliIo,
  REAL_GATEWAY_CLI_IO,
  runGatewayCliCommand,
} from "./run-gateway-cli-command.ts";

/** Raised instead of exiting the test process; `fail` must never return. */
class Failed extends Error {}

type FakeClient = {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
};

function harness(opts?: {
  state?: { socketPath: string } | undefined;
  disconnectRejects?: boolean;
}): {
  io: GatewayCliIo<FakeClient>;
  log: string[];
  failures: string[];
} {
  const log: string[] = [];
  const failures: string[] = [];
  const io: GatewayCliIo<FakeClient> = {
    readState: async () => {
      log.push("readState");
      return opts === undefined || !("state" in opts)
        ? { socketPath: "/tmp/nimbus.sock" }
        : opts.state;
    },
    makeClient: (socketPath) => {
      log.push(`makeClient:${socketPath}`);
      return {
        connect: async () => {
          log.push("connect");
        },
        disconnect: async () => {
          log.push("disconnect");
          if (opts?.disconnectRejects === true) throw new Error("socket already gone");
        },
      };
    },
    fail: (message) => {
      failures.push(message);
      throw new Failed(message);
    },
  };
  return { io, log, failures };
}

describe("runGatewayCliCommand", () => {
  test("parses, connects, dispatches the parsed command, then disconnects", async () => {
    const { io, log } = harness();
    const dispatched: string[] = [];
    await runGatewayCliCommand(["status"], {
      parse: (argv) => ({ kind: argv[0] ?? "" }),
      dispatch: async (_c, cmd) => {
        log.push("dispatch");
        dispatched.push(cmd.kind);
      },
      io,
    });
    expect(dispatched).toEqual(["status"]);
    expect(log).toEqual([
      "readState",
      "makeClient:/tmp/nimbus.sock",
      "connect",
      "dispatch",
      "disconnect",
    ]);
  });

  test("reports a parse error and never touches the gateway", async () => {
    const { io, log, failures } = harness();
    await expect(
      runGatewayCliCommand(["bogus"], {
        parse: () => {
          throw new Error("Unknown subcommand: bogus");
        },
        dispatch: async () => {
          throw new Error("must not dispatch");
        },
        io,
      }),
    ).rejects.toBeInstanceOf(Failed);
    expect(failures).toEqual(["Unknown subcommand: bogus"]);
    expect(log).toEqual([]);
  });

  test("stringifies a non-Error thrown by the parser", async () => {
    const { io, failures } = harness();
    await expect(
      runGatewayCliCommand([], {
        parse: () => {
          throw "plain string failure";
        },
        dispatch: async () => {},
        io,
      }),
    ).rejects.toBeInstanceOf(Failed);
    expect(failures).toEqual(["plain string failure"]);
  });

  test("reports the shared not-running message and never constructs a client", async () => {
    const { io, log, failures } = harness({ state: undefined });
    await expect(
      runGatewayCliCommand(["status"], {
        parse: () => ({ kind: "status" }),
        dispatch: async () => {
          throw new Error("must not dispatch");
        },
        io,
      }),
    ).rejects.toBeInstanceOf(Failed);
    expect(failures).toEqual([GATEWAY_NOT_RUNNING_MESSAGE]);
    expect(log).toEqual(["readState"]);
  });

  // The `finally` is the whole reason this runner exists as one implementation:
  // a command that throws mid-dispatch must still release the socket, or the
  // gateway holds a dead connection until the process is killed.
  test("disconnects even when the dispatcher throws, and propagates the error", async () => {
    const { io, log } = harness();
    await expect(
      runGatewayCliCommand(["status"], {
        parse: () => ({ kind: "status" }),
        dispatch: async () => {
          throw new Error("dispatch blew up");
        },
        io,
      }),
    ).rejects.toThrow("dispatch blew up");
    expect(log).toEqual(["readState", "makeClient:/tmp/nimbus.sock", "connect", "disconnect"]);
  });

  // A gateway that has already closed the socket makes `disconnect()` reject.
  // The command has done its work by then, so that must not become the outcome.
  test("swallows a rejecting disconnect after a successful dispatch", async () => {
    const { io } = harness({ disconnectRejects: true });
    await expect(
      runGatewayCliCommand(["status"], {
        parse: () => ({ kind: "status" }),
        dispatch: async () => {},
        io,
      }),
    ).resolves.toBeUndefined();
  });

  test("a rejecting disconnect does not mask the dispatcher's error", async () => {
    const { io } = harness({ disconnectRejects: true });
    await expect(
      runGatewayCliCommand(["status"], {
        parse: () => ({ kind: "status" }),
        dispatch: async () => {
          throw new Error("dispatch blew up");
        },
        io,
      }),
    ).rejects.toThrow("dispatch blew up");
  });
});

describe("REAL_GATEWAY_CLI_IO", () => {
  test("makeClient builds a client bound to the given socket path", () => {
    const c = REAL_GATEWAY_CLI_IO.makeClient("/tmp/nimbus-unused.sock");
    expect(typeof c.connect).toBe("function");
    expect(typeof c.disconnect).toBe("function");
  });

  // Resolves against this machine's real state file. The assertion is only that
  // it answers in the contract's shape — `undefined`, or an object carrying a
  // socket path — so it holds whether or not a gateway happens to be running.
  test("readState resolves to undefined or a socket path", async () => {
    const state = await REAL_GATEWAY_CLI_IO.readState();
    if (state !== undefined) expect(typeof state.socketPath).toBe("string");
    else expect(state).toBeUndefined();
  });
});
