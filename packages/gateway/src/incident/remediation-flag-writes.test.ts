// The Unleash toggle and the Split kill and restore in the remediation catalogue (connectors 0.22.0, owner ruling
// 2026-11-27): end to end over the REAL remediation service and ToolExecutor (`remediation-harness.ts`). Each is
// proposed only as `repeat_last` (an earlier record of the same service ran it), executes through the owner's
// prompt, captures its before-state, and `undo()` builds the declared inverse. The Unleash toggle is undoable only
// when the before-read showed an active strategy; otherwise it runs but `undo()` refuses with Unleash's reason.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type Harness,
  makeRemediationHarness,
  NOW,
  seedPriorRun,
} from "../../test/helpers/remediation-harness.ts";
import { chainVerifiers, replayIncident } from "../audit/incident-replay.ts";
import type { PlannedAction } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import { latestUndoableActionId, undoOrLatest } from "../ipc/incident-undo.ts";
import { proposalSection } from "../oncall-push/push-runner.ts";
import { getProposalByAction } from "./proposal-store.ts";

let db: Database;
let localIndex: LocalIndex;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});
afterEach(() => db.close());

const SPLIT = { workspaceId: "ws-1234", splitName: "new_checkout", environment: "Production EU" };
const UNLEASH = { projectId: "web", featureName: "new_checkout", environment: "production" };
const ACTIVE = [{ name: "flexibleRollout", disabled: false }];
const CONDITION = "the environment already has an active strategy";
const CONDITIONAL_LINE = `Reversibility: reversible only if ${CONDITION} (nimbus incident undo can reverse it then); otherwise IRREVERSIBLE - Unleash adds a default strategy`;
const PLAIN_LINE = "Reversibility: reversible - nimbus incident undo can reverse it";

const inputOf = (a: PlannedAction | undefined): unknown =>
  (a?.payload as { input?: unknown } | undefined)?.input;

type FlagState = { killed: boolean; enabled: boolean; strategies: unknown[]; readsFail?: boolean };
/** The current fake flag service's state: a test changes it between a run and its undo. */
let flags: FlagState = { killed: false, enabled: false, strategies: [] };

/** A fake flag service: the before reads answer the current state, and each write changes it. */
function flagService(state: FlagState) {
  return (action: PlannedAction): unknown => {
    if (state.readsFail === true && action.type.endsWith(".before.read")) {
      throw new Error("the flag service is unreachable");
    }
    if (action.type === "split.before.read") {
      return {
        killed: state.killed,
        defaultTreatment: "off",
        treatments: ["on", "off"],
        rules: [],
      };
    }
    if (action.type === "unleash.before.read") {
      return { enabled: state.enabled, strategies: state.strategies, variants: [] };
    }
    if (action.type === "split.flag.kill") state.killed = true;
    if (action.type === "split.flag.restore") state.killed = false;
    const wanted = (inputOf(action) as { enabled?: unknown } | undefined)?.enabled;
    if (action.type === "unleash.feature.toggle" && typeof wanted === "boolean") {
      state.enabled = wanted;
    }
    return undefined;
  };
}

function harnessWith(start: { killed?: boolean; enabled?: boolean; strategies?: unknown[] }) {
  let clock = NOW;
  flags = {
    killed: start.killed ?? false,
    enabled: start.enabled ?? false,
    strategies: start.strategies ?? ACTIVE,
  };
  return makeRemediationHarness(db, localIndex, {
    beforeReply: flagService(flags),
    // Every call moves the clock, so a later run has a later executed time.
    now: () => {
      clock += 1;
      return clock;
    },
  });
}

function proposalOf(h: Harness, toolId: string) {
  const p = h.svc.proposals(h.recordId).proposals.find((x) => x.toolId === toolId);
  if (p === undefined) throw new Error(`no ${toolId} proposal`);
  return p;
}

async function run(h: Harness, toolId: string) {
  const p = proposalOf(h, toolId);
  expect(p.kind).toBe("repeat_last");
  return h.svc.remediate({ ref: h.recordId, proposalId: p.id, clientId: "cli-1" });
}

const writes = (h: Harness, type: string): unknown[] =>
  h.dispatched.filter((a) => a.type === type).map(inputOf);

describe("the Split kill and restore: proposed again, run, and undone by each other", () => {
  test("a kill is undone by a restore of the same workspace, split and environment", async () => {
    seedPriorRun(db, { n: 1, toolId: "split_kill", input: SPLIT });
    const h = harnessWith({ killed: false });
    const listed = proposalOf(h, "split_kill");
    expect(listed).toMatchObject({
      reversibility: "reversible",
      input: SPLIT,
      dryRun: "current_state",
    });
    expect(listed.reversibleIf).toBeUndefined();
    const out = await run(h, "split_kill");
    expect(out).toMatchObject({ status: "executed", undoable: true, nonHuman: false });
    expect(h.prompts[0]).toContain("Proposed by: the incident engine");
    expect(h.prompts[0]).toContain(PLAIN_LINE);
    expect(h.prompts[0]).toContain("Killed now: false");
    expect(JSON.parse(getProposalByAction(db, out.actionId)?.captured_json ?? "")).toEqual({
      killed: "false",
    });
    const undone = await h.svc.undo({ actionId: out.actionId, clientId: "cli-1" });
    expect(undone).toEqual({ actionId: out.actionId, status: "undone", nonHuman: false });
    expect(writes(h, "split.flag.kill")).toEqual([SPLIT]);
    expect(writes(h, "split.flag.restore")).toEqual([SPLIT]);
    expect(h.prompts[1]).toContain("Killed now: true");
  });

  test("a restore is undone by a kill of the same split", async () => {
    seedPriorRun(db, { n: 1, toolId: "split_restore", input: SPLIT });
    const h = harnessWith({ killed: true });
    const out = await run(h, "split_restore");
    expect(out).toMatchObject({ status: "executed", undoable: true });
    await h.svc.undo({ actionId: out.actionId, clientId: "cli-1" });
    expect(writes(h, "split.flag.restore")).toEqual([SPLIT]);
    expect(writes(h, "split.flag.kill")).toEqual([SPLIT]);
    expect(getProposalByAction(db, out.actionId)).toMatchObject({ undo_status: "undone" });
  });
});

describe("the Unleash toggle: undoable only when the environment already had an active strategy", () => {
  for (const enabled of [false, true]) {
    test(`turning it ${enabled ? "on" : "off"} with an active strategy is undone by the opposite toggle`, async () => {
      seedPriorRun(db, { n: 1, toolId: "unleash_feature_toggle", input: { ...UNLEASH, enabled } });
      const h = harnessWith({ enabled: !enabled, strategies: ACTIVE });
      // Listed with the condition, never as plain reversible.
      expect(proposalOf(h, "unleash_feature_toggle")).toMatchObject({
        reversibility: "reversible",
        reversibleIf: CONDITION,
      });
      const out = await run(h, "unleash_feature_toggle");
      expect(out).toMatchObject({ status: "executed", undoable: true });
      expect(h.prompts[0]).toContain(CONDITIONAL_LINE);
      expect(h.prompts[0]).not.toContain(PLAIN_LINE);
      const undone = await h.svc.undo({ actionId: out.actionId, clientId: "cli-1" });
      expect(undone.status).toBe("undone");
      expect(writes(h, "unleash.feature.toggle")).toEqual([
        { ...UNLEASH, enabled },
        { ...UNLEASH, enabled: !enabled },
      ]);
      // The undo's own prompt is the same row: it names the condition too.
      expect(h.prompts[1]).toContain(CONDITIONAL_LINE);
    });
  }

  test("with no active strategy it runs, is not undoable, and undo() refuses with Unleash's reason", async () => {
    seedPriorRun(db, {
      n: 1,
      toolId: "unleash_feature_toggle",
      input: { ...UNLEASH, enabled: true },
    });
    const h = harnessWith({ enabled: false, strategies: [] });
    const out = await run(h, "unleash_feature_toggle");
    expect(out).toMatchObject({ status: "executed", undoable: false });
    expect(h.prompts[0]).toContain(CONDITIONAL_LINE);
    expect(JSON.parse(getProposalByAction(db, out.actionId)?.captured_json ?? "")).toEqual({
      enabled: "false",
      activeStrategy: "no",
    });
    const view = h.svc.proposals(h.recordId).proposals.find((p) => p.actionId === out.actionId);
    expect(view).toMatchObject({ status: "executed", undoable: false, reversibleIf: CONDITION });
    const before = h.dispatched.length;
    await expect(h.svc.undo({ actionId: out.actionId, clientId: "cli-1" })).rejects.toMatchObject({
      code: "ERR_UNDO_REFUSED",
      message:
        "irreversible: turning the environment on made Unleash add a default strategy that serves everyone, and turning it off does not remove it",
    });
    expect(h.dispatched).toHaveLength(before);
    expect(getProposalByAction(db, out.actionId)?.undo_status).toBeNull();
  });
});

describe("an Unleash undo is judged on a FRESH read, never only on the capture recorded when it ran", () => {
  async function toggledOff(): Promise<{ h: Harness; actionId: string }> {
    seedPriorRun(db, {
      n: 1,
      toolId: "unleash_feature_toggle",
      input: { ...UNLEASH, enabled: false },
    });
    const h = harnessWith({ enabled: true, strategies: ACTIVE });
    const out = await run(h, "unleash_feature_toggle");
    expect(out).toMatchObject({ status: "executed", undoable: true });
    return { h, actionId: out.actionId };
  }

  test("the strategy removed since the run: undo is refused with the reason, before any prompt, nothing sent", async () => {
    const { h, actionId } = await toggledOff();
    flags.strategies = [{ name: "flexibleRollout", disabled: true }];
    const prompts = h.prompts.length;
    await expect(h.svc.undo({ actionId, clientId: "cli-1" })).rejects.toMatchObject({
      code: "ERR_UNDO_REFUSED",
      message: `irreversible now: it is reversible only if ${CONDITION}, and a fresh read of the target does not show that (Unleash adds a default strategy that serves everyone when it enables an environment with no active strategy, and turning it off does not remove it)`,
    });
    expect(h.prompts).toHaveLength(prompts);
    expect(writes(h, "unleash.feature.toggle")).toEqual([{ ...UNLEASH, enabled: false }]);
    // Refused, not spent: once the strategy is back, the undo can run.
    expect(getProposalByAction(db, actionId)?.undo_status).toBeNull();
    flags.strategies = ACTIVE;
    expect((await h.svc.undo({ actionId, clientId: "cli-1" })).status).toBe("undone");
    expect(writes(h, "unleash.feature.toggle")).toEqual([
      { ...UNLEASH, enabled: false },
      { ...UNLEASH, enabled: true },
    ]);
  });

  test("the target cannot be read again: refused (fail closed), nothing sent", async () => {
    const { h, actionId } = await toggledOff();
    flags.readsFail = true;
    await expect(h.svc.undo({ actionId, clientId: "cli-1" })).rejects.toMatchObject({
      code: "ERR_UNDO_REFUSED",
      message: `irreversible now: it is reversible only if ${CONDITION}, and the target could not be read again to check; nothing was run`,
    });
    expect(writes(h, "unleash.feature.toggle")).toHaveLength(1);
    expect(getProposalByAction(db, actionId)?.undo_status).toBeNull();
  });

  test("a Split undo is not re-judged: it runs even when its fresh read is unavailable", async () => {
    seedPriorRun(db, { n: 1, toolId: "split_kill", input: SPLIT });
    const h = harnessWith({ killed: false });
    const out = await run(h, "split_kill");
    flags.readsFail = true;
    expect((await h.svc.undo({ actionId: out.actionId, clientId: "cli-1" })).status).toBe("undone");
    expect(writes(h, "split.flag.restore")).toEqual([SPLIT]);
  });
});

describe("every other place the proposal reaches names the Unleash condition", () => {
  test("the push's top proposal carries it into the pushed block; a Split proposal carries none", () => {
    seedPriorRun(db, {
      n: 1,
      toolId: "unleash_feature_toggle",
      input: { ...UNLEASH, enabled: false },
    });
    const h = harnessWith({ enabled: true });
    const top = h.svc.topProposal(h.recordId);
    expect(top).toMatchObject({ toolId: "unleash_feature_toggle", reversibleIf: CONDITION });
    if (top === null) throw new Error("no top proposal");
    expect(proposalSection("pagerduty:PD1", top)).toContain(
      `[reversible only if ${CONDITION}; otherwise IRREVERSIBLE] repeat_last: \`unleash_feature_toggle\``,
    );
    db.run("DELETE FROM incident_proposal");
    seedPriorRun(db, { n: 2, toolId: "split_kill", input: SPLIT });
    const split = h.svc.topProposal(h.recordId);
    expect(split?.toolId).toBe("split_kill");
    expect(split).not.toHaveProperty("reversibleIf");
  });

  test("audit replay lists the Unleash proposal with its condition", async () => {
    seedPriorRun(db, {
      n: 1,
      toolId: "unleash_feature_toggle",
      input: { ...UNLEASH, enabled: false },
    });
    const h = harnessWith({ enabled: true });
    const out = await run(h, "unleash_feature_toggle");
    const replay = replayIncident(db, h.recordId, chainVerifiers(localIndex));
    expect(replay.proposals.items.find((p) => p.actionId === out.actionId)).toMatchObject({
      toolId: "unleash_feature_toggle",
      reversibility: "reversible",
      reversibleIf: CONDITION,
    });
  });
});

describe("nimbus incident undo with no id", () => {
  test("picks the newest action that can actually be undone, passing over a newer Unleash toggle that cannot", async () => {
    seedPriorRun(db, { n: 1, toolId: "split_kill", input: SPLIT });
    seedPriorRun(db, {
      n: 2,
      toolId: "unleash_feature_toggle",
      input: { ...UNLEASH, enabled: true },
    });
    const h = harnessWith({ killed: false, enabled: false, strategies: [] });
    const kill = await run(h, "split_kill");
    const toggle = await run(h, "unleash_feature_toggle");
    expect(kill.undoable).toBe(true);
    expect(toggle.undoable).toBe(false);
    expect(latestUndoableActionId(db)).toBe(kill.actionId);
    const undone = await undoOrLatest(h.svc, db, undefined, "cli-1");
    expect(undone).toEqual({ actionId: kill.actionId, status: "undone", nonHuman: false });
    expect(writes(h, "split.flag.restore")).toEqual([SPLIT]);
    expect(writes(h, "unleash.feature.toggle")).toEqual([{ ...UNLEASH, enabled: true }]);
    // Nothing undoable is left: the toggle is never chosen and then refused.
    expect(latestUndoableActionId(db)).toBeUndefined();
  });
});
