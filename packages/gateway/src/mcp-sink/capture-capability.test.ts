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
    expect(c.kinds).toEqual(["note", "decision", "term", "link"]);
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

  // The SUBMITTABLE_KINDS filter is vacuous since PR 2 (it equals CAPTURE_KINDS); this becomes a
  // filter test again when a kind is added to CAPTURE_KINDS before it is submittable.
  test("a configured subset resolves to exactly that subset, in configured order", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["term", "note"] } },
      OPEN,
    );
    expect(c.kinds).toEqual(["term", "note"]);
  });
});

describe("actionEnabled (PR 3)", () => {
  const base = { ...DEFAULT_MCP_SINK_CONFIG, enabled: true };
  const open = { capabilitiesDisabled: new Set<string>() };
  test("off when action is not in kinds", () => {
    expect(resolveCaptureCapability({ ok: true, config: base }, open).actionEnabled).toBe(false);
  });
  test("on when the sink is on and action is listed", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...base, kinds: ["note", "action"] } },
      open,
    );
    expect(c.enabled).toBe(true);
    expect(c.actionEnabled).toBe(true);
  });
  test("mcp_action lock-off disables actions only", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...base, kinds: ["note", "action"] } },
      { capabilitiesDisabled: new Set(["mcp_action"]) },
    );
    expect(c.enabled).toBe(true);
    expect(c.actionEnabled).toBe(false);
  });
  test("mcp_capture lock-off disables both", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...base, kinds: ["action"] } },
      { capabilitiesDisabled: new Set(["mcp_capture"]) },
    );
    expect(c.enabled).toBe(false);
    expect(c.actionEnabled).toBe(false);
  });
  test("absent policy accessor: actionEnabled false (fail-closed)", () => {
    expect(
      resolveCaptureCapability({ ok: true, config: { ...base, kinds: ["action"] } }, undefined)
        .actionEnabled,
    ).toBe(false);
  });
  test("sink off by config: actionEnabled false", () => {
    expect(
      resolveCaptureCapability(
        { ok: true, config: { ...base, enabled: false, kinds: ["action"] } },
        open,
      ).actionEnabled,
    ).toBe(false);
  });
});
