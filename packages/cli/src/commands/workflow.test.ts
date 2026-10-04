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

/** Yield a macrotask so every pending microtask chain (connect → call → handler) settles. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

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

  it("--no-ttv --agent previews AND runs under that agent", async () => {
    // The preview must be asked of the SAME agent the run will use: a preview under the default
    // agent could report no HITL step for a workflow the chosen agent would gate.
    const ipc = createMockIpcClient([{ stepResults: [] }, { ok: true }]);
    await runWorkflowRun(ipc.client, ["deploy", "--no-ttv", "--agent", "research"]);
    expect(ipc.calls).toEqual([
      {
        method: "workflow.run",
        params: { name: "deploy", stream: false, dryRun: true, agent: "research" },
      },
      {
        method: "workflow.run",
        params: { name: "deploy", stream: true, dryRun: false, agent: "research" },
      },
    ]);
  });

  it("--no-ttv treats a preview with no stepResults as nothing flagged, and runs", async () => {
    const ipc = createMockIpcClient([{}, { ok: true }]);
    await runWorkflowRun(ipc.client, ["deploy", "--no-ttv"]);
    expect(ipc.calls.map((c) => (c.params as { dryRun: boolean }).dryRun)).toEqual([true, false]);
  });

  it("--no-ttv treats a step that carries no hitlActions field as unflagged", async () => {
    const ipc = createMockIpcClient([{ stepResults: [{}, { hitlActions: [] }] }, { ok: true }]);
    await runWorkflowRun(ipc.client, ["deploy", "--no-ttv"]);
    expect(ipc.calls.map((c) => (c.params as { dryRun: boolean }).dryRun)).toEqual([true, false]);
    expect(out.stdout).toContain('"ok": true');
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

  it("routes 'delete' through IPC on the tight default budget", async () => {
    const constructions: RecordedClientConstruction[] = [];
    const ipc = createMockIpcClient([{ ok: true }]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clientConstructions: constructions,
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runWorkflowCli(["delete", "deploy"]);
    expect(ipc.calls).toEqual([{ method: "workflow.delete", params: { name: "deploy" } }]);
    expect(out.stdout).toContain('"ok": true');
    // Only `run` gets the interactive budget — a delete is a fast RPC.
    expect(constructions).toHaveLength(1);
    expect(constructions[0]?.opts).toBeUndefined();
  });

  it("routes 'save' through IPC on the tight default budget, reading --file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-wf-cli-save-"));
    try {
      const file = join(dir, "deploy.json");
      writeFileSync(file, JSON.stringify({ name: "deploy", steps: [{ kind: "noop" }] }));
      const constructions: RecordedClientConstruction[] = [];
      const ipc = createMockIpcClient([{ saved: "deploy" }]);
      setFixture({
        gatewayState: { socketPath: FAKE_SOCKET_PATH },
        clientConstructions: constructions,
        ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
      });
      await runWorkflowCli(["save", "deploy", "--file", file]);
      // `stepsJson` is the file's PARSED steps array, re-serialised — never the raw file body.
      // With no description in the file and none on the CLI the key is absent, never `null` or
      // `undefined` (toStrictEqual tells an undefined-valued key from a missing one).
      expect(ipc.calls).toStrictEqual([
        { method: "workflow.save", params: { name: "deploy", stepsJson: '[{"kind":"noop"}]' } },
      ]);
      expect(out.stdout).toContain('"saved": "deploy"');
      expect(constructions).toHaveLength(1);
      expect(constructions[0]?.opts).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("answers consent WHILE workflow.run is still in flight", async () => {
    // The ordering the Gateway's gate requires: a HITL step raises `consent.request`
    // from inside the pending `workflow.run` and blocks on `consent.respond`, so the
    // approval has to reach it before the call resolves — not merely at some point.
    const handlers = new Map<string, (params: unknown) => void>();
    let releaseRun = (): void => {};
    const runPending = new Promise<{ ok: boolean }>((resolve) => {
      releaseRun = () => {
        resolve({ ok: true });
      };
    });
    const ipc = createMockIpcClient([runPending, { ok: true }], handlers);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clackAnswer: true,
      ipcClient: {
        call: ipc.client.call,
        connect: () => {},
        disconnect: () => {},
        onNotification: ipc.client.onNotification,
      },
    });

    const done = runWorkflowCli(["run", "deploy"]);
    await flush();
    expect(ipc.calls.map((c) => c.method)).toEqual(["workflow.run"]);

    handlers.get("consent.request")?.({ requestId: "req-1", prompt: "Deploy to prod?" });
    await flush();

    // Approved before the gated run resolved.
    expect(ipc.calls.find((c) => c.method === "consent.respond")?.params).toEqual({
      requestId: "req-1",
      approved: true,
    });

    releaseRun();
    await done;
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
