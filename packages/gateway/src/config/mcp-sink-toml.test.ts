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
      actionTtlHours: 24,
      actionMaxPending: 10,
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
    expect(c).toEqual({
      enabled: true,
      kinds: ["note"],
      maxPerHour: 5,
      maxPending: 7,
      actionTtlHours: 24,
      actionMaxPending: 10,
    });
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
    ['kinds = ["note", "bogus"]', /kinds: unknown kind "bogus"/],
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

describe("[mcp_sink] act door keys (PR 3)", () => {
  const nl = "\n";
  const toml = (...lines: string[]) => ["[mcp_sink]", ...lines].join(nl) + nl;
  test("default kinds do NOT include action; TTL 24, max pending 10", () => {
    const c = parseNimbusTomlMcpSink(toml("enabled = true"));
    expect(c.kinds).toEqual(["note", "decision", "term", "link"]);
    expect(c.actionTtlHours).toBe(24);
    expect(c.actionMaxPending).toBe(10);
  });
  test("action is accepted when listed explicitly", () => {
    const c = parseNimbusTomlMcpSink(toml('kinds = ["note", "action"]'));
    expect(c.kinds).toEqual(["note", "action"]);
  });
  test.each([
    ["action_ttl_hours", "0"],
    ["action_ttl_hours", "169"],
    ["action_ttl_hours", "x"],
    ["action_max_pending", "0"],
    ["action_max_pending", "101"],
  ])("%s = %s refuses loudly", (key, val) => {
    expect(() => parseNimbusTomlMcpSink(toml(`${key} = ${val}`))).toThrow(McpSinkConfigError);
  });
  test("in-range values are read", () => {
    const c = parseNimbusTomlMcpSink(toml("action_ttl_hours = 168", "action_max_pending = 1"));
    expect(c.actionTtlHours).toBe(168);
    expect(c.actionMaxPending).toBe(1);
  });
});
