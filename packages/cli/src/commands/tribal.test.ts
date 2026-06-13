import { afterEach, expect, test } from "bun:test";
import { parseTribalArgs, runTribalCommand, type TribalIpc } from "./tribal.ts";

test("default + status → status", () => {
  expect(parseTribalArgs([])).toEqual({ kind: "status" });
  expect(parseTribalArgs(["status"])).toEqual({ kind: "status" });
});

test("start / stop / scan", () => {
  expect(parseTribalArgs(["start"])).toEqual({ kind: "start" });
  expect(parseTribalArgs(["stop"])).toEqual({ kind: "stop" });
  expect(parseTribalArgs(["scan"])).toEqual({ kind: "scan" });
});

test("list with and without a status filter", () => {
  expect(parseTribalArgs(["list"])).toEqual({ kind: "list" });
  expect(parseTribalArgs(["list", "suggested"])).toEqual({ kind: "list", status: "suggested" });
});

test("dismiss requires a cluster id", () => {
  expect(parseTribalArgs(["dismiss", "k1"])).toEqual({ kind: "dismiss", clusterId: "k1" });
  expect(() => parseTribalArgs(["dismiss"])).toThrow(/dismiss <cluster-id>/);
});

test("capture parses cluster id and optional --target", () => {
  expect(parseTribalArgs(["capture", "k1"])).toEqual({ kind: "capture", clusterId: "k1" });
  expect(parseTribalArgs(["capture", "k1", "--target", "confluence"])).toEqual({
    kind: "capture",
    clusterId: "k1",
    target: "confluence",
  });
  expect(parseTribalArgs(["capture", "k1", "--target", "notion"])).toEqual({
    kind: "capture",
    clusterId: "k1",
    target: "notion",
  });
});

test("capture rejects a missing cluster id or a bad --target", () => {
  expect(() => parseTribalArgs(["capture"])).toThrow(/capture <cluster-id>/);
  expect(() => parseTribalArgs(["capture", "k1", "--target", "jira"])).toThrow(/--target must be/);
});

test("capture fails fast on a second positional or an unknown flag", () => {
  expect(() => parseTribalArgs(["capture", "k1", "k2"])).toThrow(/single <cluster-id>/);
  expect(() => parseTribalArgs(["capture", "k1", "--bogus"])).toThrow(/Unknown option for capture/);
});

test("unknown subcommand throws usage", () => {
  expect(() => parseTribalArgs(["bogus"])).toThrow(/Unknown subcommand/);
});

// --- runTribalCommand (injected-client dispatcher) ---

interface RecordedCall {
  method: string;
  params: unknown;
}

function fakeClient(responses: Record<string, unknown>): {
  client: TribalIpc;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: TribalIpc = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return responses[method] as T;
    },
  };
  return { client, calls };
}

function captureStdio(): {
  out: string[];
  err: string[];
  restore: () => void;
} {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  return {
    out,
    err,
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

afterEach(() => {
  // A capture-failure arm sets process.exitCode = 1; resetting it to 0 here keeps a failing
  // exit code from leaking into the rest of the suite (bun exit-code leak).
  process.exitCode = 0;
});

test("status renders enabled/disabled + singular/plural cluster count", async () => {
  const io = captureStdio();
  try {
    const { client } = fakeClient({
      "tribal.status": { enabled: true, clusters: 1 },
    });
    await runTribalCommand(client, { kind: "status" });
    const { client: c2 } = fakeClient({
      "tribal.status": { enabled: false, clusters: 3 },
    });
    await runTribalCommand(c2, { kind: "status" });
  } finally {
    io.restore();
  }
  expect(io.out[0]).toContain("enabled (1 cluster)");
  expect(io.out[1]).toContain("disabled (3 clusters)");
});

test("start / stop call the gateway and print confirmation", async () => {
  const io = captureStdio();
  let calls: RecordedCall[] = [];
  try {
    const start = fakeClient({ "tribal.start": { ok: true } });
    await runTribalCommand(start.client, { kind: "start" });
    const stop = fakeClient({ "tribal.stop": { ok: true } });
    await runTribalCommand(stop.client, { kind: "stop" });
    calls = [...start.calls, ...stop.calls];
  } finally {
    io.restore();
  }
  expect(calls.map((c) => c.method)).toEqual(["tribal.start", "tribal.stop"]);
  expect(io.out[0]).toContain("started");
  expect(io.out[1]).toContain("stopped");
});

test("list with rows prints each cluster; passes status filter through", async () => {
  const io = captureStdio();
  let calls: RecordedCall[] = [];
  try {
    const { client, calls: c } = fakeClient({
      "tribal.list": [
        {
          clusterId: "k1",
          representativeQuestion: "how to deploy?",
          occurrenceCount: 4,
          status: "suggested",
          channelId: "C1",
        },
      ],
    });
    await runTribalCommand(client, { kind: "list", status: "suggested" });
    calls = c;
  } finally {
    io.restore();
  }
  expect(calls[0]?.params).toEqual({ status: "suggested" });
  expect(io.out[0]).toContain("k1");
  expect(io.out[0]).toContain("×4");
  expect(io.out[0]).toContain("how to deploy?");
});

test("list with no rows prints the empty message and sends no filter", async () => {
  const io = captureStdio();
  let calls: RecordedCall[] = [];
  try {
    const { client, calls: c } = fakeClient({ "tribal.list": [] });
    await runTribalCommand(client, { kind: "list" });
    calls = c;
  } finally {
    io.restore();
  }
  expect(calls[0]?.params).toEqual({});
  expect(io.out[0]).toContain("No clusters.");
});

test("dismiss calls the gateway with the clusterId", async () => {
  const io = captureStdio();
  let calls: RecordedCall[] = [];
  try {
    const { client, calls: c } = fakeClient({ "tribal.dismiss": { ok: true } });
    await runTribalCommand(client, { kind: "dismiss", clusterId: "k9" });
    calls = c;
  } finally {
    io.restore();
  }
  expect(calls[0]).toEqual({ method: "tribal.dismiss", params: { clusterId: "k9" } });
  expect(io.out[0]).toContain("Dismissed k9");
});

test("scan prints the scanned/fired summary", async () => {
  const io = captureStdio();
  try {
    const { client } = fakeClient({ "tribal.scan": { scanned: 7, fired: 2 } });
    await runTribalCommand(client, { kind: "scan" });
  } finally {
    io.restore();
  }
  expect(io.out[0]).toContain("Scanned 7; 2 suggestion(s) fired");
});

test("capture success prints the page ref and sends no target when omitted", async () => {
  const io = captureStdio();
  let calls: RecordedCall[] = [];
  try {
    const { client, calls: c } = fakeClient({
      "tribal.capture": { ok: true, pageRef: "notion:pg1" },
    });
    await runTribalCommand(client, { kind: "capture", clusterId: "k1" });
    calls = c;
  } finally {
    io.restore();
  }
  expect(calls[0]).toEqual({ method: "tribal.capture", params: { clusterId: "k1" } });
  expect(io.out[0]).toContain("Captured k1 → notion:pg1");
  expect(process.exitCode).not.toBe(1);
});

test("capture success without a pageRef falls back to (no ref); forwards the target", async () => {
  const io = captureStdio();
  let calls: RecordedCall[] = [];
  try {
    const { client, calls: c } = fakeClient({ "tribal.capture": { ok: true } });
    await runTribalCommand(client, { kind: "capture", clusterId: "k1", target: "confluence" });
    calls = c;
  } finally {
    io.restore();
  }
  expect(calls[0]?.params).toEqual({ clusterId: "k1", target: "confluence" });
  expect(io.out[0]).toContain("(no ref)");
});

test("capture failure writes to stderr and sets exitCode 1", async () => {
  const io = captureStdio();
  try {
    const { client } = fakeClient({
      "tribal.capture": { ok: false, error: "not_configured" },
    });
    await runTribalCommand(client, { kind: "capture", clusterId: "k1" });
  } finally {
    io.restore();
  }
  expect(io.err[0]).toContain("Capture failed: not_configured");
  expect(process.exitCode).toBe(1);
});

test("capture failure without an error string falls back to 'unknown'", async () => {
  const io = captureStdio();
  try {
    const { client } = fakeClient({ "tribal.capture": { ok: false } });
    await runTribalCommand(client, { kind: "capture", clusterId: "k1" });
  } finally {
    io.restore();
  }
  expect(io.err[0]).toContain("Capture failed: unknown");
  expect(process.exitCode).toBe(1);
});
