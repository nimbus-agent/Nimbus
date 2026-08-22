import { describe, expect, test } from "bun:test";
import { parsePolicyToml, serializePolicyToml } from "./policy-toml.ts";

const SAMPLE = `
[policy]
version = 1
org = "acme"
issued_at = "2026-06-07T00:00:00Z"

[policy.connectors]
allow = ["github", "slack", "jira"]

[policy.retention]
min_days = 30

[policy.hitl]
require = ["db.drop", "vault.export"]

[policy.hitl.quorum."terraform.destroy"]
approvers = 2
window_seconds = 3600

[policy.audit]
ship_to = "https://siem.acme.internal/ingest"
ship_format = "ndjson"
`;

describe("parsePolicyToml", () => {
  test("parses all sections", () => {
    const p = parsePolicyToml(SAMPLE);
    expect(p.version).toBe(1);
    expect(p.org).toBe("acme");
    expect(p.connectors.allow).toEqual(["github", "slack", "jira"]);
    expect(p.retention.minDays).toBe(30);
    expect(p.hitl.require).toEqual(["db.drop", "vault.export"]);
    expect(p.hitl.quorum.get("terraform.destroy")).toEqual({ approvers: 2, windowSeconds: 3600 });
    expect(p.audit.shipTo).toBe("https://siem.acme.internal/ingest");
  });

  test("absent connectors section => unrestricted (allow undefined)", () => {
    const p = parsePolicyToml(`[policy]\nversion = 1\norg = "x"\n`);
    expect(p.connectors.allow).toBeUndefined();
    expect(p.retention.minDays).toBe(0);
    expect(p.hitl.require).toEqual([]);
    expect(p.hitl.quorum.size).toBe(0);
    expect(p.audit.shipTo).toBeUndefined();
  });

  test("round-trips through serialize→parse", () => {
    const p = parsePolicyToml(SAMPLE);
    expect(parsePolicyToml(serializePolicyToml(p))).toEqual(p);
  });

  test("empty quorum id header is ignored (line 37 false side)", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "x"\n[policy.hitl.quorum.""]\napprovers = 2\nwindow_seconds = 60\n`,
    );
    // empty id => quorumId stays undefined => no rule accumulated
    expect(p.hitl.quorum.size).toBe(0);
  });

  test("duplicate quorum section for the same id merges into one accumulator (line 39 false side)", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "x"\n` +
        `[policy.hitl.quorum."t.d"]\napprovers = 2\n` +
        `[policy.hitl.quorum."t.d"]\nwindow_seconds = 90\n`,
    );
    expect(p.hitl.quorum.get("t.d")).toEqual({ approvers: 2, windowSeconds: 90 });
  });

  test("a line with no '=' under a section is skipped (line 48 kv===undefined true side)", () => {
    const p = parsePolicyToml(`[policy]\nversion = 1\norg = "x"\nbarewordnoequals\n`);
    expect(p.version).toBe(1);
    expect(p.org).toBe("x");
  });

  test("unknown section falls through the switch default (line 50 default arm)", () => {
    const p = parsePolicyToml(`[policy]\nversion = 1\norg = "x"\n[policy.unknown]\nfoo = "bar"\n`);
    expect(p.version).toBe(1);
  });

  test("unrecognized keys within each section are ignored (else arms)", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "x"\nstray = "z"\n` +
        `[policy.connectors]\nbogus = "y"\n` +
        `[policy.retention]\nbogus = 1\n` +
        `[policy.hitl]\nbogus = []\n` +
        `[policy.audit]\nbogus = "y"\n`,
    );
    expect(p.version).toBe(1);
    expect(p.org).toBe("x");
    expect(p.connectors.allow).toBeUndefined();
    expect(p.retention.minDays).toBe(0);
    expect(p.hitl.require).toEqual([]);
    expect(p.audit.shipTo).toBeUndefined();
    expect(p.audit.shipFormat).toBeUndefined();
  });

  test("[policy] issued_at present is captured (line 54 issued_at arm true)", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "x"\nissued_at = "2026-06-08T00:00:00Z"\n`,
    );
    expect(p.issuedAt).toBe("2026-06-08T00:00:00Z");
  });

  test("quorum rule missing fields defaults to 0 and is dropped (lines 81-83 default + filter arms)", () => {
    // No approvers/window keys: parseIntDec("") -> undefined -> ?? 0 -> approvers 0 -> filtered out.
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "x"\n[policy.hitl.quorum."t.d"]\nirrelevant = "v"\n`,
    );
    expect(p.hitl.quorum.size).toBe(0);
  });

  test("quorum with approvers but window_seconds 0 is dropped (line 83 windowSeconds>0 false)", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "x"\n[policy.hitl.quorum."t.d"]\napprovers = 2\nwindow_seconds = 0\n`,
    );
    expect(p.hitl.quorum.size).toBe(0);
  });

  test("serialize emits audit block when only shipFormat is set (lines 121/123/124 arms)", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "x"\n[policy.audit]\nship_format = "ndjson"\n`,
    );
    const out = serializePolicyToml(p);
    expect(out).toContain("[policy.audit]");
    expect(out).toContain('ship_format = "ndjson"');
    expect(out).not.toContain("ship_to");
  });

  test("serialize emits audit block when only shipTo is set (line 124 ship_format false arm)", () => {
    const p = parsePolicyToml(`[policy]\nversion = 1\norg = "x"\n[policy.audit]\nship_to = "u"\n`);
    const out = serializePolicyToml(p);
    expect(out).toContain('ship_to = "u"');
    expect(out).not.toContain("ship_format");
  });

  test("round-trips audit.shipFormat without shipTo", () => {
    const p = parsePolicyToml(
      `[policy]\nversion = 1\norg = "x"\n[policy.audit]\nship_format = "ndjson"\n`,
    );
    expect(p.audit.shipFormat).toBe("ndjson");
    expect(p.audit.shipTo).toBeUndefined();
    expect(parsePolicyToml(serializePolicyToml(p))).toEqual(p);
  });
});

describe("[policy.capabilities.ai_v2]", () => {
  const head = `[policy]\nversion = 1\norg = "acme"\n`;

  test("false DISABLES a capability", () => {
    const p = parsePolicyToml(`${head}[policy.capabilities.ai_v2]\ncode_execution = false\n`);
    expect(p.capabilities.disabled).toContain("code_execution");
  });

  test("true is a NO-OP, not a grant -- policy can only tighten", () => {
    const p = parsePolicyToml(`${head}[policy.capabilities.ai_v2]\ncode_execution = true\n`);
    expect(p.capabilities.disabled).not.toContain("code_execution");
  });

  test("an unknown capability name is ignored", () => {
    const p = parsePolicyToml(`${head}[policy.capabilities.ai_v2]\nmind_reading = false\n`);
    expect(p.capabilities.disabled).not.toContain("mind_reading");
  });

  test("absent block yields an empty list", () => {
    expect(parsePolicyToml(head).capabilities.disabled).toEqual([]);
  });

  test("disables several capabilities at once", () => {
    const p = parsePolicyToml(
      `${head}[policy.capabilities.ai_v2]\ncode_execution = false\ncomputer_use = false\n`,
    );
    expect([...p.capabilities.disabled].sort()).toEqual(["code_execution", "computer_use"]);
  });

  test("round-trips through the serializer", () => {
    const p = parsePolicyToml(`${head}[policy.capabilities.ai_v2]\ncode_execution = false\n`);
    expect(parsePolicyToml(serializePolicyToml(p))).toEqual(p);
  });
});
