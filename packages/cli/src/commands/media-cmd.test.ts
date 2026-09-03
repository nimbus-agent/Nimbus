import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { parseMediaArgs, renderSummary, runMediaCmd } from "./media-cmd.ts";

const out = captureOutput();

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
      /--modality must be "av"/,
    );
  });

  test("refuses --modality image with the reason, rather than running a pass that finds nothing", () => {
    // `image` is a real modality with a real registry entry, so it parses as a value — but no
    // vision model ships in this slice, so every image candidate is skipped. Accepting the flag
    // would print "Understood 0 of 0" and let a user conclude they have no images.
    expect(() => parseMediaArgs(["understand", "--modality", "image"])).toThrow(
      /not available yet .* audio and video only/s,
    );
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
});

describe("renderSummary", () => {
  test("names the total AND breaks skips out by reason", () => {
    const out = renderSummary({
      understood: 42,
      skipped: 2,
      skippedByReason: {
        over_byte_cap: 1,
        no_local_model: 1,
        no_remote_grant: 0,
        unresolvable_modality: 0,
        fetch_miss: 0,
        path_outside_roots: 0,
        transcode_failed: 0,
        transcribe_failed: 0,
      },
      lastItemId: "x",
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
      skippedByReason: {
        over_byte_cap: 0,
        no_local_model: 0,
        no_remote_grant: 0,
        unresolvable_modality: 0,
        fetch_miss: 0,
        path_outside_roots: 0,
        transcode_failed: 0,
        transcribe_failed: 0,
      },
      lastItemId: "x",
    });
    expect(out).toContain("Understood 3 of 3");
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

  test("prints help for the 'help' subcommand", async () => {
    await runMediaCmd(["help"]);
    expect(out.stdout).toContain("Usage:");
  });

  test("prints help for --help", async () => {
    await runMediaCmd(["--help"]);
    expect(out.stdout).toContain("Usage:");
  });

  test("prints help for -h", async () => {
    await runMediaCmd(["-h"]);
    expect(out.stdout).toContain("Usage:");
  });

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
      skippedByReason: {
        over_byte_cap: 1,
        no_local_model: 0,
        no_remote_grant: 0,
        unresolvable_modality: 0,
        fetch_miss: 0,
        path_outside_roots: 0,
        transcode_failed: 0,
        transcribe_failed: 0,
      },
      lastItemId: "item-1",
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

  test("prints raw JSON instead of the rendered summary when --json is passed", async () => {
    const summary = {
      understood: 2,
      skipped: 0,
      skippedByReason: {
        over_byte_cap: 0,
        no_local_model: 0,
        no_remote_grant: 0,
        unresolvable_modality: 0,
        fetch_miss: 0,
        path_outside_roots: 0,
        transcode_failed: 0,
        transcribe_failed: 0,
      },
      lastItemId: null,
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
