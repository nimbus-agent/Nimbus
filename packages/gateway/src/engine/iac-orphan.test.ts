import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { deriveCfnOrphan } from "./iac-orphan.ts";

const TEMPLATE = "Resources: {}\n";
const SHA = createHash("sha256").update(TEMPLATE, "utf8").digest("hex");
const NAME = `nimbus-${SHA}-0123456789ab`;
const ARN = `arn:aws:cloudformation:eu-west-1:123456789012:changeSet/${NAME}/00000000-0000-0000-0000-000000000000`;
const INPUT = { stackName: "prod", templateBody: TEMPLATE };
const REPLY = { stackName: "prod", changeSetName: NAME, changeSetId: ARN };

describe("deriveCfnOrphan", () => {
  test("a reply the gateway can prove is this template's change set on this stack", () => {
    expect(deriveCfnOrphan(INPUT, REPLY)).toEqual({ stackName: "prod", changeSetId: ARN });
  });

  test.each([
    ["not an object input", [null, REPLY]],
    ["no template", [{ stackName: "prod" }, REPLY]],
    ["a non-string template", [{ stackName: "prod", templateBody: 3 }, REPLY]],
    ["a non-string stack", [{ stackName: 3, templateBody: TEMPLATE }, REPLY]],
    [
      "a stack name that is not a plain stack name",
      [
        { ...INPUT, stackName: "a/b" },
        { ...REPLY, stackName: "a/b" },
      ],
    ],
    [
      "an over-long stack name",
      [
        { ...INPUT, stackName: `a${"b".repeat(128)}` },
        { ...REPLY, stackName: `a${"b".repeat(128)}` },
      ],
    ],
    ["another stack in the reply", [INPUT, { ...REPLY, stackName: "other" }]],
    ["no name", [INPUT, { ...REPLY, changeSetName: undefined }]],
    ["no id", [INPUT, { ...REPLY, changeSetId: 4 }]],
    [
      "a name without this template's hash",
      [INPUT, { ...REPLY, changeSetName: `nimbus-${"1".repeat(64)}-0123456789ab` }],
    ],
    ["a name with the wrong suffix", [INPUT, { ...REPLY, changeSetName: `nimbus-${SHA}-xyz` }]],
    ["an id that is not an ARN", [INPUT, { ...REPLY, changeSetId: "prod" }]],
    [
      "an ARN of another change set",
      [INPUT, { ...REPLY, changeSetId: ARN.replace("0123456789ab", "ba9876543210") }],
    ],
    ["no reply", [INPUT, undefined]],
    ["an inherited field", [INPUT, Object.create({ ...REPLY })]],
  ] as Array<[string, [unknown, unknown]]>)("%s names no target", (_n, [input, reply]) => {
    expect(deriveCfnOrphan(input, reply)).toBeUndefined();
  });
});

import { PREPARE_REFUSALS, PrepareRefusedError, prepareLeftover } from "./prepare-step.ts";

describe("prepareLeftover", () => {
  const orphan = { stackName: "prod", changeSetId: ARN };

  test("a refusal that carries a proven change set hands it on", () => {
    const e = new PrepareRefusedError(PREPARE_REFUSALS.diffTooLarge);
    e.orphan = orphan;
    expect(prepareLeftover(e)).toEqual({ orphan, unproven: false });
  });

  test("a timeout or a failed child with no proof is unproven", () => {
    for (const reason of [PREPARE_REFUSALS.timeout, PREPARE_REFUSALS.failed]) {
      expect(prepareLeftover(new PrepareRefusedError(reason))).toEqual({ unproven: true });
    }
  });

  test("any other refusal, error or non-error leaves nothing to say", () => {
    expect(prepareLeftover(new PrepareRefusedError(PREPARE_REFUSALS.unbound))).toEqual({
      unproven: false,
    });
    expect(prepareLeftover(new Error("x"))).toEqual({ unproven: false });
    expect(prepareLeftover(null)).toEqual({ unproven: false });
  });
});
