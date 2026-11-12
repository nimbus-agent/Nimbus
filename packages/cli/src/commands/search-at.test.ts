import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { parseSearchRankedResponse } from "../lib/search-ranked-response.ts";

const { runSearch } = await import("./search.ts");

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runSearch --at", () => {
  beforeEach(() => {
    out.reset();
    process.exitCode = 0;
  });
  afterEach(() => {
    clearFixture();
    process.exitCode = 0;
  });

  it("sends `at`, keeps stdout a plain array and prints the disclosure as notes on stderr", async () => {
    const mock = createMockIpcClient([
      {
        items: [{ id: "old", asOf: { atMs: 1, state: {}, basis: "current" } }],
        retrieval: {
          vectorRanked: false,
          reason: "no_embedding_runtime",
          partial: null,
          backfill: null,
        },
        notes: [
          "semantic ranking unavailable (embeddings are disabled or did not start) - keyword-only results",
          "As of 2026-11-11T09:00:00.000Z (Europe/London). State keys come from item history; titles and bodies are as of now.",
          "## Gaps",
          "0 items could not be placed at that time (their state changed after it and the change predates item history, or their birth is unknown); they are not shown.",
        ],
        asOf: { atMs: 1, zone: "Europe/London", historyStartMs: null, gapCount: 0 },
      },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });

    await runSearch(["payment-service", "--at", "yesterday-09:00"]);

    expect(mock.calls[0]?.params).toMatchObject({
      name: "payment-service",
      at: "yesterday-09:00",
      envelope: true,
    });
    expect(out.stderr).toContain("note: As of 2026-11-11T09:00:00.000Z (Europe/London)");
    expect(out.stderr).toContain("note: ## Gaps");
    const parsed = JSON.parse(out.stdout) as Array<{ id: string }>;
    expect(parsed.map((i) => i.id)).toEqual(["old"]);
    expect(process.exitCode).toBe(0);
  });

  it("an envelope with no asOf for a request that sent at is refused with exit 1 and prints nothing", async () => {
    const mock = createMockIpcClient([{ items: [{ id: "x" }], retrieval: {}, notes: [] }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runSearch(["q", "--at", "-2h"]);
    expect(out.stderr).toContain("this gateway does not support --at");
    expect(out.stdout).toBe("");
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["no value", ["q", "--at"]],
    ["a blank value", ["q", "--at", " "]],
    ["an option as the value", ["q", "--at", "--limit"]],
  ])("--at with %s throws", async (_label, args) => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runSearch(args)).rejects.toThrow(/--at needs a time/);
  });

  it("every other unknown flag is still rejected", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runSearch(["q", "--when", "yesterday"])).rejects.toThrow(/Unknown flag/);
  });

  it("without --at the params carry no at", async () => {
    const mock = createMockIpcClient([[{ id: "a" }]]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runSearch(["q"]);
    expect(mock.calls[0]?.params).not.toHaveProperty("at");
  });
});

describe("parseSearchRankedResponse asOf", () => {
  it("carries a record asOf and ignores a non-record one", () => {
    expect(parseSearchRankedResponse({ items: [], notes: [], asOf: { atMs: 1 } }).asOf).toEqual({
      atMs: 1,
    });
    expect(parseSearchRankedResponse({ items: [], notes: [], asOf: 5 }).asOf).toBeUndefined();
    expect(parseSearchRankedResponse({ items: [], notes: [], asOf: [1] }).asOf).toBeUndefined();
    expect(parseSearchRankedResponse([]).asOf).toBeUndefined();
  });
});
