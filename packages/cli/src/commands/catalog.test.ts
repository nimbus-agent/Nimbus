import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { runCatalog } from "./catalog.ts";

// Mirrors the gateway's `CatalogListResult` wire shape (declared here: the CLI never imports
// gateway source).
const RESULT = {
  agents: [
    {
      name: "catchup",
      displayName: "Catch-up",
      description: "What happened across your connected services over a window.",
      category: "catch-up",
      roles: ["engineer", "manager"],
      params: [{ name: "sinceMs", kind: "number", label: "Since (ms)", required: false }],
      method: "agents.catchup",
      surfaces: { external: true, fleet: true },
      visible: true,
    },
    {
      name: "decisions",
      displayName: "Decisions",
      description: "Decisions recovered from messages, pages and issues.",
      category: "knowledge",
      roles: ["engineer", "manager"],
      params: [],
      method: "agents.decisions",
      surfaces: { external: true, fleet: true },
      visible: false,
    },
  ],
  connectors: [
    {
      kind: "builtin",
      id: "github",
      displayName: "GitHub",
      category: "code",
      description: "A code hosting and collaboration platform built on Git",
    },
    {
      kind: "extension",
      id: "ext1",
      serviceId: "ext_x",
      name: "evil\u001b[2Jname",
      category: "extension",
    },
    { kind: "extension", id: "ext2", serviceId: null, name: null, category: "extension" },
    { kind: "user-mcp", id: "mcp_a", name: "mcp_a", category: "user-mcp" },
  ],
  visibility: {
    basis: "all",
    packs: [],
    notes: ["agent visibility: all agents (no active pack sets [agents] visible)"],
  },
};

describe("runCatalog", () => {
  const out = captureOutput();
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
    const mock = createMockIpcClient([RESULT]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });
  afterAll(() => {
    out.restore();
  });

  test("prints hidden agents as hidden", async () => {
    await runCatalog(["agents"]);
    expect(out.stdout).toMatch(/decisions\s+hidden\s+knowledge/);
    expect(out.stdout).toMatch(/catchup\s+shown\s+catch-up/);
    expect(out.stdout.indexOf("agent visibility: all agents")).toBeLessThan(
      out.stdout.indexOf("catchup"),
    );
    expect(out.stdout).not.toContain("more visibility note");
  });

  test("names how many further visibility notes there are", async () => {
    const many = {
      ...RESULT,
      visibility: {
        basis: "all",
        packs: [],
        notes: [
          "agent visibility: all agents (no active pack sets [agents] visible)",
          'agent "decisions" is hidden by base',
          'unknown agent "standpu" in base [agents] hide',
        ],
      },
    };
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: createMockIpcClient([many]).client,
    });
    await runCatalog(["agents"]);
    expect(out.stdout).toContain("2 more visibility note(s); see nimbus config explain agents");
    expect(out.stdout).not.toContain("standpu");
    expect(out.stdout.indexOf("2 more visibility")).toBeLessThan(out.stdout.indexOf("catchup"));
  });

  test("--json prints only the requested half", async () => {
    await runCatalog(["agents", "--json"]);
    const a = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(Object.keys(a).sort()).toEqual(["agents", "visibility"]);
    out.reset();
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: createMockIpcClient([RESULT]).client,
    });
    await runCatalog(["connectors", "--json"]);
    const c = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(Object.keys(c)).toEqual(["connectors"]);
  });

  test("--json with no subcommand prints agents, connectors and visibility", async () => {
    await runCatalog(["--json"]);
    const r = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual(["agents", "connectors", "visibility"]);
  });

  test("strips control characters from an extension name", async () => {
    await runCatalog(["connectors"]);
    expect(out.stdout).toContain("evil");
    expect(out.stdout).not.toContain("\u001b");
    expect(out.stdout).toContain("(no name)");
  });

  test("unknown subcommand exits 1", async () => {
    await runCatalog(["bogus"]);
    expect(process.exitCode).toBe(1);
    expect(out.stderr + out.stdout).toContain("nimbus catalog");
  });
});
