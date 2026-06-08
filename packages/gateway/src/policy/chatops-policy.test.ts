import { describe, expect, test } from "bun:test";
import { resolveChannelBinding, resolveOwner } from "./chatops-policy.ts";
import { parsePolicyToml } from "./policy-toml.ts";

const TOML = `
[policy]
version=1
org="acme"
[policy.retention]
min_days=7
[policy.chatops.channel."C0SLACK1"]
namespace="project:payments"
unmapped="public-read"
notify=["C0SLACK1","C0ALERTS"]
[policy.chatops.channel."C0OPS"]
namespace="project:payments"
unmapped="refuse"
[policy.chatops.ownership]
"payment-service"="alice@acme.com"
"payment-*"="pay-lead@acme.com"
"*"="oncall@acme.com"
`;

describe("chatops policy parse + resolve", () => {
  const p = parsePolicyToml(TOML);

  test("channel binding: bound channel resolves namespace + unmapped mode", () => {
    const b = resolveChannelBinding(p.chatops, "C0SLACK1");
    expect(b?.namespace).toBe("project:payments");
    expect(b?.unmapped).toBe("public-read");
    expect(b?.notify).toEqual(["C0SLACK1", "C0ALERTS"]);
  });

  test("channel binding: unbound channel -> undefined (fail-closed)", () => {
    expect(resolveChannelBinding(p.chatops, "C0UNKNOWN")).toBeUndefined();
  });

  test("unmapped defaults to refuse when omitted", () => {
    expect(resolveChannelBinding(p.chatops, "C0OPS")?.unmapped).toBe("refuse");
  });

  test("owner: exact match wins over glob", () => {
    expect(resolveOwner(p.chatops, "payment-service")).toEqual({
      kind: "owner",
      email: "alice@acme.com",
    });
  });

  test("owner: longest-literal-prefix glob beats fallback", () => {
    expect(resolveOwner(p.chatops, "payment-api")).toEqual({
      kind: "owner",
      email: "pay-lead@acme.com",
    });
  });

  test("owner: fallback star", () => {
    expect(resolveOwner(p.chatops, "billing-x")).toEqual({
      kind: "owner",
      email: "oncall@acme.com",
    });
  });

  test("owner: equal-specificity collision -> ambiguous", () => {
    const collide = parsePolicyToml(
      `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=7\n[policy.chatops.ownership]\n"pay-*"="a@acme.com"\n"pay-?"="b@acme.com"\n`,
    );
    expect(resolveOwner(collide.chatops, "pay-1")).toEqual({ kind: "ambiguous" });
  });

  test("owner: no match + no fallback -> none", () => {
    const noFallback = parsePolicyToml(
      `[policy]\nversion=1\norg="acme"\n[policy.retention]\nmin_days=7\n[policy.chatops.ownership]\n"x-*"="a@acme.com"\n`,
    );
    expect(resolveOwner(noFallback.chatops, "y-1")).toEqual({ kind: "none" });
  });
});
