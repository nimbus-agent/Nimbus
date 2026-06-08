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
});
