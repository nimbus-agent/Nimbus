import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { runIndexHealth } from "./index-health-cmd.ts";

const EMPTY_REPORT = {
  totalItems: 0,
  embeddingCoveragePercent: 0,
  connectors: [],
  sparseTypes: [],
  confidence: null,
  confidenceUnavailableReason: "empty_index",
  confidenceInputs: {
    embeddingCoveragePercent: 0,
    freshItemPercent: 0,
    coverageWeight: 0.6,
    freshnessWeight: 0.4,
  },
  staleThresholdDays: 7,
  generatedAtMs: 0,
};

let out: string[];
const origLog = console.log;
// The ORIGINAL function, not `.bind(...)` of it. Restoring a bound wrapper leaves a
// process-global mutation behind after this file runs, which matters in the whole-repo
// single-process test run where every file shares one `process`.
const origWrite = process.stdout.write;
const origNoColor = process.env["NO_COLOR"];

beforeEach(() => {
  out = [];
  console.log = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  };
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.env["NO_COLOR"] = "1";
});

afterEach(() => {
  console.log = origLog;
  process.stdout.write = origWrite;
  if (origNoColor === undefined) delete process.env["NO_COLOR"];
  else process.env["NO_COLOR"] = origNoColor;
});

describe("runIndexHealth — the IPC call", () => {
  test("calls index.health with no params by default", async () => {
    const { client, calls } = createMockIpcClient([EMPTY_REPORT]);
    await runIndexHealth(client, []);
    expect(calls[0]?.method).toBe("index.health");
    expect(calls[0]?.params).toEqual({});
  });

  test("forwards --stale-days as staleThresholdDays", async () => {
    const { client, calls } = createMockIpcClient([{ ...EMPTY_REPORT, staleThresholdDays: 30 }]);
    await runIndexHealth(client, ["--stale-days", "30"]);
    expect(calls[0]?.params).toEqual({ staleThresholdDays: 30 });
  });

  test("accepts 0 as a threshold — everything is stale, but that is a valid ask", async () => {
    const { client, calls } = createMockIpcClient([{ ...EMPTY_REPORT, staleThresholdDays: 0 }]);
    await runIndexHealth(client, ["--stale-days", "0"]);
    expect(calls[0]?.params).toEqual({ staleThresholdDays: 0 });
  });

  test("propagates an IPC failure rather than printing a hollow report", async () => {
    const { client } = createMockIpcClient([new Error("gateway down")]);
    await expect(runIndexHealth(client, [])).rejects.toThrow(/gateway down/);
  });
});

describe("runIndexHealth — --stale-days validation", () => {
  // Client-side as well as gateway-side, for two reasons: a CLI user gets a usage error instead of
  // a JSON-RPC code, and `Number("")` is 0 — which would silently mean "treat everything as stale"
  // rather than "you typo'd the flag".
  const REJECTED = ["", "  ", "abc", "-1", "NaN", "Infinity"];
  for (const bad of REJECTED) {
    test(`rejects --stale-days ${JSON.stringify(bad)} without calling the gateway`, async () => {
      const { client, calls } = createMockIpcClient([EMPTY_REPORT]);
      await expect(runIndexHealth(client, ["--stale-days", bad])).rejects.toThrow(/--stale-days/);
      expect(calls).toHaveLength(0);
    });
  }

  test("a --stale-days with no value after it is ignored, not treated as 0", async () => {
    // `takeFlagValue` returns undefined at the end of argv; falling through to `Number(undefined)`
    // would be NaN, and coercing that to 0 would mark every connector stale.
    const { client, calls } = createMockIpcClient([EMPTY_REPORT]);
    await runIndexHealth(client, ["--stale-days"]);
    expect(calls[0]?.params).toEqual({});
  });
});

describe("runIndexHealth — output", () => {
  test("--json prints the raw report and no rendered table", async () => {
    const { client } = createMockIpcClient([EMPTY_REPORT]);
    await runIndexHealth(client, ["--json"]);
    const text = out.join("");
    expect(JSON.parse(text)).toEqual(EMPTY_REPORT);
    expect(text).not.toContain("Index health");
  });

  test("the human render names the empty index instead of scoring it", async () => {
    const { client } = createMockIpcClient([EMPTY_REPORT]);
    await runIndexHealth(client, []);
    const text = out.join("");
    expect(text).toContain("Index health");
    expect(text).toMatch(/index is empty/i);
    expect(text).not.toContain("0/100");
  });

  test("in the demo root the empty-index hint points at `nimbus demo` (from paths.demo)", async () => {
    // `getCliPlatformPaths()` reads `NIMBUS_DEMO` for real; the command branches on the resolved
    // `paths.demo`. Nothing is read or written at those paths — the IPC client is a mock.
    const saved = {
      demo: process.env["NIMBUS_DEMO"],
      configDir: process.env["NIMBUS_CONFIG_DIR"],
      socket: process.env["NIMBUS_GATEWAY_SOCKET"],
    };
    delete process.env["NIMBUS_CONFIG_DIR"];
    delete process.env["NIMBUS_GATEWAY_SOCKET"];
    process.env["NIMBUS_DEMO"] = "1";
    try {
      const { client } = createMockIpcClient([EMPTY_REPORT]);
      await runIndexHealth(client, []);
      const text = out.join("");
      expect(text).toMatch(/demo index is empty/i);
      expect(text).not.toContain("connector sync");
    } finally {
      for (const [k, v] of [
        ["NIMBUS_DEMO", saved.demo],
        ["NIMBUS_CONFIG_DIR", saved.configDir],
        ["NIMBUS_GATEWAY_SOCKET", saved.socket],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("renders a populated report with its connector row", async () => {
    const { client } = createMockIpcClient([
      {
        ...EMPTY_REPORT,
        totalItems: 10,
        embeddingCoveragePercent: 50,
        confidence: 70,
        confidenceUnavailableReason: null,
        confidenceInputs: {
          embeddingCoveragePercent: 50,
          freshItemPercent: 100,
          coverageWeight: 0.6,
          freshnessWeight: 0.4,
        },
        connectors: [
          {
            service: "github",
            items: 10,
            embeddedItems: 5,
            embeddingCoveragePercent: 50,
            lastSyncMs: Date.now() - 3_600_000,
            staleDays: 0,
            stale: false,
            staleReason: null,
          },
        ],
      },
    ]);
    await runIndexHealth(client, []);
    const text = out.join("");
    expect(text).toContain("github");
    expect(text).toContain("70/100");
  });

  test("NO_COLOR suppresses ANSI even when the report is a low score", async () => {
    const { client } = createMockIpcClient([
      { ...EMPTY_REPORT, totalItems: 1, confidence: 12, confidenceUnavailableReason: null },
    ]);
    await runIndexHealth(client, []);
    expect(out.join("")).not.toMatch(new RegExp(String.fromCodePoint(27)));
  });
});
