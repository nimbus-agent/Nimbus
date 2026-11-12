import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const { runQuery } = await import("./query.ts");

const out = captureOutput();

afterAll(() => {
  out.restore();
});

function setupMock(responseQueue: ReadonlyArray<unknown>): ReturnType<typeof createMockIpcClient> {
  const mock = createMockIpcClient(responseQueue);
  setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
  return mock;
}

const AT_RESPONSE = {
  items: [{ id: "old", service: "github", name: "payment-service retry" }],
  meta: { limit: 50, total: 1 },
  gaps: { excludedUnplaceable: 2 },
  asOf: {
    atMs: Date.UTC(2026, 10, 11, 9),
    zone: "Europe/London",
    historyStartMs: Date.UTC(2026, 10, 11, 12),
    disclosure: [
      "As of 2026-11-11T09:00:00.000Z (Europe/London). State keys come from item history; titles and bodies are as of now.",
      "History starts 2026-11-11T12:00:00.000Z; state before then is the first observed state.",
      "## Gaps",
      "2 items could not be placed at that time (their state changed after it and the change predates item history, or their birth is unknown); they are not shown.",
    ],
  },
};

describe("runQuery --at", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("sends --at as the raw `at` param and prints the disclosure and the Gaps line", async () => {
    const mock = setupMock([AT_RESPONSE]);
    await runQuery(["--service", "github", "--type", "pr", "--at", "yesterday-09:00", "--pretty"]);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe("index.queryItems");
    expect(mock.calls[0]?.params).toMatchObject({
      services: ["github"],
      types: ["pr"],
      at: "yesterday-09:00",
    });
    expect(out.stderr).toContain("As of 2026-11-11T09:00:00.000Z (Europe/London)");
    expect(out.stderr).toContain("History starts 2026-11-11T12:00:00.000Z");
    expect(out.stderr).not.toContain("## Gaps");
    expect(out.stdout).toContain("Gaps: 2 excluded (state at that time cannot be placed)");
    expect(process.exitCode).toBe(0);
  });

  it("--json keeps the whole document, asOf included, on stdout", async () => {
    setupMock([AT_RESPONSE]);
    await runQuery(["--service", "github", "--at", "-2h", "--json"]);
    const doc = JSON.parse(out.stdout) as { asOf: { zone: string }; gaps: unknown };
    expect(doc.asOf.zone).toBe("Europe/London");
    expect(doc.gaps).toEqual({ excludedUnplaceable: 2 });
  });

  it("a gateway that returns no asOf for a request that sent at is refused with exit 1", async () => {
    setupMock([{ items: [{ id: "x" }], meta: { limit: 50, total: 1 } }]);
    await runQuery(["--service", "github", "--at", "-2h"]);
    expect(out.stderr).toContain("this gateway does not support --at");
    expect(out.stdout).not.toContain('"id"');
    expect(process.exitCode).toBe(1);
  });

  it("--sql with --at throws before any IPC call", async () => {
    const mock = setupMock([]);
    await expect(runQuery(["--sql", "SELECT 1", "--at", "-2h"])).rejects.toThrow(/--at cannot/);
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    ["--since", ["--since", "7d"]],
    ["--not-touching", ["--type", "pr", "--not-touching", "src/**"]],
    ["--no-downstream-incident", ["--type", "deployment", "--no-downstream-incident"]],
  ])("--at with %s throws before any IPC call", async (_label, extra) => {
    const mock = setupMock([]);
    await expect(runQuery(["--service", "github", "--at", "-2h", ...extra])).rejects.toThrow(
      /--at cannot be combined/,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it.each([
    ["no value", ["--service", "github", "--at"]],
    ["a blank value", ["--service", "github", "--at", "  "]],
    ["an option as the value", ["--service", "github", "--at", "--json"]],
  ])("--at with %s throws before any IPC call", async (_label, args) => {
    const mock = setupMock([]);
    await expect(runQuery(args)).rejects.toThrow(/--at needs a time/);
    expect(mock.calls).toHaveLength(0);
  });

  it("without --at nothing about asOf is sent or required", async () => {
    const mock = setupMock([{ items: [], meta: { limit: 50, total: 0 } }]);
    await runQuery(["--service", "github", "--json"]);
    expect(mock.calls[0]?.params).not.toHaveProperty("at");
    expect(process.exitCode).toBe(0);
  });

  it("the help text names --at", async () => {
    await runQuery(["--help"]);
    expect(out.stdout).toContain("--at <time>");
  });
});
