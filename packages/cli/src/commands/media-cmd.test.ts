import { describe, expect, test } from "bun:test";
import { parseMediaArgs, renderSummary } from "./media-cmd.ts";

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
