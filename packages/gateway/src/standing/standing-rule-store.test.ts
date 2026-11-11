import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmDirWithRetry } from "../../test/helpers/rm-dir-with-retry.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  claimFire,
  getRule,
  insertRule,
  listFires,
  listRules,
  listRulesFor,
  newFireId,
  newRuleId,
  pauseRule,
  resumeRule,
  revokeRule,
  ruleState,
  scopeSha256,
} from "./standing-rule-store.ts";
import type { NewStandingRule } from "./standing-rule-types.ts";

const T0 = 1_000_000;

function fresh(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 88);
  return db;
}

function newRule(over: Partial<NewStandingRule> = {}): NewStandingRule {
  return {
    createdAt: T0,
    workflowId: "wf1",
    workflowSha256: "a".repeat(64),
    stepIndex: 1,
    actionType: "gmail.thread.archive",
    toolId: "gmail_thread_archive",
    scope: { threadId: { query: 0, column: "metadata.threadId" } },
    window: undefined,
    expiresAt: T0 + 10_000,
    maxActions: 3,
    approvalAuditId: 7,
    ...over,
  };
}

describe("ids", () => {
  test("rule and fire ids are random hex with their prefixes", () => {
    expect(newRuleId()).toMatch(/^sr_[0-9a-f]{16}$/);
    expect(newFireId()).toMatch(/^sf_[0-9a-f]{16}$/);
    expect(newRuleId()).not.toBe(newRuleId());
  });
});

describe("insert, read and the lifecycle", () => {
  test("a rule round-trips with its scope and window", () => {
    const db = fresh();
    const w = { days: [1, 2, 3], from: "06:00", to: "10:00", tz: "UTC" };
    const rule = insertRule(db, newRule({ window: w }));
    expect(rule.id).toMatch(/^sr_/);
    const got = getRule(db, rule.id);
    expect(got).toEqual(rule);
    expect(got?.window).toEqual(w);
    expect(got?.actionsUsed).toBe(0);
    expect(getRule(db, "sr_missing")).toBeUndefined();
    expect(listRules(db).map((r) => r.id)).toEqual([rule.id]);
    db.close();
  });

  test("listRulesFor narrows by workflow id, hash, step, type and tool", () => {
    const db = fresh();
    const rule = insertRule(db, newRule());
    insertRule(db, newRule({ workflowSha256: "b".repeat(64) }));
    insertRule(db, newRule({ stepIndex: 2 }));
    insertRule(db, newRule({ toolId: "other_tool" }));
    insertRule(db, newRule({ actionType: "other.type" }));
    insertRule(db, newRule({ workflowId: "wf2" }));
    const key = {
      workflowId: "wf1",
      workflowSha256: "a".repeat(64),
      stepIndex: 1,
      actionType: "gmail.thread.archive",
      toolId: "gmail_thread_archive",
    };
    expect(listRulesFor(db, key).map((r) => r.id)).toEqual([rule.id]);
    db.close();
  });

  test("pause and resume change state; revoke is final", () => {
    const db = fresh();
    const rule = insertRule(db, newRule());
    expect(ruleState(rule, T0)).toBe("live");
    expect(pauseRule(db, rule.id, T0 + 1)).toBe(true);
    expect(pauseRule(db, rule.id, T0 + 2)).toBe(false);
    expect(ruleState(getRule(db, rule.id) as never, T0 + 3)).toBe("paused");
    expect(resumeRule(db, rule.id)).toBe(true);
    expect(resumeRule(db, rule.id)).toBe(false);
    expect(revokeRule(db, rule.id, T0 + 4)).toBe(true);
    expect(revokeRule(db, rule.id, T0 + 5)).toBe(false);
    // A revoked rule never resumes and never pauses again.
    expect(pauseRule(db, rule.id, T0 + 6)).toBe(false);
    pauseRule(db, rule.id, T0 + 6);
    expect(resumeRule(db, rule.id)).toBe(false);
    expect(ruleState(getRule(db, rule.id) as never, T0 + 7)).toBe("revoked");
    db.close();
  });

  test("ruleState reads expired and exhausted", () => {
    const db = fresh();
    const rule = insertRule(db, newRule({ maxActions: 1 }));
    expect(ruleState(rule, T0 + 10_000)).toBe("expired");
    claimFire(db, rule.id, T0 + 1, "x", "h");
    expect(ruleState(getRule(db, rule.id) as never, T0 + 2)).toBe("exhausted");
    db.close();
  });
});

describe("claimFire — the atomic ceiling", () => {
  test("claims one action and records the fire in the same transaction", () => {
    const db = fresh();
    const rule = insertRule(db, newRule());
    const fireId = claimFire(db, rule.id, T0 + 5, "gmail.thread.archive", scopeSha256(rule.scope));
    expect(fireId).toMatch(/^sf_[0-9a-f]{16}$/);
    const after = getRule(db, rule.id);
    expect(after?.actionsUsed).toBe(1);
    expect(after?.lastFiredAt).toBe(T0 + 5);
    expect(listFires(db, rule.id)).toEqual([
      {
        fireId: fireId as string,
        ruleId: rule.id,
        firedAt: T0 + 5,
        actionType: "gmail.thread.archive",
        matchedScopeSha256: scopeSha256(rule.scope),
      },
    ]);
    expect(listFires(db)).toHaveLength(1);
    db.close();
  });

  test("the ceiling holds: the last action is claimed once, then nothing", () => {
    const db = fresh();
    const rule = insertRule(db, newRule({ maxActions: 2 }));
    expect(claimFire(db, rule.id, T0 + 1, "t", "h")).toBeDefined();
    expect(claimFire(db, rule.id, T0 + 2, "t", "h")).toBeDefined();
    expect(claimFire(db, rule.id, T0 + 3, "t", "h")).toBeUndefined();
    expect(getRule(db, rule.id)?.actionsUsed).toBe(2);
    expect(listFires(db, rule.id)).toHaveLength(2);
    db.close();
  });

  test("an expired, paused, revoked or unknown rule claims nothing and records no fire", () => {
    const db = fresh();
    const expired = insertRule(db, newRule());
    expect(claimFire(db, expired.id, T0 + 10_000, "t", "h")).toBeUndefined();
    expect(claimFire(db, expired.id, T0 + 10_001, "t", "h")).toBeUndefined();
    const paused = insertRule(db, newRule());
    pauseRule(db, paused.id, T0);
    expect(claimFire(db, paused.id, T0 + 1, "t", "h")).toBeUndefined();
    const revoked = insertRule(db, newRule());
    revokeRule(db, revoked.id, T0);
    expect(claimFire(db, revoked.id, T0 + 1, "t", "h")).toBeUndefined();
    expect(claimFire(db, "sr_0000000000000000", T0 + 1, "t", "h")).toBeUndefined();
    expect(listFires(db)).toHaveLength(0);
    db.close();
  });

  test("two claims with one action left: exactly one succeeds (one connection)", async () => {
    const db = fresh();
    const rule = insertRule(db, newRule({ maxActions: 1 }));
    const results = await Promise.all([
      Promise.resolve().then(() => claimFire(db, rule.id, T0 + 1, "t", "h")),
      Promise.resolve().then(() => claimFire(db, rule.id, T0 + 1, "t", "h")),
    ]);
    expect(results.filter((r) => r !== undefined)).toHaveLength(1);
    expect(getRule(db, rule.id)?.actionsUsed).toBe(1);
    expect(listFires(db, rule.id)).toHaveLength(1);
    db.close();
  });

  describe("two connections to one file", () => {
    const dirs: string[] = [];
    afterEach(() => {
      for (const d of dirs.splice(0)) rmDirWithRetry(d);
    });

    test("two claims with one action left on two connections: exactly one succeeds", () => {
      const dir = mkdtempSync(join(tmpdir(), "nimbus-standing-"));
      dirs.push(dir);
      const path = join(dir, "idx.db");
      const a = new Database(path);
      a.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
      runIndexedSchemaMigrations(a, 88);
      const b = new Database(path);
      b.exec("PRAGMA busy_timeout = 5000;");
      const rule = insertRule(a, newRule({ maxActions: 1 }));
      const first = claimFire(a, rule.id, T0 + 1, "t", "h");
      const second = claimFire(b, rule.id, T0 + 1, "t", "h");
      expect([first, second].filter((r) => r !== undefined)).toHaveLength(1);
      expect(listFires(b, rule.id)).toHaveLength(1);
      a.close();
      b.close();
    });
  });
});

describe("scopeSha256", () => {
  test("is the SHA-256 of the canonical scope, independent of key order", () => {
    const x = scopeSha256({ a: { const: 1 }, b: { query: 0, column: "c" } });
    const y = scopeSha256({ b: { column: "c", query: 0 }, a: { const: 1 } });
    expect(x).toBe(y);
    expect(x).toMatch(/^[0-9a-f]{64}$/);
    expect(scopeSha256({ a: { const: 2 } })).not.toBe(scopeSha256({ a: { const: 1 } }));
  });
});
