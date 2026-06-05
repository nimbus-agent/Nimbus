import { describe, expect, it, test } from "bun:test";
import { parseScimArgs, runScimCommand, type ScimIpc } from "./scim.ts";

// ---------------------------------------------------------------------------
// Parser tests (unchanged)
// ---------------------------------------------------------------------------

test("status / list-users defaults", () => {
  expect(parseScimArgs(["status"])).toEqual({ kind: "status" });
  expect(parseScimArgs(["list-users"])).toEqual({ kind: "listUsers" });
});
test("set-token requires a token", () => {
  expect(parseScimArgs(["set-token", "secret"])).toEqual({ kind: "setToken", token: "secret" });
  expect(() => parseScimArgs(["set-token"])).toThrow();
});
test("deprovision requires an email", () => {
  expect(parseScimArgs(["deprovision", "a@acme.com"])).toEqual({
    kind: "deprovision",
    email: "a@acme.com",
  });
  expect(() => parseScimArgs(["deprovision"])).toThrow();
});

// ---------------------------------------------------------------------------
// Fake ScimIpc helper
// ---------------------------------------------------------------------------

interface CallRecord {
  method: string;
  params: unknown;
}

function makeFake(responseQueue: ReadonlyArray<unknown | Error>): {
  ipc: ScimIpc;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let idx = 0;

  const ipc: ScimIpc = {
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
    disconnect: async (): Promise<void> => {},
  };

  return { ipc, calls };
}

// ---------------------------------------------------------------------------
// runScimCommand dispatcher tests
// ---------------------------------------------------------------------------

describe("runScimCommand — status", () => {
  it("calls scim.status and writes JSON output", async () => {
    const fake = makeFake([{ enabled: true, userCount: 3 }]);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runScimCommand(fake.ipc, { kind: "status" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ method: "scim.status", params: {} });
    expect(stdoutChunks.join("")).toContain("userCount");
  });
});

describe("runScimCommand — setToken", () => {
  it("calls scim.setToken with the token and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runScimCommand(fake.ipc, { kind: "setToken", token: "tok-secret" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls[0]).toEqual({
      method: "scim.setToken",
      params: { token: "tok-secret" },
    });
    expect(stdoutChunks.join("")).toContain("SCIM bearer token stored.");
  });
});

describe("runScimCommand — listUsers", () => {
  it("calls scim.listUsers and writes JSON output", async () => {
    const fake = makeFake([{ users: [{ email: "bob@acme.com" }] }]);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runScimCommand(fake.ipc, { kind: "listUsers" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls[0]).toEqual({ method: "scim.listUsers", params: {} });
    expect(stdoutChunks.join("")).toContain("bob@acme.com");
  });
});

describe("runScimCommand — deprovision", () => {
  it("calls scim.deprovision with the email and writes confirmation", async () => {
    const fake = makeFake([{}]);
    const stdoutChunks: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    };
    try {
      await runScimCommand(fake.ipc, { kind: "deprovision", email: "carol@acme.com" });
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.calls[0]).toEqual({
      method: "scim.deprovision",
      params: { email: "carol@acme.com" },
    });
    expect(stdoutChunks.join("")).toContain("carol@acme.com");
  });
});
