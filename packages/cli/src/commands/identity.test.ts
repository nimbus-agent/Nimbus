import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { awaitLogin, type IdentityIpc, parseIdentityArgs, runIdentityCommand } from "./identity.ts";
import { type CallRecord, captureStdout, makeQueuedCall } from "./testing/cli-test-helpers.ts";

// ---------------------------------------------------------------------------
// Parser tests (unchanged)
// ---------------------------------------------------------------------------

test("login (default)", () => {
  expect(parseIdentityArgs([])).toEqual({ kind: "login" });
  expect(parseIdentityArgs(["login"])).toEqual({ kind: "login" });
});
test("status / logout", () => {
  expect(parseIdentityArgs(["status"])).toEqual({ kind: "status" });
  expect(parseIdentityArgs(["logout"])).toEqual({ kind: "logout" });
});
test("bind requires email + peer", () => {
  expect(parseIdentityArgs(["bind", "a@acme.com", "peer:aa"])).toEqual({
    kind: "bind",
    email: "a@acme.com",
    peerId: "peer:aa",
  });
  expect(() => parseIdentityArgs(["bind", "a@acme.com"])).toThrow();
});
test("unbind / list-bindings", () => {
  expect(parseIdentityArgs(["unbind", "peer:aa"])).toEqual({ kind: "unbind", peerId: "peer:aa" });
  expect(parseIdentityArgs(["list-bindings", "a@acme.com"])).toEqual({
    kind: "listBindings",
    email: "a@acme.com",
  });
});
test("unknown throws", () => {
  expect(() => parseIdentityArgs(["bogus"])).toThrow();
});

// ---------------------------------------------------------------------------
// Fake IdentityIpc helper
// ---------------------------------------------------------------------------

interface FakeClient {
  readonly ipc: IdentityIpc;
  readonly calls: CallRecord[];
  /** Fire a registered notification handler. */
  emit(method: string, params: unknown): void;
}

function makeFake(responseQueue: readonly unknown[]): FakeClient {
  const { call, calls } = makeQueuedCall(responseQueue);
  const handlers = new Map<string, (params: unknown) => void>();
  const ipc: IdentityIpc = {
    call,
    onNotification: (method: string, handler: (params: unknown) => void): void => {
      handlers.set(method, handler);
    },
    disconnect: async (): Promise<void> => {},
  };
  const emit = (method: string, params: unknown): void => {
    handlers.get(method)?.(params);
  };
  return { ipc, calls, emit };
}

// ---------------------------------------------------------------------------
// runIdentityCommand dispatcher tests
// ---------------------------------------------------------------------------

describe("runIdentityCommand — status", () => {
  it("calls identity.status and writes JSON output", async () => {
    const fake = makeFake([{ provider: "google", email: "alice@acme.com" }]);
    const out = await captureStdout(() => runIdentityCommand(fake.ipc, { kind: "status" }));
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ method: "identity.status", params: {} });
    expect(out).toContain("alice@acme.com");
  });
});

describe("runIdentityCommand — logout", () => {
  it("calls identity.logout and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const out = await captureStdout(() => runIdentityCommand(fake.ipc, { kind: "logout" }));
    expect(fake.calls[0]?.method).toBe("identity.logout");
    expect(out).toContain("Logged out.");
  });
});

describe("runIdentityCommand — bind", () => {
  it("calls identity.bind with email + peerId and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const out = await captureStdout(() =>
      runIdentityCommand(fake.ipc, {
        kind: "bind",
        email: "alice@acme.com",
        peerId: "peer:abcd",
      }),
    );
    expect(fake.calls[0]).toEqual({
      method: "identity.bind",
      params: { email: "alice@acme.com", peerId: "peer:abcd" },
    });
    expect(out).toContain("alice@acme.com");
    expect(out).toContain("peer:abcd");
  });
});

describe("runIdentityCommand — unbind", () => {
  it("calls identity.unbind with peerId and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const out = await captureStdout(() =>
      runIdentityCommand(fake.ipc, { kind: "unbind", peerId: "peer:abcd" }),
    );
    expect(fake.calls[0]).toEqual({
      method: "identity.unbind",
      params: { peerId: "peer:abcd" },
    });
    expect(out).toContain("peer:abcd");
  });
});

describe("runIdentityCommand — listBindings", () => {
  it("calls identity.listBindings and writes JSON output", async () => {
    const fake = makeFake([{ bindings: [{ peerId: "peer:abcd" }] }]);
    const out = await captureStdout(() =>
      runIdentityCommand(fake.ipc, { kind: "listBindings", email: "alice@acme.com" }),
    );
    expect(fake.calls[0]).toEqual({
      method: "identity.listBindings",
      params: { email: "alice@acme.com" },
    });
    expect(out).toContain("peer:abcd");
  });
});

// ---------------------------------------------------------------------------
// awaitLogin / login flow tests
// ---------------------------------------------------------------------------

// Helper: schedule a callback after all pending microtasks have drained.
// awaitLogin sets jobId inside a .then() on the call() promise; we need to
// fire notifications only after that .then() has run, so we defer via a
// macrotask (setTimeout 0) which is guaranteed to execute after microtasks.
function afterMicrotasks(fn: () => void): void {
  setTimeout(fn, 0);
}

type NotifyHandlers = Map<string, (params: unknown) => void>;

/** An IdentityIpc whose `identity.login` returns `{ jobId }` then runs `onLogin(handlers, jobId)`
 *  so the test can fire deferred loginProgress/loginDone/loginError notifications. */
function loginIpc(
  jobId: string,
  onLogin: (handlers: NotifyHandlers, jobId: string) => void,
): IdentityIpc {
  const handlers: NotifyHandlers = new Map();
  return {
    call: async <T>(method: string, _params?: unknown): Promise<T> => {
      if (method === "identity.login") {
        onLogin(handlers, jobId);
        return { jobId } as T;
      }
      throw new Error(`Unexpected call: ${method}`);
    },
    onNotification: (method: string, handler: (params: unknown) => void): void => {
      handlers.set(method, handler);
    },
    disconnect: async (): Promise<void> => {},
  };
}

describe("awaitLogin — loginDone resolves", () => {
  it("registers notification handlers, calls identity.login, resolves on loginDone", async () => {
    let loginCallCount = 0;
    const ipc = loginIpc("job-001", (handlers, jobId) => {
      loginCallCount += 1;
      // Defer notification until after jobId is assigned (.then runs first as microtask).
      afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId }));
    });
    await awaitLogin(ipc);
    expect(loginCallCount).toBe(1);
  });
});

describe("awaitLogin — loginError rejects", () => {
  it("rejects with the error message when loginError fires for the matching jobId", async () => {
    const ipc = loginIpc("job-002", (handlers, jobId) =>
      afterMicrotasks(() =>
        handlers.get("identity.loginError")?.({ jobId, message: "auth-failed" }),
      ),
    );
    await expect(awaitLogin(ipc)).rejects.toThrow("auth-failed");
  });
});

describe("awaitLogin — loginProgress prints URI + code", () => {
  it("writes verification URI and user code to stdout on progress notification", async () => {
    const ipc = loginIpc("job-003", (handlers, jobId) =>
      afterMicrotasks(() => {
        handlers.get("identity.loginProgress")?.({
          jobId,
          verificationUri: "https://example.com/activate",
          userCode: "ABCD-1234",
        });
        // loginDone fires after the progress notification.
        afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId }));
      }),
    );
    const out = await captureStdout(() => awaitLogin(ipc));
    expect(out).toContain("https://example.com/activate");
    expect(out).toContain("ABCD-1234");
  });
});

describe("awaitLogin — buffers events that race ahead of jobId", () => {
  it("resolves a loginDone delivered before the login response assigns jobId", async () => {
    const ipc = loginIpc("job-race", (handlers, jobId) => {
      // Fire synchronously, before awaitLogin's call().then() runs to set jobId — exercises the
      // backlog buffer + replay path (the event would otherwise be dropped and the Promise hang).
      handlers.get("identity.loginDone")?.({ jobId });
    });
    await expect(awaitLogin(ipc)).resolves.toBeUndefined();
  });
});

describe("runIdentityCommand — login (full flow via runIdentityCommand)", () => {
  it("calls awaitLogin internally and writes 'Logged in.'", async () => {
    const ipc = loginIpc("job-004", (handlers, jobId) =>
      afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId })),
    );
    const out = await captureStdout(() => runIdentityCommand(ipc, { kind: "login" }));
    expect(out).toContain("Logged in.");
  });
});

// ---------------------------------------------------------------------------
// Additional parser edge-cases (missing required args)
// ---------------------------------------------------------------------------

test("unbind requires peerId", () => {
  expect(() => parseIdentityArgs(["unbind"])).toThrow("Usage: nimbus identity unbind <peerId>");
});

test("list-bindings requires email", () => {
  expect(() => parseIdentityArgs(["list-bindings"])).toThrow(
    "Usage: nimbus identity list-bindings <email>",
  );
});

// ---------------------------------------------------------------------------
// awaitLogin — additional edge cases
// ---------------------------------------------------------------------------

describe("awaitLogin — loginError rejects with default message when no message field", () => {
  it("rejects with 'identity: login failed' when loginError payload has no message", async () => {
    const ipc = loginIpc("job-err-nomsg", (handlers, jobId) =>
      afterMicrotasks(() =>
        // No `message` field — exercises the `p.message ?? "identity: login failed"` branch
        handlers.get("identity.loginError")?.({ jobId }),
      ),
    );
    await expect(awaitLogin(ipc)).rejects.toThrow("identity: login failed");
  });
});

describe("awaitLogin — notification with no jobId field is ignored", () => {
  it("does not resolve or reject when a notification has no jobId", async () => {
    let loginCallCount = 0;
    const ipc = loginIpc("job-nojobid", (handlers, jobId) => {
      loginCallCount += 1;
      afterMicrotasks(() => {
        // Emit a notification without any jobId — exercises `typeof p.jobId !== "string"` guard.
        handlers.get("identity.loginProgress")?.({ verificationUri: "x", userCode: "y" });
        // Then fire the real done to let the promise resolve.
        afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId }));
      });
    });
    await awaitLogin(ipc);
    expect(loginCallCount).toBe(1);
  });
});

describe("awaitLogin — notification with wrong jobId is ignored", () => {
  it("does not resolve when loginDone fires for a different jobId", async () => {
    let loginCallCount = 0;
    const ipc = loginIpc("job-correct", (handlers, jobId) => {
      loginCallCount += 1;
      afterMicrotasks(() => {
        // loginDone with a wrong jobId — exercises `p.jobId !== jobId` guard.
        handlers.get("identity.loginDone")?.({ jobId: "job-wrong" });
        // Then fire done with the real jobId so the test terminates.
        afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId }));
      });
    });
    await awaitLogin(ipc);
    expect(loginCallCount).toBe(1);
  });
});

describe("awaitLogin — loginProgress without both URI and code does not print", () => {
  it("does not write to stdout when verificationUri is missing", async () => {
    const ipc = loginIpc("job-noprint", (handlers, jobId) =>
      afterMicrotasks(() => {
        // Only userCode, no verificationUri — exercises the &&-branch in emitProgress.
        handlers.get("identity.loginProgress")?.({ jobId, userCode: "WXYZ-9876" });
        afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId }));
      }),
    );
    const out = await captureStdout(() => awaitLogin(ipc));
    expect(out).toBe("");
  });
});

describe("awaitLogin — call() rejection rejects the promise", () => {
  it("rejects when identity.login IPC call fails", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const ipc: IdentityIpc = {
      call: async <T>(_method: string, _params?: unknown): Promise<T> => {
        throw new Error("connection refused");
      },
      onNotification: (method: string, handler: (params: unknown) => void): void => {
        handlers.set(method, handler);
      },
      disconnect: async (): Promise<void> => {},
    };
    await expect(awaitLogin(ipc)).rejects.toThrow("connection refused");
  });
});

// ---------------------------------------------------------------------------
// runIdentity (outer dispatch) — gateway-state & parse-error branches
// ---------------------------------------------------------------------------

// Use the shared cli-mocks infrastructure so we can intercept gateway-process.ts
// and the IPC client constructor from the outer runIdentity() entry point.
// The outer function is dynamically imported AFTER cli-mocks.ts installs its
// mock.module hooks (which happens at module load time via installCliMocks()).

const identityMod = await import("./identity.ts");
const { runIdentity } = identityMod;

const out = captureOutput();

describe("runIdentity (outer)", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("writes error to stderr and exits 1 on unknown subcommand", async () => {
    // runIdentity parses argv BEFORE reading gateway state, so the unknown-subcommand
    // parse error fires regardless of gateway presence.
    // process.exit is replaced by setting process.exitCode — wrap to avoid killing the runner.
    const origExit = process.exit;
    let exitedWith: number | undefined;
    process.exit = ((code?: number): never => {
      exitedWith = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    // runIdentity writes the parse error via process.stderr.write (not console.error),
    // so detect it directly (mirrors the gateway-not-running test) and restore in finally.
    let stderrSeen = false;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      if (String(chunk).includes("Unknown subcommand")) stderrSeen = true;
      return origStderr(chunk);
    };
    try {
      await runIdentity(["bogus-sub"]).catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    expect(exitedWith).toBe(1);
    // Prove the PARSE branch ran (not the gateway-not-running path, which also exits 1).
    expect(stderrSeen).toBe(true);
  });

  it("writes 'Gateway is not running' and exits 1 when no gateway state", async () => {
    // setFixture({}) => readGatewayState returns undefined
    setFixture({});
    const origExit = process.exit;
    let exitedWith: number | undefined;
    process.exit = ((code?: number): never => {
      exitedWith = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    let stderrSeen = false;
    const origStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array): boolean => {
      if (String(chunk).includes("Gateway is not running")) stderrSeen = true;
      return origStderr(chunk);
    };
    try {
      await runIdentity(["status"]).catch(() => {});
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderr;
    }
    expect(exitedWith).toBe(1);
    expect(stderrSeen).toBe(true);
  });

  it("calls identity.status through IPC when gateway is running", async () => {
    const ipc = createMockIpcClient([{ provider: "google", email: "user@example.com" }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 99 },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
        onNotification: () => {},
      },
    });
    await runIdentity(["status"]);
    expect(ipc.calls[0]?.method).toBe("identity.status");
    expect(out.stdout).toBe(""); // status uses process.stdout.write not console.log
  });
});
