import { describe, expect, it, test } from "bun:test";
import { awaitLogin, type IdentityIpc, parseIdentityArgs, runIdentityCommand } from "./identity.ts";

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

interface CallRecord {
  method: string;
  params: unknown;
}

interface FakeClient {
  readonly ipc: IdentityIpc;
  readonly calls: CallRecord[];
  /** Fire a registered notification handler. */
  emit(method: string, params: unknown): void;
}

function makeFake(responseQueue: ReadonlyArray<unknown | Error>): FakeClient {
  const calls: CallRecord[] = [];
  let idx = 0;
  const handlers = new Map<string, (params: unknown) => void>();

  const ipc: IdentityIpc = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      if (idx >= responseQueue.length) {
        throw new Error(`Unexpected call: ${method} (response queue exhausted)`);
      }
      const r = responseQueue[idx];
      idx += 1;
      if (r instanceof Error) throw r;
      return r as T;
    },
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
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runIdentityCommand(fake.ipc, { kind: "status" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ method: "identity.status", params: {} });
    expect(stdoutChunks.join("")).toContain("alice@acme.com");
  });
});

describe("runIdentityCommand — logout", () => {
  it("calls identity.logout and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runIdentityCommand(fake.ipc, { kind: "logout" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls[0]?.method).toBe("identity.logout");
    expect(stdoutChunks.join("")).toContain("Logged out.");
  });
});

describe("runIdentityCommand — bind", () => {
  it("calls identity.bind with email + peerId and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runIdentityCommand(fake.ipc, {
        kind: "bind",
        email: "alice@acme.com",
        peerId: "peer:abcd",
      });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls[0]).toEqual({
      method: "identity.bind",
      params: { email: "alice@acme.com", peerId: "peer:abcd" },
    });
    expect(stdoutChunks.join("")).toContain("alice@acme.com");
    expect(stdoutChunks.join("")).toContain("peer:abcd");
  });
});

describe("runIdentityCommand — unbind", () => {
  it("calls identity.unbind with peerId and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runIdentityCommand(fake.ipc, { kind: "unbind", peerId: "peer:abcd" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls[0]).toEqual({
      method: "identity.unbind",
      params: { peerId: "peer:abcd" },
    });
    expect(stdoutChunks.join("")).toContain("peer:abcd");
  });
});

describe("runIdentityCommand — listBindings", () => {
  it("calls identity.listBindings and writes JSON output", async () => {
    const fake = makeFake([{ bindings: [{ peerId: "peer:abcd" }] }]);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runIdentityCommand(fake.ipc, { kind: "listBindings", email: "alice@acme.com" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls[0]).toEqual({
      method: "identity.listBindings",
      params: { email: "alice@acme.com" },
    });
    expect(stdoutChunks.join("")).toContain("peer:abcd");
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

describe("awaitLogin — loginDone resolves", () => {
  it("registers notification handlers, calls identity.login, resolves on loginDone", async () => {
    const jobId = "job-001";
    let loginCallCount = 0;
    const handlers = new Map<string, (params: unknown) => void>();
    const ipc: IdentityIpc = {
      call: async <T>(method: string, _params?: unknown): Promise<T> => {
        if (method === "identity.login") {
          loginCallCount += 1;
          // Defer notification until after jobId is assigned (.then runs first as microtask)
          afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId }));
          return { jobId } as T;
        }
        throw new Error(`Unexpected call: ${method}`);
      },
      onNotification: (method: string, handler: (params: unknown) => void): void => {
        handlers.set(method, handler);
      },
      disconnect: async (): Promise<void> => {},
    };
    await awaitLogin(ipc);
    expect(loginCallCount).toBe(1);
  });
});

describe("awaitLogin — loginError rejects", () => {
  it("rejects with the error message when loginError fires for the matching jobId", async () => {
    const jobId = "job-002";
    const handlers = new Map<string, (params: unknown) => void>();
    const ipc: IdentityIpc = {
      call: async <T>(method: string, _params?: unknown): Promise<T> => {
        if (method === "identity.login") {
          afterMicrotasks(() =>
            handlers.get("identity.loginError")?.({ jobId, message: "auth-failed" }),
          );
          return { jobId } as T;
        }
        throw new Error(`Unexpected call: ${method}`);
      },
      onNotification: (method: string, handler: (params: unknown) => void): void => {
        handlers.set(method, handler);
      },
      disconnect: async (): Promise<void> => {},
    };
    await expect(awaitLogin(ipc)).rejects.toThrow("auth-failed");
  });
});

describe("awaitLogin — loginProgress prints URI + code", () => {
  it("writes verification URI and user code to stdout on progress notification", async () => {
    const jobId = "job-003";
    const handlers = new Map<string, (params: unknown) => void>();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    const ipc: IdentityIpc = {
      call: async <T>(method: string, _params?: unknown): Promise<T> => {
        if (method === "identity.login") {
          afterMicrotasks(() => {
            handlers.get("identity.loginProgress")?.({
              jobId,
              verificationUri: "https://example.com/activate",
              userCode: "ABCD-1234",
            });
            // loginDone fires after the progress notification
            afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId }));
          });
          return { jobId } as T;
        }
        throw new Error(`Unexpected call: ${method}`);
      },
      onNotification: (method: string, handler: (params: unknown) => void): void => {
        handlers.set(method, handler);
      },
      disconnect: async (): Promise<void> => {},
    };
    try {
      await awaitLogin(ipc);
    } finally {
      process.stdout.write = origWrite;
    }
    const combined = stdoutChunks.join("");
    expect(combined).toContain("https://example.com/activate");
    expect(combined).toContain("ABCD-1234");
  });
});

describe("runIdentityCommand — login (full flow via runIdentityCommand)", () => {
  it("calls awaitLogin internally and writes 'Logged in.'", async () => {
    const jobId = "job-004";
    const handlers = new Map<string, (params: unknown) => void>();
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    const ipc: IdentityIpc = {
      call: async <T>(method: string, _params?: unknown): Promise<T> => {
        if (method === "identity.login") {
          afterMicrotasks(() => handlers.get("identity.loginDone")?.({ jobId }));
          return { jobId } as T;
        }
        throw new Error(`Unexpected call: ${method}`);
      },
      onNotification: (method: string, handler: (params: unknown) => void): void => {
        handlers.set(method, handler);
      },
      disconnect: async (): Promise<void> => {},
    };
    try {
      await runIdentityCommand(ipc, { kind: "login" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(stdoutChunks.join("")).toContain("Logged in.");
  });
});
