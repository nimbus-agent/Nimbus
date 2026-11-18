import { describe, expect, test } from "bun:test";

import {
  assertIncidentLink,
  assertLinkedActionAllowed,
  assertRunbookStep,
  isIncidentLink,
  PROMPT_ROW_MAX_ESCAPED,
  promptForRow,
} from "./incident-link.ts";

const ID = "inc_0123456789abcdef";

describe("incident link shape (IC4 2.1)", () => {
  test("accepts exactly { id, version }, including a null-prototype object", () => {
    expect(isIncidentLink({ id: ID, version: 1 })).toBe(true);
    expect(isIncidentLink({ id: ID, version: 1_000_000 })).toBe(true);
    expect(isIncidentLink(Object.assign(Object.create(null), { id: ID, version: 3 }))).toBe(true);
  });

  const bad: [string, unknown][] = [
    ["uppercase hex", { id: "inc_0123456789ABCDEF", version: 1 }],
    ["short id", { id: "inc_0123", version: 1 }],
    ["long id", { id: `${ID}0`, version: 1 }],
    ["no prefix", { id: "0123456789abcdef", version: 1 }],
    ["non-hex digit", { id: "inc_0123456789abcdeg", version: 1 }],
    ["version 0", { id: ID, version: 0 }],
    ["version -1", { id: ID, version: -1 }],
    ["version 1.5", { id: ID, version: 1.5 }],
    ["version too large", { id: ID, version: 1_000_001 }],
    ["version string", { id: ID, version: "1" }],
    ["NaN version", { id: ID, version: Number.NaN }],
    ["extra key", { id: ID, version: 1, extra: true }],
    ["missing version", { id: ID }],
    ["array", [ID, 1]],
    ["null", null],
    ["string", ID],
    [
      "class instance",
      new (class L {
        id = ID;
        version = 1;
      })(),
    ],
    ["getter", Object.defineProperty({ version: 1 }, "id", { get: () => ID, enumerable: true })],
    ["symbol key", { id: ID, version: 1, [Symbol("x")]: 1 }],
  ];
  for (const [name, value] of bad) {
    test(`refuses ${name}`, () => {
      expect(isIncidentLink(value)).toBe(false);
      expect(() => assertIncidentLink(value)).toThrow();
    });
  }
});

describe("promptForRow redacts BEFORE it cuts (review: a credential across the cut)", () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

  test("a credential that crosses the cut leaves no prefix of itself; the hash is over the whole shown text", () => {
    // 1,590 ordinary characters, then the credential: the 1,600-character cut falls inside it
    const shown = `${"x".repeat(PROMPT_ROW_MAX_ESCAPED - 13)} ${secret}`;
    const p = promptForRow(shown);
    expect(p.prompt).not.toContain("ghp_");
    expect(p.prompt).not.toContain("ghp");
    expect(p.prompt).toContain("[REDACTED]");
    expect(p.promptSha256).toBe(new Bun.CryptoHasher("sha256").update(shown).digest("hex"));
  });

  test("a credential fully inside the cut is still redacted and an uncut text is untouched", () => {
    expect(promptForRow(`a ${secret} b`).prompt).toBe("a [REDACTED] b");
    expect(promptForRow("plain").promptCut).toBe(false);
  });
});

describe("the runbook step beside a link (IC6, I57 (c))", () => {
  const link = { id: "inc_0123456789abcdef", version: 1 };
  const read = { runbook: "pay-rollback", step: 2, kind: "read" as const };
  const act = {
    runbook: "pay-rollback",
    step: 3,
    kind: "action" as const,
    reversibility: "reversible" as const,
  };

  test("a well-formed read or action step beside a link passes", () => {
    expect(() =>
      assertLinkedActionAllowed({ incident: link, runbookStep: read }, undefined),
    ).not.toThrow();
    expect(() =>
      assertLinkedActionAllowed({ incident: link, runbookStep: act }, undefined),
    ).not.toThrow();
    expect(() => assertRunbookStep(read)).not.toThrow();
  });

  test("a step with no link, beside an engine proposal, or of the wrong shape is refused", () => {
    expect(() => assertLinkedActionAllowed({ runbookStep: read }, undefined)).toThrow(
      "a runbook step is carried only by an incident-linked action",
    );
    expect(() =>
      assertLinkedActionAllowed(
        {
          incident: link,
          runbookStep: act,
          engineProposal: { proposalId: "prp_0123456789abcdef", reversibility: "unknown" },
        },
        undefined,
      ),
    ).toThrow("an action is a runbook step or an engine proposal, never both");
    for (const bad of [
      null,
      { ...read, step: 0 },
      { ...read, step: 51 },
      { ...read, step: 1.5 },
      { ...read, runbook: "Bad Name\u001b" },
      { ...read, reversibility: "reversible" },
      { ...act, reversibility: "maybe" },
      { runbook: "x", step: 1, kind: "check" },
      { ...read, extra: 1 },
    ]) {
      expect(() => assertRunbookStep(bad), JSON.stringify(bad)).toThrow(
        "a runbook step must be exactly",
      );
    }
  });
});
