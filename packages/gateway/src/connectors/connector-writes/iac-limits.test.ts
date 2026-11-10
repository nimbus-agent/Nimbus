// packages/gateway/src/connectors/connector-writes/iac-limits.test.ts
// Phase 9.7 D2 (Task 1): the iac limits, the fixed refusal reasons and the two pure input hooks.
import { describe, expect, test } from "bun:test";
import { CONFIRM_MAX_LENGTH } from "./confirm-template.ts";
import {
  CFN_INPUT_KEYS,
  cfnInputRefusal,
  IAC_INPUT_REFUSALS,
  IAC_LIMITS,
  TERRAFORM_INPUT_KEYS,
  terraformInputRefusal,
} from "./iac-limits.ts";

const BS = String.fromCharCode(92);

describe("IAC_LIMITS", () => {
  test("pins the numbers of the plan", () => {
    expect(IAC_LIMITS.maxPlanFileBytes).toBe(16 * 1024 * 1024);
    expect(IAC_LIMITS.maxPlanJsonBytes).toBe(4 * 1024 * 1024);
    expect(IAC_LIMITS.maxChanges).toBe(500);
    expect(IAC_LIMITS.maxRenderedBytes).toBe(65_536);
    expect(IAC_LIMITS.maxValueChars).toBe(120);
    expect(IAC_LIMITS.maxTemplateBytes).toBe(51_200);
    expect(IAC_LIMITS.terraform.budgetMs).toBe(10 * 60_000);
    expect(IAC_LIMITS.cfn.budgetMs).toBe(150_000);
    expect(Object.isFrozen(IAC_LIMITS)).toBe(true);
    expect(Object.isFrozen(IAC_LIMITS.terraform)).toBe(true);
    expect(Object.isFrozen(IAC_LIMITS.cfn)).toBe(true);
  });

  test("relationships: gateway caps are tighter than the connector's, the plan text fits one IPC line", () => {
    // The connector's own caps: plan file 64 MiB, plan JSON 4 MiB, 500 changes, reply 256 KiB.
    expect(IAC_LIMITS.maxPlanFileBytes).toBeLessThan(64 * 1024 * 1024);
    expect(IAC_LIMITS.maxPlanJsonBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(IAC_LIMITS.cfn.maxReplyChars).toBe(262_144);
    // The plan text travels in the prompt and in the details; one line is 1 MiB. The whole frame
    // is measured in the renderer task; this is the plan text alone, JSON-doubled, twice.
    expect(IAC_LIMITS.maxRenderedBytes * 2 * 2).toBeLessThan((1024 * 1024) / 2);
    // A template of the maximum size fits the input backstop with escaping headroom.
    expect(IAC_LIMITS.cfn.maxInputChars).toBeGreaterThan(IAC_LIMITS.maxTemplateBytes);
    // The confirm text `iac/destroy <path>` stays within the confirm cap for the longest path.
    expect(IAC_LIMITS.maxWorkdirChars + "iac/destroy ".length).toBeLessThanOrEqual(
      CONFIRM_MAX_LENGTH,
    );
  });

  test("the budgets are positive integers and the show budget is below the plan's", () => {
    for (const n of [
      IAC_LIMITS.terraform.budgetMs,
      IAC_LIMITS.cfn.budgetMs,
      IAC_LIMITS.showBudgetMs,
    ]) {
      expect(Number.isInteger(n) && n > 0).toBe(true);
    }
    expect(IAC_LIMITS.showBudgetMs).toBeLessThan(IAC_LIMITS.terraform.budgetMs);
  });
});

describe("IAC_INPUT_REFUSALS", () => {
  test("every reason is frozen fixed text that echoes no input", () => {
    expect(Object.isFrozen(IAC_INPUT_REFUSALS)).toBe(true);
    for (const reason of Object.values(IAC_INPUT_REFUSALS)) {
      expect(reason.startsWith("iac: ")).toBe(true);
      expect(reason).not.toContain("{");
    }
    expect(new Set(Object.values(IAC_INPUT_REFUSALS)).size).toBe(
      Object.values(IAC_INPUT_REFUSALS).length,
    );
  });

  test("no refusal returned for a hostile input contains any part of it", () => {
    const hostile = "SECRET-MARKER";
    const outs = [
      terraformInputRefusal({ workingDirectory: `/${hostile}/../x` }),
      terraformInputRefusal({ [hostile]: 1, workingDirectory: "/ok" }),
      cfnInputRefusal({ stackName: `${hostile}!`, templateBody: "t" }),
      cfnInputRefusal({ stackName: "s", templateBody: "t", [hostile]: 1 }),
    ];
    for (const o of outs) {
      expect(o).toBeDefined();
      expect(o).not.toContain(hostile);
    }
  });
});

describe("terraformInputRefusal", () => {
  test("accepts a canonical-form absolute POSIX path and a Windows drive path", () => {
    expect(terraformInputRefusal({ workingDirectory: "/srv/infra/prod" })).toBeUndefined();
    expect(terraformInputRefusal({ workingDirectory: `C:${BS}infra${BS}prod` })).toBeUndefined();
    expect(terraformInputRefusal({ workingDirectory: "C:/infra/prod" })).toBeUndefined();
  });

  test("the declared keys are exactly workingDirectory", () => {
    expect([...TERRAFORM_INPUT_KEYS]).toEqual(["workingDirectory"]);
  });

  test.each([
    ["not an object", null, "inputInvalid"],
    ["an array", [], "inputInvalid"],
    ["no workingDirectory", {}, "workdirInvalid"],
    ["not a string", { workingDirectory: 7 }, "workdirInvalid"],
    ["empty", { workingDirectory: "" }, "workdirInvalid"],
    ["relative", { workingDirectory: "infra/prod" }, "workdirNotAbsolute"],
    ["dot relative", { workingDirectory: "./infra" }, "workdirNotAbsolute"],
    ["a flag", { workingDirectory: "-chdir=/x" }, "workdirNotAbsolute"],
    ["UNC", { workingDirectory: `${BS}${BS}host${BS}share` }, "workdirNotAbsolute"],
    ["device", { workingDirectory: `${BS}${BS}?${BS}C:${BS}x` }, "workdirNotAbsolute"],
    ["forward-slash UNC", { workingDirectory: "//host/share" }, "workdirNotCanonical"],
    ["dot-dot", { workingDirectory: "/srv/../etc" }, "workdirNotCanonical"],
    ["dot-dot (windows)", { workingDirectory: `C:${BS}a${BS}..${BS}b` }, "workdirNotCanonical"],
    ["dot segment", { workingDirectory: "/srv/./x" }, "workdirNotCanonical"],
    ["empty segment", { workingDirectory: "/srv//x" }, "workdirNotCanonical"],
    ["trailing separator", { workingDirectory: "/srv/x/" }, "workdirNotCanonical"],
    ["a drive root", { workingDirectory: `C:${BS}` }, "workdirNotCanonical"],
    ["the root", { workingDirectory: "/" }, "workdirNotCanonical"],
    ["backslash in a POSIX path", { workingDirectory: `/srv${BS}x` }, "workdirNotCanonical"],
    ["alternate data stream", { workingDirectory: `C:${BS}x${BS}y:stream` }, "workdirNotCanonical"],
    ["a NUL", { workingDirectory: "/srv/\u0000x" }, "workdirUnshowable"],
    ["a newline", { workingDirectory: "/srv/\nx" }, "workdirUnshowable"],
    ["a right-to-left override", { workingDirectory: "/srv/\u202Ex" }, "workdirUnshowable"],
    ["a zero-width space", { workingDirectory: "/srv/\u200Bx" }, "workdirUnshowable"],
    ["not NFC", { workingDirectory: "/srv/e\u0301" }, "workdirUnshowable"],
    ["a lone surrogate", { workingDirectory: "/srv/\ud800" }, "workdirUnshowable"],
    [
      "too long",
      { workingDirectory: `/${"a".repeat(IAC_LIMITS.maxWorkdirChars)}` },
      "workdirTooLong",
    ],
    ["an extra key", { workingDirectory: "/ok", planFile: "/x" }, "fieldNotTaken"],
  ])("refuses %s", (_name, input, key) => {
    expect(terraformInputRefusal(input as never)).toBe(
      IAC_INPUT_REFUSALS[key as keyof typeof IAC_INPUT_REFUSALS],
    );
  });

  test("accepts a path exactly at the length limit", () => {
    const p = `/${"a".repeat(IAC_LIMITS.maxWorkdirChars - 1)}`;
    expect(p).toHaveLength(IAC_LIMITS.maxWorkdirChars);
    expect(terraformInputRefusal({ workingDirectory: p })).toBeUndefined();
  });

  test("an own __proto__ key is a field this write does not take", () => {
    const input = JSON.parse('{"workingDirectory":"/ok","__proto__":{"x":1}}') as Record<
      string,
      unknown
    >;
    expect(terraformInputRefusal(input)).toBe(IAC_INPUT_REFUSALS.fieldNotTaken);
  });
});

const okCfn = (extra: Record<string, unknown> = {}) => ({
  stackName: "app-prod",
  templateBody: '{"Resources":{}}',
  ...extra,
});

describe("cfnInputRefusal", () => {
  test("accepts the minimal input, every capability once, and a template of the maximum size", () => {
    expect(cfnInputRefusal(okCfn())).toBeUndefined();
    expect(
      cfnInputRefusal(
        okCfn({
          capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"],
        }),
      ),
    ).toBeUndefined();
    expect(cfnInputRefusal(okCfn({ capabilities: [] }))).toBeUndefined();
    expect(
      cfnInputRefusal(okCfn({ templateBody: "a".repeat(IAC_LIMITS.maxTemplateBytes) })),
    ).toBeUndefined();
  });

  test("the declared keys are the write's own keys minus changeSetId", () => {
    expect([...CFN_INPUT_KEYS]).toEqual(["stackName", "templateBody", "capabilities"]);
  });

  test.each([
    ["not an object", "x", "inputInvalid"],
    ["an extra key", okCfn({ changeSetId: "x" }), "fieldNotTaken"],
    ["no stack", { templateBody: "t" }, "stackNameInvalid"],
    ["stack not a string", okCfn({ stackName: 5 }), "stackNameInvalid"],
    ["stack with a slash", okCfn({ stackName: "a/b" }), "stackNameInvalid"],
    ["stack starting with a digit", okCfn({ stackName: "1abc" }), "stackNameInvalid"],
    ["stack starting with a dash", okCfn({ stackName: "-abc" }), "stackNameInvalid"],
    ["stack that is a file:// load", okCfn({ stackName: "file://x" }), "stackNameInvalid"],
    ["stack over 128 chars", okCfn({ stackName: `a${"b".repeat(128)}` }), "stackNameInvalid"],
    ["stack with a space", okCfn({ stackName: "a b" }), "stackNameInvalid"],
    ["no template", { stackName: "s" }, "templateInvalid"],
    ["empty template", okCfn({ templateBody: "" }), "templateInvalid"],
    ["template not a string", okCfn({ templateBody: {} }), "templateInvalid"],
    ["template with a NUL", okCfn({ templateBody: "a\u0000b" }), "templateInvalid"],
    ["template with a lone surrogate", okCfn({ templateBody: "a\ud800" }), "templateInvalid"],
    [
      "template over 51,200 characters",
      okCfn({ templateBody: "a".repeat(IAC_LIMITS.maxTemplateBytes + 1) }),
      "templateTooLarge",
    ],
    [
      "template under 51,200 characters but over in UTF-8 bytes",
      okCfn({ templateBody: "\u00e9".repeat(IAC_LIMITS.maxTemplateBytes / 2 + 1) }),
      "templateTooLarge",
    ],
    ["capabilities not a list", okCfn({ capabilities: "CAPABILITY_IAM" }), "capabilitiesInvalid"],
    ["capabilities null", okCfn({ capabilities: null }), "capabilitiesInvalid"],
    ["unknown capability", okCfn({ capabilities: ["CAPABILITY_ROOT"] }), "capabilitiesInvalid"],
    ["non-string capability", okCfn({ capabilities: [1] }), "capabilitiesInvalid"],
    [
      "four capabilities",
      okCfn({
        capabilities: ["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND", "x"],
      }),
      "capabilitiesInvalid",
    ],
    [
      "a duplicate capability",
      okCfn({ capabilities: ["CAPABILITY_IAM", "CAPABILITY_IAM"] }),
      "capabilitiesDuplicate",
    ],
  ])("refuses %s", (_name, input, key) => {
    expect(cfnInputRefusal(input as never)).toBe(
      IAC_INPUT_REFUSALS[key as keyof typeof IAC_INPUT_REFUSALS],
    );
  });
});
