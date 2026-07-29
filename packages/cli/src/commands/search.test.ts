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
      ipcClient: mock.client,
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
      ipcClient: mock.client,
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
      ipcClient: mock.client,
    });
    await runSearch(["hi", "--limit", "9999"]);
    expect(mock.calls[0]?.params).toMatchObject({ limit: 500 });
  });

  it("recovers default limit when --limit value is non-numeric", async () => {
    const mock = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
    });
    await runSearch(["hi", "--limit", "notanumber"]);
    expect(mock.calls[0]?.params).toMatchObject({ limit: 20 });
  });

  it("supports the short-form -n / -s / -t aliases", async () => {
    const mock = createMockIpcClient([[]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: mock.client,
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
      ipcClient: mock.client,
    });
    await runSearch(["x"]);
    expect(out.stdout).toContain('"id": "github:pr_1"');
    expect(out.stdout).toContain('"title": "Foo"');
    expect(out.stdout).toContain('"title": "Bar"');
  });
});

// #928 made the gateway bind BEFORE the embedding model loads, so a semantic
// search on a cold machine gets JSON-RPC -32021 instead of results. The CLI had
// no handler, so `nimbus search` on a first run printed a raw JSON-RPC error —
// the exact first-run papercut #928 set out to remove.
describe("runSearch — embedding warm-up", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  const warmingError = (): Error =>
    new Error(
      "index.searchRanked: the embedding runtime is still warming up (Xenova/all-MiniLM-L6-v2, 4s). " +
        "Semantic results are not available yet; retry shortly, or re-run without semantic search " +
        "to get keyword-only matches.",
    );

  it("falls back to keyword-only results when the runtime is warming", async () => {
    const mock = createMockIpcClient([
      warmingError(),
      { embedding: { state: "warming" } },
      [{ id: "github:pr_1", title: "My PR" }],
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });

    await runSearch(["hello"]);

    expect(mock.calls.map((c) => c.method)).toEqual([
      "index.searchRanked",
      "gateway.ping",
      "index.searchRanked",
    ]);
    // The retry must actually drop semantic, or the gateway just throws again.
    expect(mock.calls[2]?.params).toMatchObject({ name: "hello", semantic: false });
    expect(out.stdout).toContain("My PR");
  });

  it("puts the warm-up notice on stderr so stdout stays valid JSON", async () => {
    const mock = createMockIpcClient([
      warmingError(),
      { embedding: { state: "warming" } },
      [{ id: "a", title: "T" }],
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });

    await runSearch(["hello"]);

    expect(out.stderr).toMatch(/warming up/);
    expect(out.stdout).not.toMatch(/warming up/);
    // The whole point of stderr: `nimbus search ... | jq` must still parse.
    expect(() => JSON.parse(out.stdout) as unknown).not.toThrow();
  });

  it("rethrows the ORIGINAL error when the runtime is not warming", async () => {
    const mock = createMockIpcClient([
      new Error("index.searchRanked: database is locked"),
      { embedding: { state: "ready" } },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });

    await expect(runSearch(["hello"])).rejects.toThrow(/database is locked/);
  });

  it("rethrows the original error when the ping itself fails", async () => {
    // The ping is a diagnostic. Its failure must never replace the real error.
    const mock = createMockIpcClient([
      new Error("index.searchRanked: database is locked"),
      new Error("socket closed"),
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });

    await expect(runSearch(["hello"])).rejects.toThrow(/database is locked/);
  });

  it("does not ping at all for a keyword-only search", async () => {
    // --no-semantic can never trip the warming gate, so there is nothing to recover.
    const mock = createMockIpcClient([new Error("index.searchRanked: boom")]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });

    await expect(runSearch(["hello", "--no-semantic"])).rejects.toThrow(/boom/);
    expect(mock.calls.map((c) => c.method)).toEqual(["index.searchRanked"]);
  });

  it("rethrows when ping omits the embedding block entirely", async () => {
    // `gateway.ping` builds its embedding fields from an OPTIONAL
    // `getEmbeddingStatus` hook (inline-handlers.ts: `?.() ?? {}`), so a gateway
    // with embeddings unwired answers with no `embedding` key at all. That must
    // read as "not warming", not crash on the optional chain.
    const mock = createMockIpcClient([
      new Error("index.searchRanked: database is locked"),
      { version: "1.5.0", uptime: 42 },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });

    await expect(runSearch(["hello"])).rejects.toThrow(/database is locked/);
  });

  it("adds no extra round-trip on the happy path", async () => {
    const mock = createMockIpcClient([[{ id: "x", title: "Y" }]]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });

    await runSearch(["hello"]);

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe("index.searchRanked");
  });
});
