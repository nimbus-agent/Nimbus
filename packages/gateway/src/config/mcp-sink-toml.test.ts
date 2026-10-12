import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MCP_SINK_CONFIG,
  loadNimbusMcpSinkFromPath,
  McpSinkConfigError,
  parseNimbusTomlMcpSink,
} from "./mcp-sink-toml.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseNimbusTomlMcpSink", () => {
  test("defaults: off, all four kinds, 30/h, 100 pending; frozen", () => {
    const c = parseNimbusTomlMcpSink("");
    expect(c).toEqual(DEFAULT_MCP_SINK_CONFIG);
    expect(c).toEqual({
      enabled: false,
      kinds: ["note", "decision", "term", "link"],
      maxPerHour: 30,
      maxPending: 100,
    });
    expect(Object.isFrozen(c)).toBe(true);
  });

  test("reads every key inside [mcp_sink] only", () => {
    const c = parseNimbusTomlMcpSink(
      [
        "[other]",
        "enabled = true",
        "[mcp_sink]",
        "enabled = true # on",
        'kinds = ["note"]',
        "max_per_hour = 5",
        "max_pending = 7",
        "unknown_key = 1",
      ].join("\n"),
    );
    expect(c).toEqual({ enabled: true, kinds: ["note"], maxPerHour: 5, maxPending: 7 });
  });

  test("a header that merely starts with [mcp_sink is not the section", () => {
    expect(parseNimbusTomlMcpSink("[mcp_sink.extra]\nenabled = true").enabled).toBe(false);
  });

  test.each([
    ["max_per_hour = 0", /max_per_hour must be an integer 1\.\.1000 \(got: 0\)/],
    ["max_per_hour = 1001", /max_per_hour/],
    ["max_per_hour = 2.5", /max_per_hour/],
    ["max_pending = 0", /max_pending must be an integer 1\.\.10000/],
    ["max_pending = 10001", /max_pending/],
    ['kinds = ["note", "action"]', /kinds: unknown kind "action"/],
    ["kinds = []", /kinds must not be empty/],
    ['kinds = "note"', /kinds must be an array/],
    ['enabled = "yes"', /enabled must be true or false/],
  ])("refuses loudly, never clamps: %s", (line, msg) => {
    expect(() => parseNimbusTomlMcpSink(`[mcp_sink]\n${line}`)).toThrow(McpSinkConfigError);
    expect(() => parseNimbusTomlMcpSink(`[mcp_sink]\n${line}`)).toThrow(msg);
  });
});

describe("loadNimbusMcpSinkFromPath", () => {
  test("missing file → defaults; bad file → ok:false with the message", () => {
    const d = mkdtempSync(join(tmpdir(), "mcp-sink-"));
    dirs.push(d);
    expect(loadNimbusMcpSinkFromPath(join(d, "absent.toml"))).toEqual({
      ok: true,
      config: DEFAULT_MCP_SINK_CONFIG,
    });
    const p = join(d, "nimbus.toml");
    writeFileSync(p, "[mcp_sink]\nmax_pending = 0\n");
    const r = loadNimbusMcpSinkFromPath(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("max_pending");
  });
});
