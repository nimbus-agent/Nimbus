// The connectors 0.22.0 flag rows (`unleash-split-rows.ts`): the Unleash toggle and the Split kill and
// restore. Their typed previews, their drift keys against the installed connector's schema, their
// offer (Wave 3), their before-state readers, their reversibility (each proven from a recorded
// reply, the toggle's condition included) and their door refusals (none: no free text, no optional key).
import { describe, expect, test } from "bun:test";

import { HITL_REQUIRED } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type { ChatopsPolicy } from "../../policy/types.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { beforeReaderProblems } from "./before-reader.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import {
  installedRegistration,
  installedToolsSource,
  objectKeysAt,
} from "./installed-schema-keys.test-helpers.ts";
import { isModelOfferableRow, MODEL_NEVER_OFFERED_TOOL_IDS } from "./model-offerable.ts";
import {
  modelWriteRefusal,
  nullRefusedOptionalKeys,
  remoteContentScannedKeys,
  scannedTextKeys,
} from "./model-write-refusals.ts";
import { buildConnectorWritePreviewFrom, renderConnectorWritePreviewLines } from "./preview.ts";
import {
  callIsReversible,
  checkReversibilityTable,
  notReversibleBecause,
  REVERSIBILITY_TABLE,
  reversibleOnlyIf,
  undoRefusalReason,
} from "./reversibility.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";
import {
  selectSplitKill,
  selectSplitRestore,
  selectUnleashToggle,
  splitReadArgs,
  UNLEASH_SPLIT_ROWS,
  unleashActiveStrategy,
  unleashReadArgs,
} from "./unleash-split-rows.ts";

const TOGGLE = "unleash_feature_toggle";
const KILL = "split_kill";
const RESTORE = "split_restore";
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };

function rowOf(id: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
}

function previewLines(id: string, input: Record<string, unknown>): readonly string[] {
  const r = rowOf(id);
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), id), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${id}`);
  expect(p.otherFields).toEqual([]);
  return renderConnectorWritePreviewLines(p);
}

function value(fields: readonly { label: string; value: string }[], label: string): string {
  return fields.find((f) => f.label === label)?.value ?? "<absent>";
}

/** Runs the REAL reader on a recorded reply: the display select, then the capture. */
function capture(id: string, reply: unknown, picked: Record<string, unknown>) {
  const reader = rowOf(id).before;
  if (reader?.captures === undefined) throw new Error(`${id} captures nothing`);
  expect(() => reader.select(reply, picked, undefined)).not.toThrow();
  const got = reader.captures.pick(reply, picked, undefined);
  expect(Object.keys(got).sort((a, b) => a.localeCompare(b))).toEqual(
    [...reader.captures.keys].sort((a, b) => a.localeCompare(b)),
  );
  return { ...got };
}

function invert(id: string, input: Record<string, unknown>, captured: Record<string, string>) {
  const d = rowOf(id).reversibility;
  if (d?.class !== "reversible") throw new Error(`${id} is not reversible`);
  return d.invert(input, captured);
}

const mcp = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

const UNLEASH_IN = {
  projectId: "web",
  featureName: "new_checkout",
  environment: "production",
  enabled: true,
};
const SPLIT_IN = {
  workspaceId: "ws-1234",
  splitName: "new_checkout",
  environment: "Production EU",
};

describe("the 0.22.0 flag rows", () => {
  test("three Wave 3 mesh rows under their own frozen HITL types, offerable, never on the never-offered list", () => {
    expect(UNLEASH_SPLIT_ROWS.map((r) => r.toolId)).toEqual([TOGGLE, KILL, RESTORE]);
    for (const [id, actionType, service] of [
      [TOGGLE, "unleash.feature.toggle", "unleash"],
      [KILL, "split.flag.kill", "split"],
      [RESTORE, "split.flag.restore", "split"],
    ] as const) {
      const r = rowOf(id);
      expect(r.actionType, id).toBe(actionType);
      expect(serviceOf(r.actionType), id).toBe(service);
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(3);
      expect(HITL_REQUIRED.has(r.actionType), id).toBe(true);
      expect(isModelOfferableRow(r), id).toBe(true);
      expect(MODEL_NEVER_OFFERED_TOOL_IDS.has(id), id).toBe(false);
      expect(r.confirm, id).toBeUndefined();
      expect(r.bound, id).toBeUndefined();
      expect(beforeReaderProblems(r), id).toEqual([]);
    }
  });

  test("the template keys are exactly the installed connectors' schema keys", () => {
    const un = installedToolsSource("unleash");
    expect(installedRegistration(TOGGLE, "unleash")).toContain(
      "featureEnvArgs.extend({ enabled: z.boolean() })",
    );
    const unleashKeys = [
      ...objectKeysAt(un, "const featureArgs = z.object("),
      ...objectKeysAt(un, "const featureEnvArgs = featureArgs.extend("),
      "enabled",
    ].sort((a, b) => a.localeCompare(b));
    const t = rowOf(TOGGLE).preview;
    if (t === undefined) throw new Error(TOGGLE);
    expect([...previewTemplateKeys(t)].sort((a, b) => a.localeCompare(b))).toEqual(unleashKeys);
    expect(unleashKeys).toEqual(["enabled", "environment", "featureName", "projectId"]);

    const sp = installedToolsSource("split");
    const splitKeys = [
      ...objectKeysAt(sp, "const splitArgs = z.object("),
      ...objectKeysAt(sp, "const definitionArgs = splitArgs.extend("),
    ].sort((a, b) => a.localeCompare(b));
    expect(splitKeys).toEqual(["environment", "splitName", "workspaceId"]);
    for (const id of [KILL, RESTORE]) {
      expect(installedRegistration(id, "split")).toContain("definitionArgs,");
      const p = rowOf(id).preview;
      if (p === undefined) throw new Error(id);
      expect(
        [...previewTemplateKeys(p)].sort((a, b) => a.localeCompare(b)),
        id,
      ).toEqual(splitKeys);
    }
  });

  test("no field is markdown or secret: the owner sees the exact characters", () => {
    for (const r of UNLEASH_SPLIT_ROWS) {
      for (const f of r.preview?.fields ?? []) expect(f.kind, `${r.toolId}.${f.key}`).toBe("text");
    }
  });
});

describe("the typed previews (environment first)", () => {
  test("golden lines: the Unleash toggle", () => {
    expect(previewLines(TOGGLE, UNLEASH_IN)).toEqual([
      "Service: unleash",
      "Credential: personal",
      "Target:  production: web/new_checkout",
      "In environment production: turn Unleash feature new_checkout on or off (requested: enabled = true; project web)",
      "",
      '  Environment: "production"',
      '  Project: "web"',
      '  Feature: "new_checkout"',
      "  Turn it on (true) or off (false): true",
    ]);
  });

  test("golden lines: the Split kill and restore", () => {
    expect(previewLines(KILL, SPLIT_IN)).toEqual([
      "Service: split",
      "Credential: personal",
      "Target:  Production EU: ws-1234/new_checkout",
      "In environment Production EU: kill Split split new_checkout (workspace ws-1234); every evaluation then serves its default treatment, whatever its rules say",
      "",
      '  Environment: "Production EU"',
      '  Workspace id: "ws-1234"',
      '  Split: "new_checkout"',
    ]);
    expect(previewLines(RESTORE, SPLIT_IN)[3]).toBe(
      "In environment Production EU: restore killed Split split new_checkout (workspace ws-1234); its targeting rules apply again",
    );
  });
});

describe("the Unleash before-state reader (unleash_feature_state_get)", () => {
  const ACTIVE = { name: "flexibleRollout", disabled: false, constraints: [] };
  const DISABLED = { name: "default", disabled: true };
  const off = (strategies: unknown[], extra: Record<string, unknown> = {}) => ({
    featureName: "new_checkout",
    environment: "production",
    enabled: false,
    strategies,
    variants: [{ name: "a" }],
    ...extra,
  });

  test("reads with exactly the project, the feature and the environment", () => {
    const r = rowOf(TOGGLE).before;
    expect(r?.tool).toBe("unleash_feature_state_get");
    expect(r?.args).toBe(unleashReadArgs);
    expect(unleashReadArgs(UNLEASH_IN)).toEqual({
      projectId: "web",
      featureName: "new_checkout",
      environment: "production",
    });
    expect(unleashReadArgs({ ...UNLEASH_IN, environment: "" })).toBeUndefined();
    expect(unleashReadArgs({ ...UNLEASH_IN, projectId: 7 })).toBeUndefined();
    expect(r?.argKeys).toContain("enabled");
  });

  test("turning on an environment with an active strategy adds none", () => {
    const f = selectUnleashToggle(mcp(off([ACTIVE, DISABLED])), { enabled: true });
    expect(value(f, "Enabled now")).toBe("false");
    expect(value(f, "Change")).toBe("turns it ON (it is off now)");
    expect(value(f, "Strategies")).toBe("2 (1 active, 1 disabled)");
    expect(value(f, "Default strategy")).toBe(
      "none added (the environment already has an active strategy)",
    );
    expect(value(f, "Variants")).toBe("1");
  });

  test("turning on an environment with no active strategy says Unleash adds one that off leaves", () => {
    for (const strategies of [[], [DISABLED]]) {
      const f = selectUnleashToggle(off(strategies), { enabled: true });
      expect(value(f, "Default strategy")).toContain("Unleash add a default strategy");
      expect(value(f, "Default strategy")).toContain("does not remove");
    }
    const capped = selectUnleashToggle(off([DISABLED], { strategiesNotShown: 3 }), {
      enabled: true,
    });
    expect(value(capped, "Strategies")).toBe("1 (3 more not shown) (0 active, 1 disabled)");
    expect(value(capped, "Default strategy")).toStartWith("unknown whether one is added");
  });

  test("turning off shows no Default strategy line; a no-op says so", () => {
    const on = { ...off([]), enabled: true };
    const f = selectUnleashToggle(on, { enabled: false });
    expect(value(f, "Change")).toBe("turns it OFF (it is on now)");
    expect(value(f, "Default strategy")).toBe("<absent>");
    expect(value(selectUnleashToggle(on, { enabled: true }), "Change")).toBe(
      "no change (already on)",
    );
  });

  test("a reply without a boolean enabled throws (the prompt reads unavailable)", () => {
    expect(() => selectUnleashToggle({ strategies: [] }, { enabled: true })).toThrow();
    expect(() => selectUnleashToggle({ enabled: "yes" }, { enabled: true })).toThrow();
  });

  test("the active-strategy reading: yes, no, or unknown when it cannot tell", () => {
    expect(unleashActiveStrategy(off([ACTIVE]))).toBe("yes");
    expect(unleashActiveStrategy(off([{ name: "x" }]))).toBe("yes");
    expect(unleashActiveStrategy(off([DISABLED]))).toBe("no");
    expect(unleashActiveStrategy(off([]))).toBe("no");
    expect(unleashActiveStrategy(off([DISABLED], { strategiesNotShown: 1 }))).toBe("unknown");
    expect(unleashActiveStrategy({ enabled: false })).toBe("unknown");
  });
});

describe("the Split before-state reader (split_definition_get)", () => {
  const DEF = {
    name: "new_checkout",
    killed: false,
    defaultTreatment: "off",
    treatments: [{ name: "on" }, { name: "off" }],
    treatmentsNotShown: 2,
    rules: [{ buckets: [] }],
  };

  test("both rows read with exactly the workspace, the split and the environment", () => {
    for (const id of [KILL, RESTORE]) {
      const r = rowOf(id).before;
      expect(r?.tool, id).toBe("split_definition_get");
      expect(r?.args, id).toBe(splitReadArgs);
    }
    expect(splitReadArgs({ ...SPLIT_IN, extra: 1 })).toEqual(SPLIT_IN);
    expect(splitReadArgs({ ...SPLIT_IN, splitName: "" })).toBeUndefined();
  });

  test("a kill names the default treatment every evaluation will serve", () => {
    const f = selectSplitKill(mcp(DEF));
    expect(f).toEqual([
      { label: "Killed now", value: "false" },
      { label: "Change", value: "kills it: every evaluation then serves the default treatment" },
      { label: "Default treatment", value: "off" },
      { label: "Treatments", value: "2 (2 more not shown)" },
      { label: "Targeting rules", value: "1 (not changed by this write)" },
    ]);
    expect(value(selectSplitKill({ ...DEF, killed: true }), "Change")).toBe(
      "no change (already killed)",
    );
  });

  test("a restore says the rules apply again, or that nothing changes", () => {
    expect(value(selectSplitRestore({ ...DEF, killed: true }), "Change")).toBe(
      "restores it: its targeting rules apply again",
    );
    expect(value(selectSplitRestore(DEF), "Change")).toBe("no change (it is not killed)");
  });

  test("a reply without a boolean killed throws", () => {
    expect(() => selectSplitKill({ defaultTreatment: "off" })).toThrow();
    expect(() => selectSplitRestore({ killed: "no" })).toThrow();
  });
});

describe("reversibility (owner rulings 2026-11-27)", () => {
  const state = (enabled: boolean, strategies: unknown[]) => ({ enabled, strategies });

  test("unleash_feature_toggle: turning off is undone by turning on", () => {
    const input = { ...UNLEASH_IN, enabled: false };
    const captured = capture(TOGGLE, state(true, [{ name: "default" }]), input);
    expect(captured).toEqual({ enabled: "true", activeStrategy: "yes" });
    expect(invert(TOGGLE, input, captured)).toEqual({ ...UNLEASH_IN, enabled: true });
    expect(notReversibleBecause(TOGGLE, input, captured)).toBeUndefined();
    expect(callIsReversible(rowOf(TOGGLE), input, captured)).toBe(true);
  });

  test("unleash_feature_toggle: turning off with no active strategy is irreversible too (owner ruling)", () => {
    const input = { ...UNLEASH_IN, enabled: false };
    for (const activeStrategy of ["no", "unknown"]) {
      const captured = { enabled: "true", activeStrategy };
      expect(invert(TOGGLE, input, captured), activeStrategy).toBeUndefined();
      expect(callIsReversible(rowOf(TOGGLE), input, captured), activeStrategy).toBe(false);
      expect(notReversibleBecause(TOGGLE, input, captured), activeStrategy).toContain(
        "Unleash would add a default strategy that serves everyone",
      );
    }
  });

  test("unleash_feature_toggle: turning on is undone only when an active strategy was already there", () => {
    const withActive = capture(
      TOGGLE,
      state(false, [{ name: "default", disabled: false }]),
      UNLEASH_IN,
    );
    expect(withActive).toEqual({ enabled: "false", activeStrategy: "yes" });
    expect(invert(TOGGLE, UNLEASH_IN, withActive)).toEqual({ ...UNLEASH_IN, enabled: false });
    // Unleash adds a default strategy that turning off does not remove: no inverse.
    const none = capture(TOGGLE, state(false, []), UNLEASH_IN);
    expect(none).toEqual({ enabled: "false", activeStrategy: "no" });
    expect(invert(TOGGLE, UNLEASH_IN, none)).toBeUndefined();
    expect(notReversibleBecause(TOGGLE, UNLEASH_IN, none)).toBe(
      "turning the environment on made Unleash add a default strategy that serves everyone, and turning it off does not remove it",
    );
    const unknown = { enabled: "false", activeStrategy: "unknown" };
    expect(invert(TOGGLE, UNLEASH_IN, unknown)).toBeUndefined();
    expect(notReversibleBecause(TOGGLE, UNLEASH_IN, unknown)).toContain("not every strategy");
  });

  test("the conditional label: a condition with no capture, no reason when nothing makes it irreversible", () => {
    expect(reversibleOnlyIf(TOGGLE)).toBe("the environment already has an active strategy");
    expect(reversibleOnlyIf(KILL)).toBeUndefined();
    expect(reversibleOnlyIf("toString")).toBeUndefined();
    // A call that changed nothing has no inverse, but no Unleash reason either.
    expect(
      notReversibleBecause(TOGGLE, UNLEASH_IN, { enabled: "true", activeStrategy: "no" }),
    ).toBeUndefined();
    expect(notReversibleBecause(KILL, SPLIT_IN, { killed: "true" })).toBeUndefined();
    expect(callIsReversible(rowOf(KILL), SPLIT_IN, { killed: "false" })).toBe(true);
    expect(callIsReversible(rowOf(KILL), SPLIT_IN, { killed: "true" })).toBe(false);
    expect(callIsReversible(undefined, SPLIT_IN, { killed: "false" })).toBe(false);
    expect(callIsReversible(rowOf(KILL), SPLIT_IN, undefined)).toBe(false);
  });

  test("unleash_feature_toggle: a call that changed nothing, or a bad record, has no inverse", () => {
    expect(invert(TOGGLE, UNLEASH_IN, { enabled: "true", activeStrategy: "yes" })).toBeUndefined();
    expect(invert(TOGGLE, UNLEASH_IN, { enabled: "on", activeStrategy: "yes" })).toBeUndefined();
    expect(
      invert(
        TOGGLE,
        { ...UNLEASH_IN, enabled: "false" },
        { enabled: "true", activeStrategy: "yes" },
      ),
    ).toBeUndefined();
    const { projectId: _, ...noProject } = UNLEASH_IN;
    expect(invert(TOGGLE, noProject, { enabled: "false", activeStrategy: "yes" })).toBeUndefined();
  });

  test("split_kill and split_restore are each the other's inverse, only from the opposite state", () => {
    expect(REVERSIBILITY_TABLE[KILL]?.decl).toMatchObject({ inverse: RESTORE });
    expect(REVERSIBILITY_TABLE[RESTORE]?.decl).toMatchObject({ inverse: KILL });
    const live = capture(KILL, mcp({ killed: false, defaultTreatment: "off" }), SPLIT_IN);
    expect(live).toEqual({ killed: "false" });
    expect(invert(KILL, SPLIT_IN, live)).toEqual(SPLIT_IN);
    expect(invert(KILL, SPLIT_IN, { killed: "true" })).toBeUndefined();
    const dead = capture(RESTORE, { killed: true }, SPLIT_IN);
    expect(dead).toEqual({ killed: "true" });
    expect(invert(RESTORE, SPLIT_IN, dead)).toEqual(SPLIT_IN);
    expect(invert(RESTORE, SPLIT_IN, { killed: "false" })).toBeUndefined();
    expect(invert(RESTORE, { ...SPLIT_IN, environment: "" }, dead)).toBeUndefined();
  });

  test("a reply the capture cannot read captures nothing (it throws; the runner keeps no value)", () => {
    expect(() => rowOf(TOGGLE).before?.captures?.pick({ strategies: [] }, {}, undefined)).toThrow();
    expect(() => rowOf(KILL).before?.captures?.pick({}, {}, undefined)).toThrow();
  });
});

describe("door refusals", () => {
  test("no free text and no optional key: nothing is scanned and a clean call is not refused", () => {
    for (const [id, input] of [
      [TOGGLE, UNLEASH_IN],
      [KILL, SPLIT_IN],
      [RESTORE, SPLIT_IN],
    ] as const) {
      expect(scannedTextKeys(id), id).toEqual([]);
      expect(remoteContentScannedKeys(id), id).toEqual([]);
      expect(nullRefusedOptionalKeys(id), id).toEqual([]);
      expect(
        modelWriteRefusal(id, input, { chatops: NO_CHATOPS, kb: undefined }),
        id,
      ).toBeUndefined();
    }
  });
});

describe("the undo refusal and the table's check of a condition", () => {
  test("the undo refusal names the Unleash reason, else the generic text", () => {
    const off = JSON.stringify({ ...UNLEASH_IN, enabled: false });
    expect(
      undoRefusalReason(TOGGLE, off, JSON.stringify({ enabled: "true", activeStrategy: "no" })),
    ).toBe(
      "irreversible: turning the environment back on, Unleash would add a default strategy that serves everyone, which it did not have",
    );
    expect(
      undoRefusalReason(KILL, JSON.stringify(SPLIT_IN), JSON.stringify({ killed: "true" })),
    ).toBe("that call changed nothing, or cannot be reversed from what was recorded");
  });

  test("a condition on an irreversible entry is refused at load", () => {
    const whyNot = () => undefined;
    const problems = checkReversibilityTable(CONNECTOR_WRITE_ROWS, {
      split_kill: {
        decl: { class: "irreversible", reason: "x" },
        conditional: { condition: "c", otherwise: "o", whyNot },
      },
    });
    expect(problems).toEqual(["split_kill: a condition on an irreversible row"]);
  });
});
