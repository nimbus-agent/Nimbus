import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const { runConnector } = await import("./connector.ts");

const out = captureOutput();

afterAll(() => {
  out.restore();
});

function fixtureWith(responses: ReadonlyArray<unknown>) {
  const ipc = createMockIpcClient(responses);
  setFixture({
    gatewayState: { socketPath: FAKE_SOCKET_PATH },
    ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
  });
  return ipc;
}

// The dispatcher in `connector.ts` hands each subcommand to its own module; these cases pin that
// the `tools`, `call` and `migrate` arms are wired to the gateway methods those modules call.
describe("runConnector dispatcher arms", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("routes `tools` to connector.userMcpTools", async () => {
    const ipc = fixtureWith([{ tools: [{ name: "echo", description: "Echo back" }] }]);
    await runConnector(["tools", "mcp_echo"]);
    expect(ipc.calls[0]).toEqual({
      method: "connector.userMcpTools",
      params: { serviceId: "mcp_echo" },
    });
    expect(out.stdout).toContain("echo — Echo back");
  });

  it("routes `call` to connector.userMcpCall", async () => {
    const ipc = fixtureWith([{ status: "ok", result: { content: "pong" } }]);
    await runConnector(["call", "mcp_echo", "echo", "--json"]);
    expect(ipc.calls[0]?.method).toBe("connector.userMcpCall");
    expect(ipc.calls[0]?.params).toEqual({ serviceId: "mcp_echo", tool: "echo" });
  });

  it("routes `migrate` to migration.list", async () => {
    const ipc = fixtureWith([{ migrations: [] }]);
    await runConnector(["migrate", "list", "--json"]);
    expect(ipc.calls[0]?.method).toBe("migration.list");
    expect(out.stdout).toContain("[]");
  });
});
