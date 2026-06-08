import { describe, expect, test } from "bun:test";
import { partitionByAllowlist } from "./connector-allowlist.ts";

describe("partitionByAllowlist", () => {
  test("undefined allow => everything permitted, nothing blocked", () => {
    const r = partitionByAllowlist(["github", "slack"], undefined);
    expect(r.permitted).toEqual(["github", "slack"]);
    expect(r.blocked).toEqual([]);
  });
  test("only allowlisted ids are permitted; the rest are blocked", () => {
    const r = partitionByAllowlist(["github", "slack", "jira"], ["github"]);
    expect(r.permitted).toEqual(["github"]);
    expect(r.blocked).toEqual(["slack", "jira"]);
  });
  test("allow listing an id absent from configured does not invent it", () => {
    const r = partitionByAllowlist(["github"], ["github", "notion"]);
    expect(r.permitted).toEqual(["github"]);
    expect(r.blocked).toEqual([]);
  });
});
