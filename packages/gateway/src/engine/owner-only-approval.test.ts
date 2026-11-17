// The shared owner-only ask (I20, I55, I59): a person must answer, and the audit id is the sink's own.
import { describe, expect, test } from "bun:test";
import { createStandingOwnerAsk } from "../ipc/standing-rpc.ts";
import { createOwnerOnlyAsk } from "./owner-only-approval.ts";
import type { AnswerSource, AuditSink, ConsentChannel, PlannedAction } from "./types.ts";

const ACTION: PlannedAction = { type: "workflow.import", payload: { name: "x", promptText: "p" } };

function consent(answerSource: AnswerSource, approved = true): ConsentChannel {
  return { requestApproval: async () => ({ approved, answerSource }) };
}

function sink(): { audit: AuditSink; rows: string[] } {
  const rows: string[] = [];
  return {
    rows,
    audit: {
      recordAudit(entry) {
        rows.push(entry.hitlStatus);
        return rows.length;
      },
    },
  };
}

describe("createOwnerOnlyAsk", () => {
  test("a human approval carries the id of the row the sink appended", async () => {
    const s = sink();
    const ask = createOwnerOnlyAsk({ consent: consent("human"), audit: s.audit });
    expect(await ask(ACTION)).toEqual({ approved: true, auditId: 1 });
    expect(s.rows).toEqual(["approved"]);
  });

  test.each(["auto", "script", "unknown", "delegate", "remote"] as const)(
    "an approval whose source is %s is declined as not_human and recorded as rejected",
    async (source) => {
      const s = sink();
      const ask = createOwnerOnlyAsk({ consent: consent(source), audit: s.audit });
      expect(await ask(ACTION)).toEqual({ approved: false, reason: "not_human" });
      expect(s.rows).toEqual(["rejected"]);
    },
  );

  test("a human decline is a plain decline", async () => {
    const s = sink();
    const ask = createOwnerOnlyAsk({ consent: consent("human", false), audit: s.audit });
    expect(await ask(ACTION)).toEqual({ approved: false, reason: "declined" });
  });

  test("a sink that returns no id leaves the approval undecided: declined (fail closed)", async () => {
    const ask = createOwnerOnlyAsk({
      consent: consent("human"),
      audit: { recordAudit: () => undefined },
    });
    expect(await ask(ACTION)).toEqual({ approved: false, reason: "declined" });
  });

  test("an unrelated audit row appended around the approval does not become its id", async () => {
    let n = 0;
    const ask = createOwnerOnlyAsk({
      consent: consent("human"),
      audit: {
        recordAudit() {
          n += 1;
          return n === 1 ? 1 : 99;
        },
      },
    });
    expect(await ask(ACTION)).toEqual({ approved: true, auditId: 1 });
  });

  test("the standing-rule ask is the same function under its old name", () => {
    expect(createStandingOwnerAsk).toBe(createOwnerOnlyAsk);
  });
});
