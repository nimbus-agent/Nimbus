import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const queryMod = await import("./query.ts");
const { runQuery } = queryMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runQuery — help & validation", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints usage when called with no args", async () => {
    await runQuery([]);
    expect(out.stdout).toContain("nimbus query");
    expect(out.stdout).toContain("--service");
    expect(out.stdout).toContain("--sql");
  });

  it("prints usage for 'help' / '--help' / '-h'", async () => {
    await runQuery(["help"]);
    expect(out.stdout).toContain("nimbus query");
    out.reset();
    await runQuery(["--help"]);
    expect(out.stdout).toContain("nimbus query");
    out.reset();
    await runQuery(["-h"]);
    expect(out.stdout).toContain("nimbus query");
  });

  it("throws when neither --service nor --sql is provided", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runQuery(["--type", "pr"])).rejects.toThrow(/Missing --service/);
  });

  it("throws when gateway is not running for an --sql path", async () => {
    setFixture({});
    await expect(runQuery(["--sql", "SELECT 1"])).rejects.toThrow(
      /Gateway is not running\. Start with: nimbus start/,
    );
  });

  it("throws when gateway is not running for a --service path", async () => {
    setFixture({});
    await expect(runQuery(["--service", "github"])).rejects.toThrow(
      /Gateway is not running\. Start with: nimbus start/,
    );
  });
});

describe("runQuery — --sql path", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls index.querySql with the supplied sql and prints JSON when --json", async () => {
    const mock = createMockIpcClient([{ rows: [{ id: 1, title: "hi" }], meta: { count: 1 } }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runQuery(["--sql", "SELECT * FROM items", "--json"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "index.querySql",
      params: { sql: "SELECT * FROM items" },
    });
    expect(out.stdout).toContain('"id": 1');
    expect(out.stdout).toContain('"title": "hi"');
  });
});

describe("runQuery — --service path", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls index.queryItems with services + clamped limit; renders --json", async () => {
    const mock = createMockIpcClient([
      {
        items: [{ title: "foo", service: "github", type: "pr", modified_at: 1700000000000 }],
        meta: { limit: 50, total: 1 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runQuery(["--service", "github", "--limit", "5000", "--json"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]).toEqual({
      method: "index.queryItems",
      params: { services: ["github"], limit: 1000 }, // clamped from 5000 → 1000
    });
    expect(out.stdout).toContain('"title": "foo"');
  });

  it("includes types + sinceMs when --type and --since are present", async () => {
    const mock = createMockIpcClient([{ items: [], meta: { limit: 50, total: 0 } }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runQuery(["--service", "slack", "--type", "message", "--since", "1d", "--json"]);
    expect(mock.calls).toHaveLength(1);
    const p = mock.calls[0]?.params as Record<string, unknown>;
    expect(p["services"]).toEqual(["slack"]);
    expect(p["types"]).toEqual(["message"]);
    expect(typeof p["sinceMs"]).toBe("number");
    expect(p["limit"]).toBe(50);
  });

  it("default-limits to 50 when --limit is missing or invalid", async () => {
    const mock = createMockIpcClient([{ items: [], meta: { limit: 50, total: 0 } }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runQuery(["--service", "github", "--limit", "garbage", "--json"]);
    expect(mock.calls[0]?.params).toMatchObject({ limit: 50 });
  });

  it("prints '(no rows)' when no items returned and pretty is set", async () => {
    const mock = createMockIpcClient([{ items: [], meta: { limit: 50, total: 0 } }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runQuery(["--service", "github", "--pretty"]);
    expect(out.stdout).toContain("(no rows)");
  });

  it("renders item cards in --pretty mode", async () => {
    const mock = createMockIpcClient([
      {
        items: [
          {
            title: "My PR",
            service: "github",
            type: "pr",
            modified_at: 1700000000000,
            body_preview: "fix things",
            url: "https://example.test/pr/1",
          },
        ],
        meta: { limit: 50, total: 1 },
      },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runQuery(["--service", "github", "--pretty"]);
    expect(out.stdout).toContain("My PR");
    expect(out.stdout).toContain("github");
    expect(out.stdout).toContain("https://example.test/pr/1");
    expect(out.stdout).toMatch(/1 row/);
  });

  it("renders kv blocks in --pretty mode when rows are not item-like", async () => {
    const mock = createMockIpcClient([
      { rows: [{ id: 1, label: "x", created_at: 1700000000000 }], meta: { count: 1 } },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: mock.client as unknown as {
        call: unknown;
        connect: unknown;
        disconnect: unknown;
      },
    });
    await runQuery(["--sql", "SELECT id, label, created_at FROM other", "--pretty"]);
    expect(out.stdout).toContain("#1");
    expect(out.stdout).toContain("id:");
    expect(out.stdout).toContain("label:");
  });
});
