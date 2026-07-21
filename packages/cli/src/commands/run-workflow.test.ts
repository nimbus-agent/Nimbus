import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const mod = await import("./run-workflow.ts");
const { runWorkflowFromFile, runWorkflowFromFileWithClient } = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runWorkflowFromFileWithClient", () => {
  let tmpDir: string;

  beforeEach(() => {
    out.reset();
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-run-wf-test-"));
  });
  afterEach(() => {
    clearFixture();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves then runs the workflow with stream:true by default", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "ship",
        description: "demo",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }, { runId: 1 }]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: false,
      agent: undefined,
    });
    expect(ipc.calls).toHaveLength(2);
    expect(ipc.calls[0]?.method).toBe("workflow.save");
    expect(ipc.calls[1]?.method).toBe("workflow.run");
    expect(ipc.calls[1]?.params).toMatchObject({
      name: "ship",
      stream: true,
      dryRun: false,
    });
  });

  it("--dry-run flips stream:false + dryRun:true on the run call", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "ship",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }, { runId: 2 }]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: true,
      noTtv: false,
      agent: undefined,
    });
    expect(ipc.calls[1]?.params).toMatchObject({ stream: false, dryRun: true });
  });

  it("--no-ttv adds a preview call; passes when no hitlActions are flagged", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "ship",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([
      { ok: true }, // save
      { stepResults: [{ hitlActions: [] }] }, // preview
      { runId: 3 }, // run
    ]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: true,
      agent: undefined,
    });
    expect(ipc.calls).toHaveLength(3);
    expect(ipc.calls[1]?.params).toMatchObject({ dryRun: true });
    expect(ipc.calls[2]?.params).toMatchObject({ dryRun: false });
  });

  it("--no-ttv throws when the preview returns hitlActions", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "ship",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([
      { ok: true },
      { stepResults: [{ hitlActions: ["github.deploy"] }] },
    ]);
    await expect(
      runWorkflowFromFileWithClient(ipc.client, file, {
        dryRun: false,
        noTtv: true,
        agent: undefined,
      }),
    ).rejects.toThrow(/human approval \(HITL\)/);
  });

  it("includes the agent param when provided", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "ship",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }, { runId: 4 }]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: false,
      agent: "devops",
    });
    expect((ipc.calls[1]?.params as Record<string, unknown> | undefined)?.["agent"]).toBe("devops");
  });

  it("omits description from workflow.save when the file has none", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "ship",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }, { runId: 5 }]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: false,
      agent: undefined,
    });
    const saveParams = ipc.calls[0]?.params as Record<string, unknown>;
    expect(saveParams).not.toHaveProperty("description");
  });
});

describe("runWorkflowFromFile (dispatcher)", () => {
  let tmpDir: string;

  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-run-wf-disp-"));
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when file argument is missing", async () => {
    await expect(runWorkflowFromFile([])).rejects.toThrow("Usage: nimbus run");
  });

  it("throws when file argument is whitespace only", async () => {
    await expect(runWorkflowFromFile(["   "])).rejects.toThrow("Usage: nimbus run");
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runWorkflowFromFile(["/tmp/some-wf.json"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("connects to gateway and runs the workflow when gateway is running", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "dispatch-test",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }, { runId: 99 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: {
        call: ipc.client.call,
        connect: ipc.client.connect,
        disconnect: ipc.client.disconnect,
        onNotification: ipc.client.onNotification,
      },
    });
    await runWorkflowFromFile([file]);
    expect(ipc.calls[0]?.method).toBe("workflow.save");
    expect(ipc.calls[1]?.method).toBe("workflow.run");
    expect(out.stdout).toContain("runId");
  });

  it("passes --dry-run flag via parseRunFlags to the impl", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "dry-dispatch",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }, { runId: 100 }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: {
        call: ipc.client.call,
        connect: ipc.client.connect,
        disconnect: ipc.client.disconnect,
        onNotification: ipc.client.onNotification,
      },
    });
    await runWorkflowFromFile([file, "--dry-run"]);
    expect(ipc.calls[1]?.params).toMatchObject({ dryRun: true, stream: false });
  });

  it("passes --no-ttv flag and --agent via parseRunFlags to the impl", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "no-ttv-dispatch",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([
      { ok: true }, // save
      { stepResults: [] }, // preview (no hitl)
      { runId: 101 }, // run
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: {
        call: ipc.client.call,
        connect: ipc.client.connect,
        disconnect: ipc.client.disconnect,
        onNotification: ipc.client.onNotification,
      },
    });
    await runWorkflowFromFile([file, "--no-ttv", "--agent", "research"]);
    expect(ipc.calls).toHaveLength(3);
    expect(ipc.calls[1]?.params).toMatchObject({ dryRun: true });
    const runParams = ipc.calls[2]?.params as Record<string, unknown>;
    expect(runParams["agent"]).toBe("research");
  });

  it("disconnects client even when the impl throws", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "fail-dispatch",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([new Error("IPC save failed")]);
    let disconnected = false;
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH, pid: 42 },
      ipcClient: {
        call: ipc.client.call,
        connect: ipc.client.connect,
        disconnect: async (): Promise<void> => {
          disconnected = true;
        },
        onNotification: ipc.client.onNotification,
      },
    });
    await expect(runWorkflowFromFile([file])).rejects.toThrow("IPC save failed");
    expect(disconnected).toBe(true);
  });
});

describe("runWorkflowFromFileWithClient — edge-case branches", () => {
  let tmpDir: string;

  beforeEach(() => {
    out.reset();
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-run-wf-edge-"));
  });
  afterEach(() => {
    clearFixture();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--no-ttv: handles preview response without stepResults (undefined ?? [])", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "no-step-results",
        steps: [{ kind: "noop" }],
      }),
    );
    // The preview returns an empty object (no stepResults field) — ?? [] should produce empty array
    const ipc = createMockIpcClient([
      { ok: true }, // save
      {}, // preview: no stepResults key → ?? [] → no hitl → proceed
      { runId: 200 }, // run
    ]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: true,
      agent: undefined,
    });
    expect(ipc.calls).toHaveLength(3);
    expect(ipc.calls[2]?.method).toBe("workflow.run");
  });

  it("--no-ttv: step without hitlActions field is not flagged (?.length ?? 0 == 0)", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "no-hitl-field",
        steps: [{ kind: "noop" }],
      }),
    );
    // Step has no hitlActions property — hitlActions?.length ?? 0 should be 0
    const ipc = createMockIpcClient([
      { ok: true }, // save
      { stepResults: [{ name: "step-without-hitlActions" }] }, // no hitlActions key
      { runId: 201 }, // run
    ]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: true,
      agent: undefined,
    });
    expect(ipc.calls).toHaveLength(3);
  });

  it("omits agent from payload when agent is undefined (not the empty-string path)", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(file, JSON.stringify({ name: "no-agent", steps: [{ kind: "noop" }] }));
    const ipc = createMockIpcClient([{ ok: true }, { runId: 202 }]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: false,
      agent: undefined,
    });
    const runParams = ipc.calls[1]?.params as Record<string, unknown>;
    expect(runParams).not.toHaveProperty("agent");
  });

  it("omits agent from payload when agent is empty string", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(file, JSON.stringify({ name: "empty-agent", steps: [{ kind: "noop" }] }));
    const ipc = createMockIpcClient([{ ok: true }, { runId: 203 }]);
    // agent="" is the guard inside buildWorkflowRunPayload: agent !== undefined && agent !== ""
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: false,
      agent: "",
    });
    const runParams = ipc.calls[1]?.params as Record<string, unknown>;
    expect(runParams).not.toHaveProperty("agent");
  });

  it("logs stringified JSON result to stdout after run", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(file, JSON.stringify({ name: "log-check", steps: [{ kind: "noop" }] }));
    const ipc = createMockIpcClient([{ ok: true }, { status: "completed", runId: 204 }]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: false,
      noTtv: false,
      agent: undefined,
    });
    expect(out.stdout).toContain('"status": "completed"');
    expect(out.stdout).toContain('"runId": 204');
  });

  it("--no-ttv is skipped when dryRun is also true (noTtv && !dryRun is false)", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(file, JSON.stringify({ name: "dry-no-ttv", steps: [{ kind: "noop" }] }));
    // noTtv=true AND dryRun=true → the preview call is skipped (only 2 IPC calls)
    const ipc = createMockIpcClient([{ ok: true }, { runId: 205 }]);
    await runWorkflowFromFileWithClient(ipc.client, file, {
      dryRun: true,
      noTtv: true,
      agent: undefined,
    });
    expect(ipc.calls).toHaveLength(2);
    expect(ipc.calls[0]?.method).toBe("workflow.save");
    expect(ipc.calls[1]?.method).toBe("workflow.run");
    expect(ipc.calls[1]?.params).toMatchObject({ dryRun: true, stream: false });
  });

  it("stops before the real run when a --no-ttv preview surfaces HITL actions", async () => {
    const file = join(tmpDir, "wf.json");
    writeFileSync(file, JSON.stringify({ name: "hitl-gated", steps: [{ kind: "noop" }] }));
    // save → preview (workflow.run, preview=true) returns a step WITH hitlActions, so the
    // HITL gate must throw and NEVER issue the real workflow.run.
    const ipc = createMockIpcClient([
      { ok: true }, // workflow.save
      { stepResults: [{ name: "risky", hitlActions: ["data.export"] }] }, // preview: flagged
    ]);
    await expect(
      runWorkflowFromFileWithClient(ipc.client, file, {
        dryRun: false,
        noTtv: true,
        agent: undefined,
      }),
    ).rejects.toThrow(/human approval \(HITL\)/);
    // Safety contract: only save + preview ran — the real run was never called.
    expect(ipc.calls).toHaveLength(2);
    expect(ipc.calls[0]?.method).toBe("workflow.save");
    expect(ipc.calls[1]?.method).toBe("workflow.run"); // the preview call, not the real run
  });
});
