import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import {
  type CliSummary,
  parseBudget,
  parseMediaArgs,
  renderSummary,
  runMediaCmd,
  type SkipReasonKey,
} from "./media-cmd.ts";

const out = captureOutput();

/** Every `SkipReason` at zero, spread into a test summary and overridden per-test. */
const zeroReasons: Record<SkipReasonKey, number> = {
  over_byte_cap: 0,
  no_local_model: 0,
  no_remote_grant: 0,
  unresolvable_modality: 0,
  fetch_miss: 0,
  path_outside_roots: 0,
  transcode_failed: 0,
  transcribe_failed: 0,
  not_configured: 0,
  rate_limited: 0,
};

/**
 * `runMediaCmd` itself only throws on a bad invocation — the catch/exit-code/stderr wrapping is
 * `index.ts`'s `main()`, which this file does not exercise. This mirrors that wrapping locally so
 * a CLI-shaped assertion (`exitCode`, `stderr`) can be made without dragging the whole entry point
 * (and its REPL/banner/logger setup) into a unit test.
 */
async function runMediaCommand(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  out.reset();
  let exitCode = 0;
  let stderr = "";
  try {
    await runMediaCmd(args);
  } catch (e) {
    exitCode = 1;
    stderr = e instanceof Error ? e.message : String(e);
  }
  return { exitCode, stdout: out.stdout, stderr };
}

describe("parseMediaArgs", () => {
  test("defaults to the understand subcommand shape", () => {
    expect(parseMediaArgs(["understand"])).toEqual({ kind: "understand", params: {} });
  });

  test("parses --limit as a number", () => {
    expect(parseMediaArgs(["understand", "--limit", "10"])).toEqual({
      kind: "understand",
      params: { limit: 10 },
    });
  });

  test("rejects a non-numeric --limit rather than defaulting", () => {
    expect(() => parseMediaArgs(["understand", "--limit", "nope"])).toThrow(/limit/);
  });

  test("parses --service and --modality", () => {
    expect(parseMediaArgs(["understand", "--service", "filesystem", "--modality", "av"])).toEqual({
      kind: "understand",
      params: { service: "filesystem", modality: "av" },
    });
  });

  test("rejects an unknown subcommand", () => {
    expect(() => parseMediaArgs(["frobnicate"])).toThrow(/unknown/i);
  });

  test("rejects a flag with no trailing value", () => {
    expect(() => parseMediaArgs(["understand", "--service"])).toThrow(/--service requires a value/);
  });

  test("rejects an invalid --modality value", () => {
    expect(() => parseMediaArgs(["understand", "--modality", "audio"])).toThrow(
      /--modality must be "image" or "av"/,
    );
  });

  test("parses --modality image (S2 PR 2: image captioning via the local VLM)", () => {
    // Both modalities are understood as of PR 2 — `image` is no longer refused at the CLI.
    expect(parseMediaArgs(["understand", "--modality", "image"])).toEqual({
      kind: "understand",
      params: { modality: "image" },
    });
  });

  test("parses --since as a number of days", () => {
    expect(parseMediaArgs(["understand", "--since", "7"])).toEqual({
      kind: "understand",
      params: { sinceDays: 7 },
    });
  });

  test("accepts --since 0 (non-negative boundary)", () => {
    expect(parseMediaArgs(["understand", "--since", "0"])).toEqual({
      kind: "understand",
      params: { sinceDays: 0 },
    });
  });

  test("rejects a negative --since", () => {
    expect(() => parseMediaArgs(["understand", "--since", "-1"])).toThrow(/--since/);
  });

  test("rejects a non-finite --since", () => {
    expect(() => parseMediaArgs(["understand", "--since", "nope"])).toThrow(/--since/);
  });

  test("rejects an unknown flag", () => {
    expect(() => parseMediaArgs(["understand", "--bogus", "x"])).toThrow(/unknown flag "--bogus"/);
  });

  test("--renditions and --originals together are rejected, not silently resolved", async () => {
    const r = await runMediaCommand(["understand", "--renditions", "--originals"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("--renditions and --originals are mutually exclusive");
  });

  test("a value-less flag does not swallow the next flag", () => {
    // The old loop stepped i += 2, so `--renditions` would consume `--limit` as its value.
    const parsed = parseMediaArgs(["understand", "--renditions", "--limit", "10"]);
    expect(parsed.params.renditions).toBe(true);
    expect(parsed.params.limit).toBe(10);
  });

  test("a value-less flag at the END does not throw 'requires a value'", () => {
    expect(() => parseMediaArgs(["understand", "--renditions"])).not.toThrow();
  });

  test("parses --originals alone", () => {
    expect(parseMediaArgs(["understand", "--originals"])).toEqual({
      kind: "understand",
      params: { originals: true },
    });
  });

  test("parses --budget with a unit into budgetBytes", () => {
    expect(parseMediaArgs(["understand", "--budget", "500MB"])).toEqual({
      kind: "understand",
      params: { budgetBytes: 500_000_000 },
    });
  });

  test("rejects an unparseable --budget rather than defaulting", () => {
    expect(() => parseMediaArgs(["understand", "--budget", "lots"])).toThrow(/--budget/);
  });
});

describe("parseBudget", () => {
  test("--budget uses the unit it was GIVEN — GB is decimal, GiB is binary", () => {
    expect(parseBudget("4GB")).toBe(4_000_000_000);
    expect(parseBudget("4GiB")).toBe(4 * 1024 ** 3);
    expect(parseBudget("500MB")).toBe(500_000_000);
    expect(parseBudget("1.5GiB")).toBe(Math.round(1.5 * 1024 ** 3));
    expect(parseBudget("1048576")).toBe(1048576);
    expect(parseBudget("lots")).toBeNull();
    expect(parseBudget("-1GB")).toBeNull();
  });

  test("is case-insensitive on the unit", () => {
    expect(parseBudget("2gb")).toBe(2_000_000_000);
    expect(parseBudget("2Gib")).toBe(2 * 1024 ** 3);
  });

  test("rejects a non-finite raw value", () => {
    expect(parseBudget("Infinity")).toBeNull();
    expect(parseBudget("NaN")).toBeNull();
  });

  test("rejects an unrecognised unit", () => {
    expect(parseBudget("4TB")).toBeNull();
  });
});

describe("renderSummary", () => {
  test("names the total AND breaks skips out by reason", () => {
    const out = renderSummary({
      understood: 42,
      skipped: 2,
      skippedByReason: { ...zeroReasons, over_byte_cap: 1, no_local_model: 1 },
      lastItemId: "x",
      stopReason: "completed",
      cloudBytesFetched: 0,
      preflightRefusal: null,
    });
    expect(out).toContain("Understood 42 of 44");
    expect(out).toContain("over_byte_cap: 1");
    expect(out).toContain("no_local_model: 1");
    // Zero-count reasons are noise, not disclosure.
    expect(out).not.toContain("fetch_miss");
  });

  test("says so plainly when nothing was skipped", () => {
    const out = renderSummary({
      understood: 3,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: "x",
      stopReason: "completed",
      cloudBytesFetched: 0,
      preflightRefusal: null,
    });
    expect(out).toContain("Understood 3 of 3");
  });

  test("always states cloud bytes fetched, even when zero", () => {
    const out = renderSummary({
      understood: 1,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: "x",
      stopReason: "completed",
      cloudBytesFetched: 0,
      preflightRefusal: null,
    });
    expect(out).toContain("Cloud bytes fetched: 0");
  });

  test("a completed run prints no stop/resume guidance at all", () => {
    const out = renderSummary({
      understood: 1,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: "x",
      stopReason: "completed",
      cloudBytesFetched: 12,
      preflightRefusal: null,
    });
    expect(out).not.toContain("stopped");
    expect(out).not.toContain("Resumable");
  });

  test("a budget-stopped summary prints resume guidance and both flags", () => {
    const out = renderSummary({
      understood: 12,
      skipped: 3,
      skippedByReason: { ...zeroReasons, over_byte_cap: 3 },
      lastItemId: "google_drive:f42",
      stopReason: "budget_exhausted",
      cloudBytesFetched: 2_147_483_648,
      preflightRefusal: null,
    });
    expect(out).toContain("stopped: byte budget reached");
    expect(out).toContain("--renditions");
    expect(out).toContain("nimbus media understand");
  });

  test("a PRE-FLIGHT refusal prints the priced numbers, the budget, and both flags", () => {
    const out = renderSummary({
      understood: 0,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: null,
      stopReason: "budget_exhausted",
      cloudBytesFetched: 0,
      preflightRefusal: {
        candidateCount: 200,
        cloudCount: 143 + 57,
        knownBytes: 3_900_000_000,
        knownCount: 143,
        unknownCount: 57,
        budgetBytes: 2_000_000_000,
      },
    });
    // The numbers the gateway computed, not generic guidance over an all-zero summary: this is the
    // ONLY screen the user sees, and the refusal repeats verbatim every run until they act.
    expect(out).toContain("200 artifacts");
    expect(out).toContain("143 with known size");
    expect(out).toContain("3.9 GB");
    expect(out).toContain("57 unknown");
    expect(out).toContain("2.0 GB");
    // The flags that change the outcome, all three.
    expect(out).toContain("--budget");
    expect(out).toContain("--renditions");
    expect(out).toContain("--originals");
    // The mid-run stop block must NOT also appear: nothing was fetched or attempted here.
    expect(out).not.toContain("byte budget reached before every candidate");
    // "Understood 0 of 0" would say there was nothing to do, when a whole page was found and
    // refused — the refusal replaces the ordinary summary rather than sitting under it.
    expect(out).not.toContain("Understood 0 of 0");
    expect(out).toContain("200 candidates found, none attempted");
  });

  test("a PRE-FLIGHT refusal states that the LOCAL candidates in the page are blocked too", () => {
    const out = renderSummary({
      understood: 0,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: null,
      stopReason: "budget_exhausted",
      cloudBytesFetched: 0,
      preflightRefusal: {
        candidateCount: 10,
        cloudCount: 4,
        knownBytes: 9_000_000_000,
        knownCount: 4,
        unknownCount: 0,
        budgetBytes: 1_000_000_000,
      },
    });
    // Six of the ten need no network at all and are refused anyway, because the refusal returns
    // before the candidate loop. Omitting this let a reader assume their local media still ran.
    expect(out).toContain("6 of those 10 are LOCAL");
    expect(out).toContain("blocked too");
    // And it must NOT claim local candidates on an all-cloud page: a sentence that reads as a
    // contradiction is a disclosure that gets ignored.
    const allCloud = renderSummary({
      understood: 0,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: null,
      stopReason: "budget_exhausted",
      cloudBytesFetched: 0,
      preflightRefusal: {
        candidateCount: 5,
        cloudCount: 5,
        knownBytes: 9_000_000_000,
        knownCount: 5,
        unknownCount: 0,
        budgetBytes: 1_000_000_000,
      },
    });
    expect(allCloud).not.toContain("are LOCAL");
  });

  test("a MID-RUN budget stop keeps the resume block and prints no refusal numbers", () => {
    // The distinction the two blocks exist to make: this run DID fetch, DID move the cursor onto
    // the last completed item, and resumes on its own next run. Borrowing the refusal's wording
    // ("nothing was fetched", "refused identically until you act") would be false here.
    const out = renderSummary({
      understood: 12,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: "google_drive:f42",
      stopReason: "budget_exhausted",
      cloudBytesFetched: 2_147_483_648,
      preflightRefusal: null,
    });
    expect(out).toContain("stopped: byte budget reached");
    expect(out).toContain("Understood 12 of 12");
    expect(out).not.toContain("Refusing:");
    expect(out).not.toContain("none attempted");
  });

  test("a rate-limited summary names the reason and is resumable", () => {
    const out = renderSummary({
      understood: 4,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: "onedrive:x",
      stopReason: "rate_limited",
      cloudBytesFetched: 500,
      preflightRefusal: null,
    });
    expect(out).toContain("rate-limiting");
    expect(out).toContain("Resumable");
    expect(out).toContain("nimbus media understand");
  });

  test("a summary from a version-skewed gateway with no preflightRefusal field renders normally", () => {
    // Simulates the wire, not the compiler: a gateway daemon that predates `preflightRefusal`
    // sends a summary object with the field ABSENT entirely, not set to `null`. `CliSummary`
    // requires the field, so we build a complete object and delete it behind a narrow, commented
    // cast to reproduce exactly what `JSON.parse` on that older payload would hand `renderSummary`.
    const full: CliSummary = {
      understood: 3,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: "x",
      stopReason: "completed",
      cloudBytesFetched: 0,
      preflightRefusal: null,
    };
    // Narrow, commented cast (never `any` — see CLAUDE.md): simulating a version-skewed IPC
    // payload missing a required field, since `delete` on a non-optional property needs an
    // escape from the type it obeys.
    delete (full as unknown as Record<string, unknown>)["preflightRefusal"];
    expect(() => renderSummary(full)).not.toThrow();
    const out = renderSummary(full);
    expect(out).toContain("Understood 3 of 3");
    expect(out).not.toContain("Refusing:");
  });
});

describe("runMediaCmd", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  test("prints help and makes no IPC call when given no subcommand", async () => {
    await runMediaCmd([]);
    expect(out.stdout).toContain("nimbus media");
    expect(out.stdout).toContain("understand");
  });

  // Every spelling of "show me the usage" reaches the same output. Parameterized so adding a
  // fourth spelling is one line, and so a regression names WHICH spelling broke.
  for (const arg of ["help", "--help", "-h"]) {
    test(`prints help for ${arg}`, async () => {
      await runMediaCmd([arg]);
      expect(out.stdout).toContain("Usage:");
    });
  }

  test("throws GatewayNotRunningError when no gateway state is present", async () => {
    setFixture({});
    await expect(runMediaCmd(["understand"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  test("propagates a parse error before ever reaching the gateway", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runMediaCmd(["understand", "--limit", "nope"])).rejects.toThrow(/limit/);
  });

  test("calls media.understand with the parsed params and prints the rendered summary", async () => {
    const summary = {
      understood: 5,
      skipped: 1,
      skippedByReason: { ...zeroReasons, over_byte_cap: 1 },
      lastItemId: "item-1",
      stopReason: "completed",
      cloudBytesFetched: 0,
      preflightRefusal: null,
    };
    const ipc = createMockIpcClient([summary]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    let stdoutBuf = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string): boolean => {
      stdoutBuf += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await runMediaCmd(["understand", "--service", "filesystem", "--modality", "av"]);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(ipc.calls[0]).toEqual({
      method: "media.understand",
      params: { service: "filesystem", modality: "av" },
    });
    expect(stdoutBuf).toContain("Understood 5 of 6");
    expect(stdoutBuf).toContain("over_byte_cap: 1");
  });

  test("forwards --budget/--renditions to media.understand", async () => {
    const summary = {
      understood: 0,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: null,
      stopReason: "completed",
      cloudBytesFetched: 0,
      preflightRefusal: null,
    };
    const ipc = createMockIpcClient([summary]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    const origWrite = process.stdout.write.bind(process.stdout);
    // The summary text isn't asserted in this test — only the params reaching the IPC call — so
    // the override just swallows the write rather than accumulating an unused buffer.
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      await runMediaCmd(["understand", "--budget", "1GiB", "--renditions"]);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(ipc.calls[0]).toEqual({
      method: "media.understand",
      params: { budgetBytes: 1024 ** 3, renditions: true },
    });
  });

  test("prints raw JSON instead of the rendered summary when --json is passed", async () => {
    const summary = {
      understood: 2,
      skipped: 0,
      skippedByReason: { ...zeroReasons },
      lastItemId: null,
      stopReason: "completed",
      cloudBytesFetched: 0,
      preflightRefusal: null,
    };
    const ipc = createMockIpcClient([summary]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    let stdoutBuf = "";
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string): boolean => {
      stdoutBuf += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      await runMediaCmd(["understand", "--json"]);
    } finally {
      process.stdout.write = origWrite;
    }
    // --json is stripped before parsing, so the params sent are empty.
    expect(ipc.calls[0]).toEqual({ method: "media.understand", params: {} });
    expect(JSON.parse(stdoutBuf.trim())).toEqual(summary);
  });
});
