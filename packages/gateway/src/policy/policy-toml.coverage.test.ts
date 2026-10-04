/**
 * `parsePolicyToml` inputs the other policy suites do not write: non-integer numbers, and the
 * ChatOps channel bindings that must come out INERT or at their fail-closed default — an empty
 * channel id, a binding with no namespace, an unknown `unmapped` mode — plus a channel declared in
 * two blocks. An org policy only ever tightens (I22), so each of these is a case where reading the
 * file too generously would loosen something.
 */
import { describe, expect, test } from "bun:test";
import { parsePolicyToml } from "./policy-toml.ts";

describe("parsePolicyToml — non-integer numbers", () => {
  test("a version or min_days that is not a decimal integer reads as 0", () => {
    const p = parsePolicyToml(
      ["[policy]", 'version = "two"', "", "[policy.retention]", "min_days = 30.5"].join("\n"),
    );
    expect(p.version).toBe(0);
    expect(p.retention.minDays).toBe(0);
  });

  test("decimal integers are read as such", () => {
    const p = parsePolicyToml(
      ["[policy]", "version = 3", "[policy.retention]", "min_days = 90"].join("\n"),
    );
    expect(p.version).toBe(3);
    expect(p.retention.minDays).toBe(90);
  });
});

describe("parsePolicyToml — ChatOps channel bindings", () => {
  test("an empty channel id opens no binding; its keys are ignored, not given to the next channel", () => {
    const p = parsePolicyToml(
      [
        '[policy.chatops.channel.""]',
        'namespace = "eng"',
        'unmapped = "public-read"',
        '[policy.chatops.channel."C1"]',
        'namespace = "ops"',
      ].join("\n"),
    );
    expect([...p.chatops.channels.keys()]).toEqual(["C1"]);
    expect(p.chatops.channels.get("C1")).toEqual({
      namespace: "ops",
      unmapped: "refuse",
      notify: [],
    });
  });

  test("a channel declared in two blocks is one binding with both blocks' keys", () => {
    const p = parsePolicyToml(
      [
        '[policy.chatops.channel."C2"]',
        'namespace = "eng"',
        "[policy.hitl]",
        'require = ["slack.message.post"]',
        '[policy.chatops.channel."C2"]',
        'unmapped = "public-read"',
        'notify = ["C9"]',
      ].join("\n"),
    );
    expect(p.chatops.channels.get("C2")).toEqual({
      namespace: "eng",
      unmapped: "public-read",
      notify: ["C9"],
    });
    expect(p.hitl.require).toEqual(["slack.message.post"]);
  });

  test("a binding with no namespace, or an empty one, is dropped as inert", () => {
    const p = parsePolicyToml(
      [
        '[policy.chatops.channel."NO_NS"]',
        'unmapped = "public-read"',
        '[policy.chatops.channel."EMPTY_NS"]',
        'namespace = ""',
        '[policy.chatops.channel."OK"]',
        'namespace = "eng"',
      ].join("\n"),
    );
    expect([...p.chatops.channels.keys()]).toEqual(["OK"]);
  });

  test("any unmapped mode other than public-read is refuse", () => {
    const p = parsePolicyToml(
      [
        '[policy.chatops.channel."A"]',
        'namespace = "eng"',
        'unmapped = "open"',
        '[policy.chatops.channel."B"]',
        'namespace = "eng"',
        'unmapped = "PUBLIC-READ"',
      ].join("\n"),
    );
    expect(p.chatops.channels.get("A")?.unmapped).toBe("refuse");
    expect(p.chatops.channels.get("B")?.unmapped).toBe("refuse");
  });

  test("ownership entries are read with both sides unquoted", () => {
    const p = parsePolicyToml(
      ["[policy.chatops.ownership]", '"svc-*" = "team-a"', 'billing = "team-b"'].join("\n"),
    );
    expect([...p.chatops.ownership.entries()]).toEqual([
      ["svc-*", "team-a"],
      ["billing", "team-b"],
    ]);
  });
});
