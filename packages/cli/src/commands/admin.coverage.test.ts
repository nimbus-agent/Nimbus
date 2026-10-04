import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolatePlatformEnv } from "../../test/helpers/isolate-platform-env.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import type { CliPlatformPaths } from "../paths.ts";
import { type AdminConnection, type RunAdminDeps, runAdmin } from "./admin.ts";

/**
 * `runAdmin` end to end through its injected deps: argument errors, the local-only subcommands,
 * the gateway-down refusal, and the live `admin.status` round trip — with no gateway and no real
 * `process.exit` (the fake `exit` throws, which is also what stops the flow, as the real one would).
 */

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

const ROOT = join(tmpdir(), "nimbus-admin-cov-never-created");
const PATHS: CliPlatformPaths = {
  configDir: join(ROOT, "config"),
  dataDir: join(ROOT, "data"),
  logDir: join(ROOT, "data", "logs"),
  socketPath: join(ROOT, "gw.sock"),
  extensionsDir: join(ROOT, "ext"),
  tempDir: join(ROOT, "tmp"),
};

interface Recorder {
  readonly err: string[];
  readonly events: string[];
  deps: RunAdminDeps;
}

function recorder(over: Partial<RunAdminDeps> = {}, client?: Partial<AdminConnection>): Recorder {
  const err: string[] = [];
  const events: string[] = [];
  const connection: AdminConnection = {
    connect: async () => {
      events.push("connect");
    },
    disconnect: async () => {
      events.push("disconnect");
    },
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      events.push(`call ${method} ${JSON.stringify(params)}`);
      return { uptimeMs: 7 } as T;
    },
    ...client,
  };
  return {
    err,
    events,
    deps: {
      getPaths: () => {
        events.push("getPaths");
        return PATHS;
      },
      readGatewayState: async () => {
        events.push("readGatewayState");
        return { socketPath: "pipe-under-test" };
      },
      makeClient: (socketPath) => {
        events.push(`makeClient ${socketPath}`);
        return connection;
      },
      writeErr: (s) => err.push(s),
      exit: (code) => {
        throw new ExitCalled(code);
      },
      ...over,
    },
  };
}

const cap = createStreamCapture();
beforeEach(() => {
  cap.install();
});
afterEach(() => {
  cap.restore();
  cap.stdoutChunks.length = 0;
  cap.stderrChunks.length = 0;
});

describe("runAdmin", () => {
  test("an unknown subcommand prints the usage and exits 1 before resolving any path", async () => {
    const r = recorder();
    await expect(runAdmin(["bogus"], r.deps)).rejects.toEqual(new ExitCalled(1));
    expect(r.err).toEqual([
      "Unknown subcommand: bogus\nUsage: nimbus admin [status|console|token]\n",
    ]);
    expect(r.events).toEqual([]);
  });

  test("console and token are answered locally — the gateway is never looked up", async () => {
    for (const sub of ["console", "token"]) {
      const r = recorder();
      await runAdmin([sub], r.deps);
      expect(r.events).toEqual(["getPaths"]);
      expect(r.err).toEqual([]);
    }
    const printed = cap.stdoutChunks.join("");
    expect(printed).toContain("Admin console: http://127.0.0.1:");
    expect(printed).toContain("Print it with: nimbus vault get http_api.deployment_token\n");
  });

  test("in the demo root, token prints the in-memory-vault hint and still never connects", async () => {
    const r = recorder({ getPaths: () => ({ ...PATHS, demo: true }) });
    await runAdmin(["token"], r.deps);
    expect(cap.stdoutChunks.join("")).toBe(
      "The demo root's vault is in-memory; it holds no admin token.\n",
    );
    expect(r.events).toEqual([]);
  });

  test("status with no gateway running prints the start hint and exits 1 without a client", async () => {
    const r = recorder({ readGatewayState: async () => undefined });
    await expect(runAdmin(["status"], r.deps)).rejects.toEqual(new ExitCalled(1));
    expect(r.err).toEqual(["Gateway is not running. Start with: nimbus start\n"]);
    expect(r.events).toEqual(["getPaths"]);
  });

  test("status in the demo root names the demo start command", async () => {
    const r = recorder({
      getPaths: () => ({ ...PATHS, demo: true }),
      readGatewayState: async () => undefined,
    });
    await expect(runAdmin([], r.deps)).rejects.toEqual(new ExitCalled(1));
    expect(r.err).toEqual([
      "Gateway is not running (demo root). Start with: nimbus --demo start\n",
    ]);
  });

  test("status connects to the socket the state file names, calls admin.status, prints, disconnects", async () => {
    const r = recorder();
    await runAdmin(["status"], r.deps);
    expect(r.events).toEqual([
      "getPaths",
      "readGatewayState",
      "makeClient pipe-under-test",
      "connect",
      "call admin.status {}",
      "disconnect",
    ]);
    expect(cap.stdoutChunks.join("")).toBe('{\n  "uptimeMs": 7\n}\n');
  });

  test("a failing admin.status call still disconnects before the error propagates", async () => {
    const r = recorder(
      {},
      {
        call: async () => {
          throw new Error("admin.status exploded");
        },
      },
    );
    await expect(runAdmin(["status"], r.deps)).rejects.toThrow("admin.status exploded");
    expect(r.events.at(-1)).toBe("disconnect");
  });

  test("a disconnect that fails is swallowed — the snapshot was already printed", async () => {
    const r = recorder(
      {},
      {
        disconnect: async () => {
          throw new Error("already closed");
        },
      },
    );
    await runAdmin(["status"], r.deps);
    expect(cap.stdoutChunks.join("")).toBe('{\n  "uptimeMs": 7\n}\n');
  });
});

describe("runAdmin — production defaults", () => {
  test("a bad subcommand writes to the real stderr and calls the real process.exit(1)", async () => {
    // Belt and braces: the argument is refused before any path is resolved, but if that ever
    // regressed, the gateway lookup would land in this never-created root, not a real profile.
    const restoreEnv = isolatePlatformEnv(join(tmpdir(), "nimbus-admin-cov-env-never-created"));
    const exitCap = createStreamCapture({ captureExit: true });
    exitCap.install();
    try {
      await expect(runAdmin(["bogus"])).rejects.toThrow("process.exit(1)");
    } finally {
      exitCap.restore();
      restoreEnv();
    }
    expect(exitCap.stderrChunks.join("")).toBe(
      "Unknown subcommand: bogus\nUsage: nimbus admin [status|console|token]\n",
    );
  });
});
