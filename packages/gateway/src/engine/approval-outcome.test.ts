import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";
import { DelegationStore } from "./delegation-store.ts";
import { gateResultOf, ToolExecutor } from "./executor.ts";
import type { AnswerSource, ConsentChannel } from "./types.ts";

describe("gateResultOf (Phase 10 SA1)", () => {
  test("approved maps to approved, with no reason", () => {
    expect(gateResultOf({ kind: "approved", answerSource: "human" })).toEqual({
      status: "approved",
    });
  });

  test("rejected maps to rejected and carries the reason", () => {
    expect(gateResultOf({ kind: "rejected", reason: "nope", answerSource: "auto" })).toEqual({
      status: "rejected",
      reason: "nope",
    });
  });

  test("standing_approved maps to the fourth status", () => {
    expect(gateResultOf({ kind: "standing_approved", ruleId: "r", fireId: "f" })).toEqual({
      status: "standing_approved",
    });
  });
});

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (/\.tsx?$/.test(e.name) && !/\.(test|d)\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

const GATEWAY_SRC = resolve(import.meta.dir, "..");
const rel = (p: string): string => relative(GATEWAY_SRC, p).replaceAll("\\", "/");

describe("SA1 source pins", () => {
  test("only the executor constructs a standing_approved outcome or row (I55, static D44(c))", () => {
    const offenders = srcFiles(GATEWAY_SRC)
      .filter((f) =>
        /(?:kind|hitlStatus):\s*"standing_approved"\s*[,}]|return\s+"standing_approved"/.test(
          readFileSync(f, "utf8"),
        ),
      )
      .map(rel);
    // SA3: the executor's `standingApproval` builds the outcome from `standingRuleStep`'s match.
    expect(offenders).toEqual(["engine/executor.ts"]);
  });

  test("the ConsentChannel implementers are exactly the known production set", () => {
    // A new implementer must return the answer's source too (TypeScript refuses a bare boolean);
    // this census makes adding one a deliberate, reviewed act.
    const users = srcFiles(GATEWAY_SRC)
      .filter((f) => /\bConsentChannel\b/.test(readFileSync(f, "utf8")))
      .map(rel)
      .sort((a, b) => a.localeCompare(b));
    expect(users).toEqual([
      "chatops/chatops-boot.ts",
      "engine/executor.ts",
      "engine/index.ts",
      "engine/types.ts",
      "ipc/capture-rpc.ts",
      // SA3: the standing-rule gate wraps the connection's channel so only a person's answer counts.
      "ipc/standing-rpc.ts",
    ]);
  });
});

function db35(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 35);
  return db;
}

type AuditRow = { hitlStatus: string; actionJson: string };

function run(
  consent: ConsentChannel,
  opts: { delegation?: ConstructorParameters<typeof ToolExecutor>[3] } = {},
): { rows: AuditRow[]; exec: ToolExecutor } {
  const rows: AuditRow[] = [];
  const exec = new ToolExecutor(
    consent,
    { recordAudit: (e) => rows.push({ hitlStatus: e.hitlStatus, actionJson: e.actionJson }) },
    { dispatch: async () => ({}) },
    opts.delegation,
    NULL_EGRESS_SINK,
  );
  return { rows, exec };
}

const sourceOf = (row: AuditRow | undefined): unknown =>
  (JSON.parse(row?.actionJson ?? "{}") as { answerSource?: unknown }).answerSource;

describe("the audit row records where a prompted decision came from", () => {
  const sources: AnswerSource[] = ["human", "auto", "script", "unknown"];
  for (const answerSource of sources) {
    test(`an owner answer from "${answerSource}" is recorded on an approval and a decline`, async () => {
      for (const approved of [true, false]) {
        const { rows, exec } = run({ requestApproval: async () => ({ approved, answerSource }) });
        const r = await exec.gate({ type: "email.send", payload: {} });
        expect(r).toEqual(
          approved ? "proceed" : { status: "rejected", reason: expect.any(String) },
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.hitlStatus).toBe(approved ? "approved" : "rejected");
        expect(sourceOf(rows[0])).toBe(answerSource);
      }
    });
  }

  test("a decision no prompt was shown for records no source", async () => {
    const { rows, exec } = run({
      requestApproval: async () => ({ approved: true, answerSource: "human" }),
    });
    await exec.gate({ type: "search.run", payload: {} });
    expect(rows[0]?.hitlStatus).toBe("not_required");
    expect(sourceOf(rows[0])).toBeUndefined();
  });

  test("a decline keeps the user-declined reason", async () => {
    const { exec } = run({
      requestApproval: async () => ({ approved: false, answerSource: "script" }),
    });
    expect(await exec.gate({ type: "email.send", payload: {} })).toEqual({
      status: "rejected",
      reason: "User declined consent gate.",
    });
  });

  function delegated(answerSource: "delegate" | "remote" | undefined, approved: boolean) {
    const db = db35();
    const store = new DelegationStore(db);
    store.create({
      delegatePeer: "peer:bob",
      scopeKind: "action_type",
      scopeValue: "email.send",
      expiresAt: 9e15,
      nowMs: 1,
    });
    const requestRemote = async (): Promise<RemoteApprovalOutcome> => ({
      kind: "answered",
      peerId: "peer:bob",
      approved,
    });
    return run(
      {
        requestApproval: async () => {
          throw new Error("the local owner must not be asked");
        },
      },
      {
        delegation: {
          store,
          isOperatorValid: () => true,
          requestRemote,
          ...(answerSource === undefined ? {} : { answerSource }),
        },
      },
    );
  }

  test("a delegated answer is recorded as delegate, or remote for ChatOps", async () => {
    for (const [declared, expected] of [
      [undefined, "delegate"],
      ["delegate", "delegate"],
      ["remote", "remote"],
    ] as const) {
      const ok = delegated(declared, true);
      expect(await ok.exec.gate({ type: "email.send", payload: {} })).toBe("proceed");
      expect(sourceOf(ok.rows[0])).toBe(expected);
      const no = delegated(declared, false);
      expect(await no.exec.gate({ type: "email.send", payload: {} })).toEqual({
        status: "rejected",
        reason: "User declined consent gate.",
      });
      expect(sourceOf(no.rows[0])).toBe(expected);
    }
  });
});
