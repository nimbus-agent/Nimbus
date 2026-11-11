import { describe, expect, test } from "bun:test";
import {
  archiveAction,
  NOW,
  seedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import {
  BREAKERS,
  baseScenario,
  openDeps,
  ruleCounters,
  type Scenario,
  setRuleColumn,
} from "../connectors/connector-writes/standing-scenarios.test-helpers.ts";
import { createStandingRuleDeps } from "../standing/standing-rule-capability.ts";
import { getRule, listFires } from "../standing/standing-rule-store.ts";
import { standingRuleStep } from "./standing-rule-step.ts";

function check(s: Scenario) {
  return standingRuleStep(s.action, { deps: s.deps, rows: s.rows, frozenHitl: s.frozenHitl });
}

describe("standingRuleStep — the matching action", () => {
  test("a matching action returns the rule and a recorded fire, and claims one action", () => {
    const s = baseScenario();
    const match = check(s);
    expect(match?.ruleId).toBe(s.rule.id);
    expect(match?.fireId).toMatch(/^sf_[0-9a-f]{16}$/);
    expect(match?.matchedScopeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ruleCounters(s)).toEqual({ used: 1, fires: 1 });
    expect(listFires(s.db, s.rule.id)[0]?.fireId).toBe(match?.fireId as string);
    expect(getRule(s.db, s.rule.id)?.lastFiredAt).toBe(NOW);
  });

  test("a schedule trigger and an owner_ui trigger match as well", () => {
    for (const trigger of ["schedule", "owner_ui"] as const) {
      const s = baseScenario();
      s.action = archiveAction(s.wf, { trigger });
      expect(check(s)?.ruleId, trigger).toBe(s.rule.id);
    }
  });

  test("each selected thread id is its own action under the same rule, up to the ceiling", () => {
    const s = baseScenario();
    setRuleColumn(s, "max_actions", 2);
    expect(check({ ...s, action: archiveAction(s.wf, { threadId: "a" }) })).toBeDefined();
    expect(check({ ...s, action: archiveAction(s.wf, { threadId: "b" }) })).toBeDefined();
    expect(check({ ...s, action: archiveAction(s.wf, { threadId: "c" }) })).toBeUndefined();
    expect(ruleCounters(s)).toEqual({ used: 2, fires: 2 });
  });

  test("a constant is compared as canonical JSON: key order does not matter, a value does", () => {
    const s = baseScenario({ variant: "const" });
    setRuleColumn(s, "scope_json", JSON.stringify({ threadId: { const: { a: 1, b: [2, 3] } } }));
    const dispatched = (input: unknown): void => {
      s.action = {
        ...s.action,
        payload: { mcpToolId: "gmail_thread_archive", input: { threadId: input } },
      };
    };
    dispatched({ b: [2, 3], a: 1 });
    expect(check(s)).toBeDefined();
    dispatched({ b: [3, 2], a: 1 });
    expect(check(s)).toBeUndefined();
  });

  test("a constant whose dispatched value differs from the rule's constant does not match", () => {
    const s = baseScenario({ variant: "const" });
    s.action = {
      ...s.action,
      payload: { mcpToolId: "gmail_thread_archive", input: { threadId: "T-other" } },
    };
    expect(check(s)).toBeUndefined();
    expect(ruleCounters(s)).toEqual({ used: 0, fires: 0 });
  });
});

describe("standingRuleStep — one negative per independent clause", () => {
  for (const breaker of BREAKERS) {
    test(`${breaker.name}: no rule applies, nothing is claimed`, () => {
      const s = baseScenario();
      const before = ruleCounters(s);
      breaker.apply(s);
      expect(check(s)).toBeUndefined();
      // The exhausted-ceiling breaker moves `actions_used` itself; every other breaker leaves it.
      if (breaker.name !== "an exhausted ceiling") expect(ruleCounters(s)).toEqual(before);
      expect(listFires(s.db)).toHaveLength(0);
    });
  }
});

describe("standingRuleStep — window", () => {
  const window = { days: [1, 2, 3, 4, 5], from: "09:00", to: "10:00", tz: "UTC" };

  test("inside the window matches", () => {
    const s = baseScenario({ window });
    s.deps = openDeps(s.db, { now: () => Date.UTC(2026, 10, 11, 9, 30) });
    expect(check(s)).toBeDefined();
  });

  test("outside by hour does not match", () => {
    const s = baseScenario({ window });
    s.deps = openDeps(s.db, { now: () => Date.UTC(2026, 10, 11, 10, 0) });
    expect(check(s)).toBeUndefined();
    expect(ruleCounters(s)).toEqual({ used: 0, fires: 0 });
  });

  test("outside by weekday does not match (Saturday)", () => {
    const s = baseScenario({ window });
    s.deps = openDeps(s.db, { now: () => Date.UTC(2026, 10, 14, 9, 30) });
    expect(check(s)).toBeUndefined();
  });

  test("the window is read in its own zone", () => {
    const s = baseScenario({ window: { ...window, tz: "Asia/Tokyo" } });
    // 00:30 UTC on a Wednesday is 09:30 in Tokyo.
    s.deps = openDeps(s.db, { now: () => Date.UTC(2026, 10, 11, 0, 30) });
    expect(check(s)).toBeDefined();
  });
});

describe("standingRuleStep — door refusals on the actual input", () => {
  test("a null optional field is refused", () => {
    const s = baseScenario({ variant: "calendar" });
    const real = createStandingRuleDeps({
      db: s.db,
      enforcedPolicy: () => ({ capabilitiesDisabled: new Set(), chatops: [] }) as never,
      getTribalKbConfig: () => undefined,
      now: () => NOW,
    });
    s.deps = real;
    const payload = s.action.payload as { input: Record<string, unknown> };
    // The rule's constants and the action agree (timeZone: null), so only the door refuses.
    setRuleColumn(
      s,
      "scope_json",
      JSON.stringify({
        subject: { const: "Standup" },
        startDateTime: { const: "2026-11-12T10:00:00" },
        endDateTime: { const: "2026-11-12T10:30:00" },
        timeZone: { const: null },
      }),
    );
    s.action = {
      ...s.action,
      payload: { ...payload, input: { ...payload.input, timeZone: null } },
    };
    expect(check(s)).toBeUndefined();
    expect(ruleCounters(s)).toEqual({ used: 0, fires: 0 });
  });

  test("a calendar time that does not show its zone is refused", () => {
    const s = baseScenario({ variant: "calendar" });
    s.deps = createStandingRuleDeps({
      db: s.db,
      enforcedPolicy: () => ({ capabilitiesDisabled: new Set(), chatops: [] }) as never,
      getTribalKbConfig: () => undefined,
      now: () => NOW,
    });
    const scope = {
      subject: { const: "Standup" },
      startDateTime: { const: "tomorrow at ten" },
      endDateTime: { const: "2026-11-12T10:30:00" },
      timeZone: { const: "Europe/Berlin" },
    };
    setRuleColumn(s, "scope_json", JSON.stringify(scope));
    const payload = s.action.payload as { input: Record<string, unknown> };
    s.action = {
      ...s.action,
      payload: { ...payload, input: { ...payload.input, startDateTime: "tomorrow at ten" } },
    };
    expect(check(s)).toBeUndefined();
  });

  test("the same calendar action with an explicit time passes the real door check", () => {
    const s = baseScenario({ variant: "calendar" });
    s.deps = createStandingRuleDeps({
      db: s.db,
      enforcedPolicy: () => ({ capabilitiesDisabled: new Set(), chatops: [] }) as never,
      getTribalKbConfig: () => undefined,
      now: () => NOW,
    });
    expect(check(s)).toBeDefined();
  });
});

describe("createStandingRuleDeps — policy, fail closed", () => {
  const src = (enforced: unknown) => ({
    db: baseScenario().db,
    enforcedPolicy: enforced as never,
    getTribalKbConfig: () => undefined,
  });

  test("an absent accessor, an absent policy and a throwing accessor read as locked off", () => {
    expect(createStandingRuleDeps(src(undefined)).policyAllows()).toBe(false);
    expect(createStandingRuleDeps(src(() => undefined)).policyAllows()).toBe(false);
    expect(
      createStandingRuleDeps(
        src(() => {
          throw new Error("x");
        }),
      ).policyAllows(),
    ).toBe(false);
  });

  test("the standing_approvals lock-off turns it off; without it, on", () => {
    expect(
      createStandingRuleDeps(
        src(() => ({ capabilitiesDisabled: new Set(["standing_approvals"]) })),
      ).policyAllows(),
    ).toBe(false);
    expect(
      createStandingRuleDeps(src(() => ({ capabilitiesDisabled: new Set() }))).policyAllows(),
    ).toBe(true);
  });

  test("an unreadable policy refuses a ChatOps-platform post, and lets another row through", () => {
    const deps = createStandingRuleDeps(src(undefined));
    expect(deps.refusal("slack_message_post", { channel: "C1", text: "hi" })).toBeDefined();
    expect(deps.refusal("gmail_thread_archive", { threadId: "t" })).toBeUndefined();
  });
});

describe("standingRuleStep — a second matching workflow does not share a rule", () => {
  test("another workflow with identical steps (a different id) is not covered", () => {
    const s = baseScenario();
    const other = seedWorkflow(s.db, undefined, "another-name");
    s.action = archiveAction(other);
    expect(check(s)).toBeUndefined();
  });
});
