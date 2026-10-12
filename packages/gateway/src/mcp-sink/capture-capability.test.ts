import { describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { MCP_CAPTURE_CAPABILITY, resolveCaptureCapability } from "./capture-capability.ts";

const ON = { ok: true as const, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } };
const OPEN = { capabilitiesDisabled: new Set<string>() };

describe("resolveCaptureCapability", () => {
  test("mcp_capture is a recognised AI v2 capability name", () => {
    expect(AI_V2_CAPABILITIES).toContain(MCP_CAPTURE_CAPABILITY);
  });

  test("enabled config + open policy → enabled, kinds = config ∩ submittable", () => {
    const c = resolveCaptureCapability(ON, OPEN);
    expect(c.enabled).toBe(true);
    expect(c.kinds).toEqual(["note"]);
  });

  test("config off → disabled: config", () => {
    const c = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    expect(c).toMatchObject({ enabled: false, reason: "config" });
  });

  test("bad config file → disabled: config_error", () => {
    expect(resolveCaptureCapability({ ok: false, error: "x" }, OPEN)).toMatchObject({
      enabled: false,
      reason: "config_error",
    });
  });

  test("policy lock-off → disabled: policy; ABSENT accessor fails closed the same way", () => {
    const locked = { capabilitiesDisabled: new Set<string>(["mcp_capture"]) };
    expect(resolveCaptureCapability(ON, locked)).toMatchObject({
      enabled: false,
      reason: "policy",
    });
    expect(resolveCaptureCapability(ON, undefined)).toMatchObject({
      enabled: false,
      reason: "policy",
    });
  });

  test("kinds naming only unsubmittable kinds → enabled flag stays true but kinds is empty", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["term"] } },
      OPEN,
    );
    expect(c.kinds).toEqual([]);
  });
});
