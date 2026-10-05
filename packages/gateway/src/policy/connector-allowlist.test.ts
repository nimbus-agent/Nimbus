import { describe, expect, test } from "bun:test";
import { connectorAllowPredicate, partitionByAllowlist } from "./connector-allowlist.ts";

describe("connectorAllowPredicate", () => {
  test("asks the gate on every call: no allowlist allows all, a list allows its members only", () => {
    let allow: readonly string[] | undefined;
    let reads = 0;
    const isAllowed = connectorAllowPredicate({
      enforced: () => {
        reads++;
        return allow === undefined ? {} : { connectorAllow: allow };
      },
    });
    expect(reads).toBe(0); // building the predicate reads nothing
    expect(isAllowed("github")).toBe(true);
    allow = ["github"];
    expect(isAllowed("github")).toBe(true);
    expect(isAllowed("github_actions")).toBe(false);
    allow = [];
    expect(isAllowed("github")).toBe(false);
    expect(reads).toBe(4);
  });
});

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
