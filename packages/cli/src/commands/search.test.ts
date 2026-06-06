import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const searchMod = await import("./search.ts");
const { runSearch } = searchMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runSearch — validation", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws usage when no query is provided", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runSearch([])).rejects.toThrow(/Usage: nimbus search/);
  });

  it("throws on unknown flag", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runSearch(["--unknown-flag", "foo"])).rejects.toThrow(/Unknown flag/);
  });

  it("throws when gateway is not running", async () => {
    setFixture({});
    await expect(runSearch(["hello"])).rejects.toThrow(
      /Gateway is not running \(start with: nimbus start\)/,
    );
  });
});

describe("runSearch — dispatcher", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls index.searchRanked with default flags (limit=20, semantic=true)", async () => {
    const mock = createMockIpcClient([[{ id: "github:pr_1", title: "My PR" }]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSearch(["hello", "world"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "index.searchRanked",
      params: { name: "hello world", limit: 20, semantic: true, contextChunks: 2 },
    });
    expect(out.stdout).toContain("My PR");
  });

  it("honours --limit / --semantic / --service / --type", async () => {
    const mock = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSearch([
      "deploy",
      "--limit",
      "50",
      "--service",
      "github",
      "--type",
      "pr",
      "--no-semantic",
    ]);
    expect(mock.calls[0]?.params).toEqual({
      name: "deploy",
      limit: 50,
      semantic: false,
      contextChunks: 2,
      service: "github",
      itemType: "pr",
    });
  });

  it("clamps --limit to [1, 500]", async () => {
    const mock = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSearch(["hi", "--limit", "9999"]);
    expect(mock.calls[0]?.params).toMatchObject({ limit: 500 });
  });

  it("recovers default limit when --limit value is non-numeric", async () => {
    const mock = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSearch(["hi", "--limit", "notanumber"]);
    expect(mock.calls[0]?.params).toMatchObject({ limit: 20 });
  });

  it("supports the short-form -n / -s / -t aliases", async () => {
    const mock = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSearch(["topic", "-n", "5", "-s", "slack", "-t", "message"]);
    expect(mock.calls[0]?.params).toEqual({
      name: "topic",
      limit: 5,
      semantic: true,
      contextChunks: 2,
      service: "slack",
      itemType: "message",
    });
  });

  it("prints rows as JSON", async () => {
    const mock = createMockIpcClient([
      [
        { id: "github:pr_1", title: "Foo" },
        { id: "github:pr_2", title: "Bar" },
      ],
    ]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runSearch(["x"]);
    expect(out.stdout).toContain('"id": "github:pr_1"');
    expect(out.stdout).toContain('"title": "Foo"');
    expect(out.stdout).toContain('"title": "Bar"');
  });
});
