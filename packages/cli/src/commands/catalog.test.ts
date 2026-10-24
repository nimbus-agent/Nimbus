import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { runCatalog } from "./catalog.ts";

const RESULT = {
  agents: [
    {
      name: "catchup",
      displayName: "Catch up",
      description: "What changed while you were away.",
      category: "activity",
      roles: [],
      visible: true,
      surfaces: ["cli"],
      params: [],
      method: "agents.catchup",
    },
    {
      name: "decisions",
      displayName: "Decisions",
      description: "Recorded decisions.",
      category: "knowledge",
      roles: [],
      visible: false,
      surfaces: ["cli"],
      params: [],
      method: "agents.decisions",
    },
  ],
  connectors: [
    {
      kind: "builtin",
      id: "github",
      displayName: "GitHub",
      category: "code",
      description: "Code hosting.",
    },
    {
      kind: "extension",
      id: "ext1",
      serviceId: "ext_x",
      name: "evil\u001b[2Jname",
      category: "extension",
    },
    { kind: "extension", id: "ext2", serviceId: null, name: null, category: "extension" },
    { kind: "user-mcp", id: "mcp_a", name: "mine", category: "user-mcp" },
  ],
  visibility: { basis: "all", packs: [], notes: ["Showing all agents (no pack)."] },
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
    expect(out.stdout).toMatch(/catchup\s+shown\s+activity/);
    expect(out.stdout.indexOf("Showing all agents")).toBeLessThan(out.stdout.indexOf("catchup"));
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
