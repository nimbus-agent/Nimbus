import { afterAll, afterEach, beforeEach, describe, expect, it, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";

const mod = await import("./metrics.ts");
const {
  formatDoraPretty,
  parseMetricsDoraArgs,
  renderMetricRow,
  renderMixedSourceHint,
  runMetricsCli,
} = mod;
type MetricRowInput = import("./metrics.ts").MetricRowInput;

describe("parseMetricsDoraArgs", () => {
  test("parses service + since + json", () => {
    const out = parseMetricsDoraArgs(["--service", "payment-service", "--since", "7d", "--json"]);
    expect(out).toEqual({ service: "payment-service", since: "7d", json: true });
  });

  test("defaults since to 30d and json to false", () => {
    const out = parseMetricsDoraArgs(["--service", "x"]);
    expect(out).toEqual({ service: "x", since: "30d", json: false });
  });

  test("throws on missing --service", () => {
    expect(() => parseMetricsDoraArgs(["--since", "7d"])).toThrow(/--service/);
  });

  test("throws on malformed --since", () => {
    expect(() => parseMetricsDoraArgs(["--service", "x", "--since", "lol"])).toThrow(/--since/);
  });

  test("accepts --since 24h", () => {
    const out = parseMetricsDoraArgs(["--service", "x", "--since", "24h"]);
    expect(out.since).toBe("24h");
  });

  test.each([
    ["missing", ["--service"]],
    ["blank", ["--service", "   "]],
  ])("a %s --service value is refused by name, not read as 'no filter'", (_label, argv) => {
    expect(() => parseMetricsDoraArgs(argv)).toThrow("--service requires a non-empty value");
  });

  test("a --service value is trimmed", () => {
    expect(parseMetricsDoraArgs(["--service", "  svc  "]).service).toBe("svc");
  });
});

const WARN_PREFIX = "\x1b[33m⚠\x1b[0m";

function mixedSourceRow(): MetricRowInput {
  return {
    label: "Deployment Frequency",
    value: 1.5,
    unit: "per_day",
    sample: 42,
    gap: "mixed_source",
  };
}

describe("renderMetricRow", () => {
  test("prepends yellow ⚠ for mixed_source when tty and color enabled", () => {
    const out = renderMetricRow(mixedSourceRow(), { tty: true, noColor: false });
    expect(out).toContain(WARN_PREFIX);
  });

  test("omits ⚠ when noColor is true (NO_COLOR set)", () => {
    const out = renderMetricRow(mixedSourceRow(), { tty: true, noColor: true });
    expect(out).not.toContain(WARN_PREFIX);
    expect(out).not.toContain("\x1b[");
  });

  test("omits ⚠ when tty is false (output piped)", () => {
    const out = renderMetricRow(mixedSourceRow(), { tty: false, noColor: false });
    expect(out).not.toContain(WARN_PREFIX);
    expect(out).not.toContain("\x1b[");
  });

  test("does not prepend ⚠ for non-mixed_source gaps even on a colour TTY", () => {
    const row: MetricRowInput = {
      label: "Lead Time",
      value: 2,
      unit: "hours",
      sample: 5,
      gap: "low_sample",
    };
    const out = renderMetricRow(row, { tty: true, noColor: false });
    expect(out).not.toContain(WARN_PREFIX);
    expect(out).toContain("[low_sample]");
  });

  test("does not prepend ⚠ when gap is null", () => {
    const row: MetricRowInput = {
      label: "MTTR",
      value: 0.5,
      unit: "hours",
      sample: 10,
      gap: null,
    };
    const out = renderMetricRow(row, { tty: true, noColor: false });
    expect(out).not.toContain(WARN_PREFIX);
  });
});

describe("renderMixedSourceHint", () => {
  test("returns a non-empty string", () => {
    const hint = renderMixedSourceHint();
    expect(hint.length).toBeGreaterThan(0);
  });

  test("mentions both deployment and ci_run data sources", () => {
    const hint = renderMixedSourceHint();
    expect(hint).toContain("deployment");
    expect(hint).toContain("ci_run");
  });

  test("includes the actionable guidance phrase", () => {
    const hint = renderMixedSourceHint();
    expect(hint).toContain("Annotate consistently");
  });
});

function metric(
  value: number | null,
  unit: string,
  sample: number,
  gap: string | null,
): { value: number | null; unit: string; sample: number; gap: string | null } {
  return { value, unit, sample, gap };
}

function envelopeFixture(
  opts: { hasMixedSource?: boolean } = {},
): Parameters<typeof formatDoraPretty>[0] {
  const lt = opts.hasMixedSource
    ? metric(2.5, "hours", 8, "mixed_source")
    : metric(2.5, "hours", 8, null);
  return {
    service: "svc",
    since_ms: 30 * 86_400_000,
    computed_at: "2026-05-22T00:00:00Z",
    metrics: {
      deployment_frequency: metric(1.2, "per_day", 36, null),
      lead_time_for_changes: lt,
      change_failure_rate: metric(0.1, "percent", 36, null),
      mttr: metric(null, "hours", 0, "no_data"),
    },
  };
}

describe("formatDoraPretty", () => {
  test("renders header, four metric rows, and since-days", () => {
    const out = formatDoraPretty(envelopeFixture(), { tty: false, noColor: true });
    expect(out).toContain("DORA metrics");
    expect(out).toContain("svc");
    expect(out).toContain("Deployment Frequency");
    expect(out).toContain("Lead Time");
    expect(out).toContain("Change Failure Rate");
    expect(out).toContain("MTTR");
    expect(out).toContain("30d");
  });

  test("appends mixed_source hint when any metric is mixed_source", () => {
    const out = formatDoraPretty(envelopeFixture({ hasMixedSource: true }), {
      tty: false,
      noColor: true,
    });
    expect(out).toContain("Annotate consistently");
  });

  test("does NOT append hint when no metric is mixed_source", () => {
    const out = formatDoraPretty(envelopeFixture(), { tty: false, noColor: true });
    expect(out).not.toContain("Annotate consistently");
  });

  test("renders em-dash for null values", () => {
    const out = formatDoraPretty(envelopeFixture(), { tty: false, noColor: true });
    expect(out).toContain("—");
  });
});

const {
  stdoutChunks,
  stderrChunks,
  install: installStreamCapture,
  restore: restoreStreams,
} = createStreamCapture({ captureExit: true });

afterAll(() => {
  restoreStreams();
});

describe("runMetricsCli", () => {
  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    installStreamCapture();
  });
  afterEach(() => {
    clearFixture();
    restoreStreams();
  });

  it("exits 1 on missing subcommand", async () => {
    await expect(runMetricsCli([])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Usage:");
  });

  it("exits 1 on unknown subcommand", async () => {
    await expect(runMetricsCli(["bogus"])).rejects.toThrow("process.exit(1)");
  });

  it("exits 1 on arg-parse error (missing --service)", async () => {
    await expect(runMetricsCli(["dora"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("--service");
  });

  it("exits 1 when gateway state is undefined", async () => {
    setFixture({});
    await expect(runMetricsCli(["dora", "--service", "svc"])).rejects.toThrow("process.exit(1)");
    expect(stderrChunks.join("")).toContain("Gateway is not running");
  });

  it("renders pretty output on success", async () => {
    const mock = createMockIpcClient([envelopeFixture()]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runMetricsCli(["dora", "--service", "svc"]);
    expect(stdoutChunks.join("")).toContain("DORA metrics");
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe("metrics.dora");
    expect((mock.calls[0]?.params as Record<string, unknown> | undefined)?.["service"]).toBe("svc");
  });

  it("emits JSON envelope when --json passed", async () => {
    const mock = createMockIpcClient([envelopeFixture()]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runMetricsCli(["dora", "--service", "svc", "--json"]);
    expect(stdoutChunks.join("")).toContain('"service": "svc"');
    expect(stdoutChunks.join("")).toContain('"deployment_frequency"');
  });

  it("exits 2 on malformed envelope", async () => {
    const mock = createMockIpcClient([{ not: "an envelope" }]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(runMetricsCli(["dora", "--service", "svc"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("Malformed");
  });

  it("exits 2 on IPC error", async () => {
    const mock = createMockIpcClient([new Error("ipc down")]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(runMetricsCli(["dora", "--service", "svc"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toContain("ipc down");
  });

  // Each case breaks exactly ONE field of an otherwise valid envelope, so a validator that stopped
  // checking that field would render garbage instead of exiting 2.
  type Envelope = ReturnType<typeof envelopeFixture>;
  test.each<[string, (e: Envelope) => unknown]>([
    ["a null response", () => null],
    ["a string response", () => "ok"],
    ["since_ms that is not a number", (e) => ({ ...e, since_ms: "30d" })],
    ["no computed_at", (e) => ({ ...e, computed_at: undefined })],
    ["a null metrics block", (e) => ({ ...e, metrics: null })],
    ["a null metric", (e) => ({ ...e, metrics: { ...e.metrics, mttr: null } })],
    [
      "a non-finite sample",
      (e) => ({
        ...e,
        metrics: {
          ...e.metrics,
          change_failure_rate: {
            ...e.metrics.change_failure_rate,
            sample: Number.POSITIVE_INFINITY,
          },
        },
      }),
    ],
    [
      "a metric with no unit",
      (e) => ({
        ...e,
        metrics: { ...e.metrics, deployment_frequency: { value: 1, sample: 2, gap: null } },
      }),
    ],
  ])("exits 2 on an envelope with %s, rendering nothing", async (_label, corrupt) => {
    const mock = createMockIpcClient([corrupt(envelopeFixture())]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await expect(runMetricsCli(["dora", "--service", "svc"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toStartWith("Malformed metrics.dora response\n");
    expect(stdoutChunks).toEqual([]);
  });

  it("connects before it asks for the metrics, and disconnects after rendering", async () => {
    // The mock client's connect is a no-op, so no other test here would notice a call sent down a
    // client that was never connected -- which is a failed command against a real gateway.
    const lifecycle: string[] = [];
    const mock = createMockIpcClient([envelopeFixture()]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        connect: async (): Promise<void> => {
          lifecycle.push("connect");
        },
        call: (m: string, p: unknown): Promise<unknown> => {
          lifecycle.push(`call ${m}`);
          return mock.client.call(m, p);
        },
        disconnect: async (): Promise<void> => {
          lifecycle.push("disconnect");
        },
      },
    });
    await runMetricsCli(["dora", "--service", "svc"]);
    expect(lifecycle).toEqual(["connect", "call metrics.dora", "disconnect"]);
    expect(stdoutChunks.join("")).toContain("DORA metrics — svc");
  });

  it("a disconnect that fails AFTER rendering is swallowed, never turned into an exit", async () => {
    const mock = createMockIpcClient([envelopeFixture()]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: (m: string, p: unknown): Promise<unknown> => mock.client.call(m, p),
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {
          throw new Error("socket already closed");
        },
      },
    });
    await runMetricsCli(["dora", "--service", "svc"]);
    expect(stdoutChunks.join("")).toContain("DORA metrics — svc");
    expect(stderrChunks).toEqual([]);
  });

  it("a non-Error rejection from the transport is reported verbatim, exit 2", async () => {
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: {
        call: async (): Promise<unknown> => {
          throw "socket hung up";
        },
        connect: async (): Promise<void> => {},
        disconnect: async (): Promise<void> => {},
      },
    });
    await expect(runMetricsCli(["dora", "--service", "svc"])).rejects.toThrow("process.exit(2)");
    expect(stderrChunks.join("")).toBe("socket hung up\n");
  });
});

describe("runMetricsCli -- colour follows NO_COLOR on a TTY", () => {
  let savedNoColor: string | undefined;
  let savedIsTty: PropertyDescriptor | undefined;

  beforeEach(() => {
    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    savedNoColor = process.env["NO_COLOR"];
    savedIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    // A TTY, so NO_COLOR alone decides whether the mixed_source row is coloured.
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
    installStreamCapture();
  });
  afterEach(() => {
    restoreStreams();
    if (savedIsTty === undefined) Reflect.deleteProperty(process.stdout, "isTTY");
    else Object.defineProperty(process.stdout, "isTTY", savedIsTty);
    if (savedNoColor === undefined) delete process.env["NO_COLOR"];
    else process.env["NO_COLOR"] = savedNoColor;
    clearFixture();
  });

  async function prettyRun(): Promise<string> {
    const mock = createMockIpcClient([envelopeFixture({ hasMixedSource: true })]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runMetricsCli(["dora", "--service", "svc"]);
    return stdoutChunks.join("");
  }

  it("a non-empty NO_COLOR turns colour off", async () => {
    process.env["NO_COLOR"] = "1";
    const out = await prettyRun();
    expect(out).toContain("[mixed_source]");
    expect(out).not.toContain("\x1b[");
  });

  it("an EMPTY NO_COLOR does not", async () => {
    process.env["NO_COLOR"] = "";
    const out = await prettyRun();
    expect(out).toContain(WARN_PREFIX);
  });
});
