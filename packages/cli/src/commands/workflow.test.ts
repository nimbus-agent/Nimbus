import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearFixture,
  FAKE_SOCKET_PATH,
  type RecordedClientConstruction,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";

const mod = await import("./workflow.ts");
const { runWorkflowCli, runWorkflowList, runWorkflowDelete, runWorkflowSave, runWorkflowRun } = mod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runWorkflowList", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls workflow.list and prints the response", async () => {
    const ipc = createMockIpcClient([{ workflows: [{ name: "deploy" }] }]);
    await runWorkflowList(ipc.client);
    expect(ipc.calls[0]).toEqual({ method: "workflow.list", params: {} });
    expect(out.stdout).toContain('"deploy"');
  });
});

describe("runWorkflowDelete", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when name is missing", async () => {
    const ipc = createMockIpcClient([]);
    await expect(runWorkflowDelete(ipc.client, [])).rejects.toThrow(
      "Usage: nimbus workflow delete <name>",
    );
  });

  it("calls workflow.delete with the trimmed name and prints the response", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWorkflowDelete(ipc.client, ["  deploy  "]);
    expect(ipc.calls[0]).toEqual({ method: "workflow.delete", params: { name: "deploy" } });
    expect(out.stdout).toContain('"ok": true');
  });
});

describe("runWorkflowSave", () => {
  let tmpDir: string;

  beforeEach(() => {
    out.reset();
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-wf-test-"));
  });
  afterEach(() => {
    clearFixture();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws when name or --file is missing", async () => {
    const ipc = createMockIpcClient([]);
    await expect(runWorkflowSave(ipc.client, [])).rejects.toThrow("Usage: nimbus workflow save");
    await expect(runWorkflowSave(ipc.client, ["deploy"])).rejects.toThrow(
      "Usage: nimbus workflow save",
    );
  });

  it("reads a workflow JSON file and calls workflow.save", async () => {
    const file = join(tmpDir, "deploy.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "deploy",
        description: "ship it",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWorkflowSave(ipc.client, ["deploy", "--file", file]);
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0]?.method).toBe("workflow.save");
    const params = ipc.calls[0]?.params as Record<string, unknown>;
    expect(params["name"]).toBe("deploy");
    expect(params["description"]).toBe("ship it");
    expect(typeof params["stepsJson"]).toBe("string");
  });

  it("warns when CLI name and file name differ", async () => {
    const file = join(tmpDir, "deploy.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "file-says-this",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWorkflowSave(ipc.client, ["cli-says-that", "--file", file]);
    expect(out.stderr).toContain("file-says-this");
    expect(out.stderr).toContain("cli-says-that");
    const params = ipc.calls[0]?.params as Record<string, unknown>;
    expect(params["name"]).toBe("cli-says-that");
  });

  it("CLI --description overrides the file description", async () => {
    const file = join(tmpDir, "deploy.json");
    writeFileSync(
      file,
      JSON.stringify({
        name: "deploy",
        description: "from file",
        steps: [{ kind: "noop" }],
      }),
    );
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWorkflowSave(ipc.client, ["deploy", "--file", file, "--description", "from CLI"]);
    const params = ipc.calls[0]?.params as Record<string, unknown>;
    expect(params["description"]).toBe("from CLI");
  });
});

describe("runWorkflowRun", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when name is missing", async () => {
    const ipc = createMockIpcClient([]);
    await expect(runWorkflowRun(ipc.client, [])).rejects.toThrow("Usage: nimbus workflow run");
  });

  it("calls workflow.run with stream:true and dryRun:false by default", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWorkflowRun(ipc.client, ["deploy"]);
    expect(ipc.calls[0]).toEqual({
      method: "workflow.run",
      params: { name: "deploy", stream: true, dryRun: false },
    });
  });

  it("sets dryRun:true and stream:false under --dry-run", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWorkflowRun(ipc.client, ["deploy", "--dry-run"]);
    expect(ipc.calls[0]?.params).toMatchObject({ dryRun: true, stream: false });
  });

  it("includes the agent flag when --agent is set", async () => {
    const ipc = createMockIpcClient([{ ok: true }]);
    await runWorkflowRun(ipc.client, ["deploy", "--agent", "devops"]);
    const params = ipc.calls[0]?.params as Record<string, unknown>;
    expect(params["agent"]).toBe("devops");
  });

  it("--no-ttv issues a dry-run preview first; passes when no hitlActions are flagged", async () => {
    const ipc = createMockIpcClient([{ stepResults: [{ hitlActions: [] }] }, { ok: true }]);
    await runWorkflowRun(ipc.client, ["deploy", "--no-ttv"]);
    expect(ipc.calls).toHaveLength(2);
    expect(ipc.calls[0]?.params).toMatchObject({ dryRun: true });
    expect(ipc.calls[1]?.params).toMatchObject({ dryRun: false });
  });

  it("--no-ttv throws when preview shows HITL actions", async () => {
    const ipc = createMockIpcClient([{ stepResults: [{ hitlActions: ["github.deploy"] }] }]);
    await expect(runWorkflowRun(ipc.client, ["deploy", "--no-ttv"])).rejects.toThrow(
      /human approval \(HITL\)/,
    );
  });
});

describe("runWorkflowCli (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runWorkflowCli(["list"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("throws on unknown subcommand", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runWorkflowCli(["bogus"])).rejects.toThrow("Usage: nimbus workflow");
  });

  it("routes 'list' through IPC when gateway is running", async () => {
    const ipc = createMockIpcClient([{ workflows: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWorkflowCli(["list"]);
    expect(ipc.calls[0]?.method).toBe("workflow.list");
  });

  it("routes empty args to 'list'", async () => {
    const ipc = createMockIpcClient([{ workflows: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWorkflowCli([]);
    expect(ipc.calls[0]?.method).toBe("workflow.list");
  });

  // A workflow step can trip a HITL gate, and the Gateway then blocks on
  // `consent.respond`. Without a `consent.request` handler this command hung to the
  // client timeout without ever prompting the user — the failure mode
  // `interactive-ipc-handlers.ts` documents.
  it("registers a consent.request handler for 'run', so a HITL step can be approved", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const ipc = createMockIpcClient([{ ok: true }], handlers);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
        onNotification: ipc.client.onNotification,
      },
    });
    await runWorkflowCli(["run", "deploy"]);
    expect(handlers.has("consent.request")).toBe(true);
  });

  it("still streams agent chunks for 'run'", async () => {
    // The consent handler was added ALONGSIDE the chunk handler, not instead of it.
    const handlers = new Map<string, (params: unknown) => void>();
    const ipc = createMockIpcClient([{ ok: true }], handlers);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
        onNotification: ipc.client.onNotification,
      },
    });
    await runWorkflowCli(["run", "deploy"]);
    expect(handlers.has("agent.chunk")).toBe(true);
  });

  it("gives 'run' the interactive budget and leaves 'list' on the tight default", async () => {
    const runConstructions: RecordedClientConstruction[] = [];
    const runIpc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: runConstructions,
      ipcClient: { call: runIpc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWorkflowCli(["run", "deploy"]);
    expect(runConstructions[0]?.opts).toEqual({ requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS });

    const listConstructions: RecordedClientConstruction[] = [];
    const listIpc = createMockIpcClient([{ workflows: [] }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: listConstructions,
      ipcClient: { call: listIpc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWorkflowCli(["list"]);
    expect(listConstructions[0]?.opts).toBeUndefined();
  });
});
