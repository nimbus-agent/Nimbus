// packages/cli/src/commands/run-workflow.test.ts

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts"; // module-load side effects only
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
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
    expect((ipc.calls[1]?.params as Record<string, unknown>)["agent"]).toBe("devops");
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
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when file argument is missing", async () => {
    await expect(runWorkflowFromFile([])).rejects.toThrow("Usage: nimbus run");
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runWorkflowFromFile(["/tmp/some-wf.json"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });
});
