// Phase 9.7 C3: the typed previews and before-readers of the five wave-3 flag and alert writes
// (LaunchDarkly toggle and rollout, Flagsmith state set, Jira Operations alert acknowledge and
// close). Each row's template keys are its tool's input-schema keys in `@nimbus-dev/connectors`
// 0.6.0, checked twice (a spelled-out constant AND the installed source). The LaunchDarkly reply
// fixtures are built by the connector's own `projectFlagState`, loaded from the installed source.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { toStandardSchema } from "@mastra/core/schema";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { makeEgressSink } from "../../egress/egress-ledger.ts";
import { createBeforeStateRunner, isBeforeReadActionType } from "../../engine/before-state.ts";
import { buildConnectorWriteAgentTools } from "../../engine/connector-write-agent-tools.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type {
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "../../engine/types.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import {
  declaredInputKeys,
  registrationCallOf,
  withSchemaArgumentDeclarations,
} from "../testing/connector-schema-source.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { setModelWriteEnablement } from "./enablement-store.ts";
import {
  ROLLOUT_MAX_VARIATIONS,
  selectFlagsmithState,
  selectLaunchdarklyRollout,
  selectLaunchdarklyToggle,
} from "./flags.ts";
import { selectJiraOpsAlert } from "./incident.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";
import {
  buildConnectorWritePreviewFrom,
  type ConnectorWritePreview,
  renderConnectorWritePreviewLines,
} from "./preview.ts";
import { BEFORE_STATE_MAX_FIELDS, type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const C3_ROWS = [
  "launchdarkly_flag_toggle",
  "launchdarkly_flag_rollout_set",
  "flagsmith_feature_state_set",
  "jira_ops_alert_acknowledge",
  "jira_ops_alert_close",
] as const;
type C3Row = (typeof C3_ROWS)[number];

/** The 0.6.0 input-schema keys the installed source declares for each row (sorted). The rollout
 *  list also carries the nested `percent` and `variationId`: `declaredInputKeys` over-reads nested
 *  object keys (as it did for GitLab in C2), so the TEMPLATE keys are the four top-level ones. */
const DECLARED_KEYS: Readonly<Record<C3Row, readonly string[]>> = {
  launchdarkly_flag_toggle: ["environmentKey", "flagKey", "on", "projectKey"],
  launchdarkly_flag_rollout_set: [
    "environmentKey",
    "flagKey",
    "percent",
    "projectKey",
    "variationId",
    "weights",
  ],
  flagsmith_feature_state_set: ["enabled", "environmentKey", "featureId", "value"],
  jira_ops_alert_acknowledge: ["alertId"],
  jira_ops_alert_close: ["alertId"],
};

/** The top-level keys each template names (what the model supplies). */
const TEMPLATE_KEYS: Readonly<Record<C3Row, readonly string[]>> = {
  ...DECLARED_KEYS,
  launchdarkly_flag_rollout_set: ["environmentKey", "flagKey", "projectKey", "weights"],
};

/** The reader tool of each row, the keys that tool's own schema declares (what `args` sends) and
 *  the extra write keys the select (and guard) read, declared in `argKeys` but never sent. */
const READERS: Readonly<
  Record<
    C3Row,
    {
      readonly tool: string;
      readonly keys: readonly string[];
      readonly extra: readonly string[];
    }
  >
> = {
  launchdarkly_flag_toggle: {
    tool: "launchdarkly_flag_state_get",
    keys: ["environmentKey", "flagKey", "projectKey"],
    extra: ["on"],
  },
  launchdarkly_flag_rollout_set: {
    tool: "launchdarkly_flag_state_get",
    keys: ["environmentKey", "flagKey", "projectKey"],
    extra: ["weights"],
  },
  flagsmith_feature_state_set: {
    tool: "flagsmith_feature_state_get",
    keys: ["environmentKey", "featureId"],
    extra: ["enabled", "value"],
  },
  jira_ops_alert_acknowledge: { tool: "jira_ops_alert_get", keys: ["alertId"], extra: [] },
  jira_ops_alert_close: { tool: "jira_ops_alert_get", keys: ["alertId"], extra: [] },
};

const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const codeByFile = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));

function declaredWriteKeys(toolId: string): string[] {
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined)
    throw new Error(`${toolId}: not a registered write in the installed package`);
  const code = codeByFile.get(reg.file) ?? "";
  const call = code.slice(reg.span[0], reg.span[1] + 1);
  return declaredInputKeys(withSchemaArgumentDeclarations(sources, code, call));
}

function declaredReadKeys(toolId: string): string[] {
  const hits = sources.flatMap((s) => {
    const code = codeByFile.get(s.rel) ?? "";
    const call = registrationCallOf(code, toolId);
    return call === undefined ? [] : [{ code, call }];
  });
  if (hits.length !== 1) throw new Error(`${toolId}: registered in ${String(hits.length)} files`);
  const [hit] = hits;
  if (hit === undefined) throw new Error(toolId);
  return declaredInputKeys(withSchemaArgumentDeclarations(sources, hit.code, hit.call));
}

// The connector's own projection of a LaunchDarkly flag (`projectFlagState`), so a fixture cannot
// drift from the writer.
const flagStateModule = (await import(
  pathToFileURL(
    join(installedConnectorsPackageRoot(), "connectors", "launchdarkly", "src", "flag-state.ts"),
  ).href
)) as {
  projectFlagState(
    raw: unknown,
    ids: { projectKey: string; flagKey: string; environmentKey: string },
  ): Record<string, unknown>;
};

const RAW_FLAG = {
  key: "new-checkout",
  _version: 3,
  archived: false,
  variations: [
    { _id: "v-a", name: "Control", value: false },
    { _id: "v-b", name: "Treatment", value: true },
  ],
  environments: {
    production: {
      on: true,
      version: 12,
      offVariation: 0,
      fallthrough: {
        rollout: {
          variations: [
            { variation: 0, weight: 50000 },
            { variation: 1, weight: 50000 },
          ],
        },
      },
    },
    staging: { on: false, version: 4, offVariation: 0, fallthrough: { variation: 1 } },
  },
};

function ldState(
  environmentKey = "production",
  mutate: (raw: typeof RAW_FLAG) => unknown = (r) => r,
): Record<string, unknown> {
  return flagStateModule.projectFlagState(mutate(structuredClone(RAW_FLAG)), {
    projectKey: "default",
    flagKey: "new-checkout",
    environmentKey,
  });
}

const CLEAN: Readonly<Record<C3Row, Record<string, unknown>>> = {
  launchdarkly_flag_toggle: {
    projectKey: "default",
    flagKey: "new-checkout",
    environmentKey: "production",
    on: false,
  },
  launchdarkly_flag_rollout_set: {
    projectKey: "default",
    flagKey: "new-checkout",
    environmentKey: "production",
    weights: [
      { variationId: "v-a", percent: 40 },
      { variationId: "v-b", percent: 60 },
    ],
  },
  flagsmith_feature_state_set: { environmentKey: "env-key-1", featureId: 42, enabled: true },
  jira_ops_alert_acknowledge: { alertId: "abc-123" },
  jira_ops_alert_close: { alertId: "abc-123" },
};

const ACK_SUMMARY =
  "Ask Jira Service Management Operations to acknowledge alert abc-123 (Atlassian accepts the request and runs it asynchronously; Nimbus does not confirm it took effect; it cannot be un-acknowledged through Nimbus)";
const CLOSE_SUMMARY =
  "Ask Jira Service Management Operations to close alert abc-123 (Atlassian accepts the request and runs it asynchronously; Nimbus does not confirm it took effect; it cannot be reopened through Nimbus)";

const GOLDEN: Readonly<Record<C3Row, readonly string[]>> = {
  launchdarkly_flag_toggle: [
    "Service: launchdarkly",
    "Credential: personal",
    "Target:  production: default/new-checkout",
    "In environment production: turn LaunchDarkly flag new-checkout on or off (requested: on = false; project default)",
    "",
    '  Environment: "production"',
    '  projectKey: "default"',
    '  flagKey: "new-checkout"',
    "  Turn it on (true) or off (false): false",
  ],
  launchdarkly_flag_rollout_set: [
    "Service: launchdarkly",
    "Credential: personal",
    "Target:  production: default/new-checkout",
    "In environment production: set the percentage rollout of LaunchDarkly flag new-checkout (project default); every variation's percentage is listed below",
    "",
    '  Environment: "production"',
    '  projectKey: "default"',
    '  flagKey: "new-checkout"',
    '  Rollout (percent per variation id, must total 100): [{"variationId":"v-a","percent":40},{"variationId":"v-b","percent":60}]',
  ],
  flagsmith_feature_state_set: [
    "Service: flagsmith",
    "Credential: personal",
    "Target:  env-key-1: feature 42",
    "In environment env-key-1: enable or disable Flagsmith feature 42 (requested: enabled = true) and set its value when one is given",
    "",
    '  Environment: "env-key-1"',
    "  Feature id (the preview cannot show its name): 42",
    "  enabled: true",
    "  value: (not set: the value is left as it is)",
  ],
  jira_ops_alert_acknowledge: [
    "Service: jira",
    "Credential: personal",
    "Target:  abc-123",
    ACK_SUMMARY,
    "",
    '  Alert id (not a tinyId or alias): "abc-123"',
  ],
  jira_ops_alert_close: [
    "Service: jira",
    "Credential: personal",
    "Target:  abc-123",
    CLOSE_SUMMARY,
    "",
    '  Alert id (not a tinyId or alias): "abc-123"',
  ],
};

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

function previewOf(
  toolId: C3Row,
  input: Record<string, unknown>,
  before?: ConnectorWritePreview["before"],
): ConnectorWritePreview {
  const r = rowOf(toolId);
  const p = buildConnectorWritePreviewFrom(
    {
      type: r.actionType,
      origin: "model",
      payload: { mcpToolId: mcpClientToolKey(serviceOf(r.actionType), toolId), input },
    },
    CONNECTOR_WRITE_ROWS,
    () => "personal",
  );
  if (p === undefined) throw new Error(`no preview for ${toolId}`);
  return before === undefined ? p : { ...p, before };
}

const sortedKeys = (keys: Iterable<string>): string[] =>
  [...keys].sort((a, b) => a.localeCompare(b));
const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const fieldMap = (fields: readonly { label: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(fields.map((f) => [f.label, f.value]));

describe("C3 typed previews: the five flag and alert rows", () => {
  test("the five rows are mesh, wave 3, templated, offerable and have a reader", () => {
    expect(C3_ROWS).toHaveLength(5);
    for (const id of C3_ROWS) {
      const r = rowOf(id);
      expect(r.transport, id).toBe("mesh");
      expect(r.wave, id).toBe(3);
      expect(r.preview, id).toBeDefined();
      expect(r.registeredAs, id).toBeUndefined();
      expect(r.before, id).toBeDefined();
      expect(isModelOfferableRow(r), id).toBe(true);
    }
  });

  for (const id of C3_ROWS) {
    test(`golden lines: ${id}`, () => {
      const p = previewOf(id, CLEAN[id]);
      expect(renderConnectorWritePreviewLines(p)).toEqual([...GOLDEN[id]]);
      expect(p.otherFields).toEqual([]);
    });
  }

  test("the environment is the first thing after the summary, for both flag providers", () => {
    for (const id of [
      "launchdarkly_flag_toggle",
      "launchdarkly_flag_rollout_set",
      "flagsmith_feature_state_set",
    ] as const) {
      const lines = renderConnectorWritePreviewLines(previewOf(id, CLEAN[id]));
      expect(lines[4], id).toBe("");
      expect(lines[5], id).toMatch(/^ {2}Environment: /);
      expect(lines[3], id).toMatch(/^In environment /);
    }
  });

  test("the alert summaries do not claim the effect: asynchronous, not confirmed", () => {
    for (const id of ["jira_ops_alert_acknowledge", "jira_ops_alert_close"] as const) {
      const text = renderConnectorWritePreviewLines(previewOf(id, CLEAN[id])).join("\n");
      expect(text, id).toContain("asynchronously");
      expect(text, id).toContain("does not confirm");
      expect(text, id).toMatch(/^Ask Jira Service Management Operations to /m);
      // never a completed claim
      expect(text, id).not.toMatch(/\b(acknowledged|closed)\./);
      expect(text, id).not.toMatch(/\b(is|was|has been) (acknowledged|closed)/);
    }
  });

  test("the template keys equal the top-level 0.6.0 schema keys", () => {
    for (const id of C3_ROWS) {
      const t = rowOf(id).preview;
      if (t === undefined) throw new Error(id);
      expect(sortedKeys(previewTemplateKeys(t)), id).toEqual([...TEMPLATE_KEYS[id]]);
    }
  });

  test("the spelled-out keys equal what the installed package source declares (not circular)", () => {
    for (const id of C3_ROWS) {
      const declared = declaredWriteKeys(id);
      expect(declared.length, `${id}: the schema shape was not recognised`).toBeGreaterThan(0);
      expect(declared, id).toEqual([...DECLARED_KEYS[id]]);
    }
  });

  test("the readers are registered tools; args sends only the keys the tool declares; argKeys adds the write keys the select reads", () => {
    for (const id of C3_ROWS) {
      const want = READERS[id];
      const reader = rowOf(id).before;
      if (reader === undefined) throw new Error(id);
      expect(reader.tool, id).toBe(want.tool);
      // (1) the tool's own read schema
      expect(declaredReadKeys(reader.tool), id).toEqual([...want.keys]);
      // (2) what the reader sends
      const sent = reader.args(CLEAN[id]);
      expect(sortedKeys(Object.keys(sent ?? {})), id).toEqual([...want.keys]);
      // (3) what the reader declares: those plus the keys the select / guard read
      expect(sortedKeys(reader.argKeys), id).toEqual(sortedKeys([...want.keys, ...want.extra]));
    }
  });
});

describe("C3 readers' args", () => {
  test("LaunchDarkly: three non-empty strings, else no read", () => {
    const r = rowOf("launchdarkly_flag_toggle").before;
    expect(r?.args(CLEAN.launchdarkly_flag_toggle)).toEqual({
      projectKey: "default",
      flagKey: "new-checkout",
      environmentKey: "production",
    });
    for (const k of ["projectKey", "flagKey", "environmentKey"]) {
      for (const bad of ["", 7, null, undefined, {}]) {
        expect(
          r?.args({ ...CLEAN.launchdarkly_flag_toggle, [k]: bad }),
          `${k}=${String(bad)}`,
        ).toBeUndefined();
      }
    }
  });

  test("Flagsmith: a positive integer featureId (digit strings are fine), else no read", () => {
    const r = rowOf("flagsmith_feature_state_set").before;
    expect(r?.args({ environmentKey: "e", featureId: "42" })).toEqual({
      environmentKey: "e",
      featureId: 42,
    });
    for (const bad of [0, -1, 1.5, "4x", "", null, undefined, {}]) {
      expect(r?.args({ environmentKey: "e", featureId: bad }), String(bad)).toBeUndefined();
    }
    expect(r?.args({ environmentKey: "", featureId: 1 })).toBeUndefined();
  });

  test("Jira alert: a non-empty string alertId, else no read", () => {
    for (const id of ["jira_ops_alert_acknowledge", "jira_ops_alert_close"] as const) {
      const r = rowOf(id).before;
      expect(r?.args({ alertId: "a1" })).toEqual({ alertId: "a1" });
      for (const bad of ["", 3, null, undefined]) {
        expect(r?.args({ alertId: bad }), `${id} ${String(bad)}`).toBeUndefined();
      }
    }
  });
});

describe("C3 selectors", () => {
  test("LaunchDarkly toggle: on now, the change, off variation and fallthrough, built from projectFlagState", () => {
    const reply = mcp(ldState("production"));
    expect(fieldMap(selectLaunchdarklyToggle(reply, { on: false }))).toEqual({
      "On now": "true",
      Change: "turns it OFF (it is on now)",
      "Off variation": "Control (v-a)",
      "Fallthrough now": "rollout",
    });
    expect(fieldMap(selectLaunchdarklyToggle(reply, { on: true }))["Change"]).toBe(
      "no change (already on)",
    );
    const staging = ldState("staging");
    const f = fieldMap(selectLaunchdarklyToggle(staging, { on: true }));
    expect(f["On now"]).toBe("false");
    expect(f["Change"]).toBe("turns it ON (it is off now)");
    expect(f["Fallthrough now"]).toBe("single variation Treatment (v-b)");
    expect(fieldMap(selectLaunchdarklyToggle(staging, { on: false }))["Change"]).toBe(
      "no change (already off)",
    );
    // no boolean `on` in the request: no Change line
    expect(Object.hasOwn(fieldMap(selectLaunchdarklyToggle(staging, {})), "Change")).toBe(false);
  });

  test("LaunchDarkly: a reply without a boolean `on` throws (the prompt reads unavailable)", () => {
    expect(() => selectLaunchdarklyToggle({ variations: [] }, { on: true })).toThrow();
    expect(() => selectLaunchdarklyToggle("nope", { on: true })).toThrow();
    expect(() => selectLaunchdarklyRollout({ on: "yes" }, { weights: [] })).toThrow();
  });

  test("a variation with no name shows its value; with neither, its id; never 'undefined'", () => {
    const reply = ldState("production", (r) => {
      r.variations = [
        { _id: "v-a", name: undefined as unknown as string, value: "blue" as unknown as boolean },
        { _id: "v-b", name: "", value: undefined as unknown as boolean },
      ];
      return r;
    });
    const f = selectLaunchdarklyToggle(reply, { on: true });
    const text = JSON.stringify(f);
    expect(text).not.toContain("undefined");
    expect(fieldMap(f)["Off variation"]).toBe("blue (v-a)");
    const rollout = selectLaunchdarklyRollout(reply, {
      weights: [
        { variationId: "v-a", percent: 10 },
        { variationId: "v-b", percent: 90 },
      ],
    });
    expect(JSON.stringify(rollout)).not.toContain("undefined");
    expect(fieldMap(rollout)["v-b (v-b)"]).toBe("now 50% -> 90%");
  });

  test("rollout: every variation by name with now -> new, the total, and the environment's state", () => {
    const f = selectLaunchdarklyRollout(
      mcp(ldState("production")),
      CLEAN.launchdarkly_flag_rollout_set,
    );
    expect(f.slice(0, 2)).toEqual([
      { label: "Control (v-a)", value: "now 50% -> 40%" },
      { label: "Treatment (v-b)", value: "now 50% -> 60%" },
    ]);
    const m = fieldMap(f);
    expect(m["Total in this request"]).toBe("100%");
    expect(m["On now"]).toBe("true");
    expect(m["Off variation"]).toBe("Control (v-a)");
    expect(m["Fallthrough now"]).toBe("rollout");
    expect(m["Version"]).toBe("12");
  });

  test("rollout: from a single-variation fallthrough the chosen one is 100% now and the rest 0%", () => {
    const m = fieldMap(
      selectLaunchdarklyRollout(ldState("staging"), CLEAN.launchdarkly_flag_rollout_set),
    );
    expect(m["Control (v-a)"]).toBe("now 0% -> 40%");
    expect(m["Treatment (v-b)"]).toBe("now 100% -> 60%");
    expect(m["Fallthrough now"]).toBe("single variation Treatment (v-b)");
  });

  test("rollout: a variation the request omits reads NOT IN THIS REQUEST; an unknown id reads UNKNOWN", () => {
    const omitted = fieldMap(
      selectLaunchdarklyRollout(ldState(), {
        weights: [{ variationId: "v-a", percent: 100 }],
      }),
    );
    expect(omitted["Control (v-a)"]).toBe("now 50% -> 100%");
    expect(omitted["Treatment (v-b)"]).toBe("now 50% -> NOT IN THIS REQUEST");
    const unknown = selectLaunchdarklyRollout(ldState(), {
      weights: [
        { variationId: "v-a", percent: 50 },
        { variationId: "v-zzz", percent: 50 },
      ],
    });
    expect(unknown).toContainEqual({
      label: "UNKNOWN variation id v-zzz",
      value: "requested 50%, but the flag has no such variation",
    });
  });

  test("rollout: a malformed weights value does not throw and shows no invented percentage", () => {
    for (const weights of [
      undefined,
      "x",
      [null, 3, { variationId: 5 }],
      [{ variationId: "v-a" }],
    ]) {
      const f = selectLaunchdarklyRollout(ldState(), { weights });
      expect(JSON.stringify(f), String(weights)).not.toContain("undefined");
      expect(fieldMap(f)["Control (v-a)"], String(weights)).toMatch(
        /NOT IN THIS REQUEST|not a number/,
      );
    }
  });

  test("rollout: values are capped by excerptHead", () => {
    const long = "n".repeat(5000);
    const reply = ldState("production", (r) => {
      r.variations = [
        { _id: "v-a", name: long, value: false },
        { _id: "v-b", name: "B", value: true },
      ];
      return r;
    });
    const f = selectLaunchdarklyToggle(reply, { on: true });
    expect(fieldMap(f)["Off variation"]).toContain("more characters not shown");
  });

  const FS = {
    environment_default: { enabled: false, value: { type: "string", value: "blue" } },
    segment_overrides: [{ segment: 1 }, { segment: 2 }],
  };

  test("Flagsmith: enabled now, typed value, segment overrides (not changed), and the change", () => {
    expect(fieldMap(selectFlagsmithState(mcp(FS), { enabled: true }))).toEqual({
      "Enabled now": "false",
      Change: "turns it ON (it is off now)",
      "Value now": "string blue",
      "Segment overrides": "2 (not changed by this write)",
    });
    expect(fieldMap(selectFlagsmithState(FS, { enabled: false }))["Change"]).toBe(
      "no change (already off)",
    );
    const on = {
      ...FS,
      environment_default: { enabled: true, value: { type: "integer", value: 7 } },
    };
    const f = fieldMap(selectFlagsmithState(on, { enabled: false }));
    expect(f["Change"]).toBe("turns it OFF (it is on now)");
    expect(f["Value now"]).toBe("integer 7");
  });

  test("Flagsmith: a request that carries a value says the value will be set, and names a type change", () => {
    const same = fieldMap(
      selectFlagsmithState(FS, { enabled: false, value: { type: "string", value: "green" } }),
    );
    expect(same["Change"]).toBe("no change (already off); sets the value to string green");
    expect(same["Value now"]).toBe("string blue");
    const typed = fieldMap(
      selectFlagsmithState(FS, { enabled: true, value: { type: "integer", value: "7" } }),
    );
    expect(typed["Change"]).toBe(
      "turns it ON (it is off now); sets the value to integer 7 (the type changes from string to integer)",
    );
    const unknownNow = fieldMap(
      selectFlagsmithState(
        { environment_default: { enabled: true, value: 5 }, segment_overrides: [] },
        { enabled: true, value: { type: "boolean", value: "true" } },
      ),
    );
    expect(unknownNow["Change"]).toContain(
      "sets the value to boolean true (the current type is unknown)",
    );
    // No value in the request: the Change line is the switch alone.
    expect(fieldMap(selectFlagsmithState(FS, { enabled: true }))["Change"]).toBe(
      "turns it ON (it is off now)",
    );
  });

  test("Flagsmith: the reader declares value, so the select sees it", () => {
    expect(rowOf("flagsmith_feature_state_set").before?.argKeys).toContain("value");
  });

  test("Flagsmith: an unexpected value shape never throws; it shows the raw JSON excerpt or unknown", () => {
    const odd = fieldMap(
      selectFlagsmithState(
        { environment_default: { enabled: true, value: ["a", { b: 1 }] }, segment_overrides: [] },
        { enabled: true },
      ),
    );
    expect(odd["Value now"]).toBe('["a",{"b":1}]');
    expect(odd["Segment overrides"]).toBe("0 (not changed by this write)");
    const none = fieldMap(
      selectFlagsmithState({ environment_default: { enabled: true } }, { enabled: true }),
    );
    expect(none["Value now"]).toBe("unknown");
    expect(none["Segment overrides"]).toBe("unknown");
    const longRaw = fieldMap(
      selectFlagsmithState(
        {
          environment_default: {
            enabled: true,
            value: { type: "string", value: "z".repeat(5000) },
          },
        },
        {},
      ),
    );
    expect(longRaw["Value now"]).toContain("more characters not shown");
  });

  test("Flagsmith: segmentOverridesNotShown is counted, not hidden", () => {
    const f = fieldMap(
      selectFlagsmithState(
        {
          ...FS,
          segment_overrides: new Array(50).fill({ segment: 1 }),
          segmentOverridesNotShown: 7,
        },
        { enabled: true },
      ),
    );
    expect(f["Segment overrides"]).toBe("50 (not changed by this write) (7 more not shown)");
  });

  test("Flagsmith: a reply without environment_default throws (the prompt reads unavailable)", () => {
    expect(() => selectFlagsmithState({ segment_overrides: [] }, { enabled: true })).toThrow();
    expect(() => selectFlagsmithState({ environment_default: "x" }, { enabled: true })).toThrow();
    expect(() => selectFlagsmithState("nope", {})).toThrow();
  });

  const ALERT = {
    id: "abc-123",
    tinyId: "42",
    message: "CPU high on db-1",
    status: "open",
    acknowledged: false,
    priority: "P2",
    source: "datadog",
    count: 3,
    responders: [{ type: "user", id: "RESPONDER-ID-XYZ" }],
  };

  test("alert: message, status, acknowledged, priority, source, count; never the responders", () => {
    const f = fieldMap(selectJiraOpsAlert(mcp(ALERT)));
    expect(f).toEqual({
      Message: "CPU high on db-1",
      Status: "open",
      Acknowledged: "no",
      Priority: "P2",
      Source: "datadog",
      Count: "3",
    });
    expect(JSON.stringify(f)).not.toContain("RESPONDER-ID");
  });

  test("alert: an already closed or already acknowledged alert says so (shown, not blocked)", () => {
    expect(fieldMap(selectJiraOpsAlert({ ...ALERT, status: "closed" }))["Note"]).toBe(
      "Already closed: acknowledging or closing it again changes nothing",
    );
    expect(
      fieldMap(selectJiraOpsAlert({ ...ALERT, status: "acked", acknowledged: true }))["Note"],
    ).toBe("Already acknowledged: acknowledging it again changes nothing (it can still be closed)");
    expect(
      Object.hasOwn(fieldMap(selectJiraOpsAlert({ ...ALERT, status: "snoozed" })), "Note"),
    ).toBe(false);
  });

  test("alert: no message throws; a long message is capped", () => {
    expect(() => selectJiraOpsAlert({ status: "open" })).toThrow();
    expect(() => selectJiraOpsAlert("nope")).toThrow();
    expect(
      fieldMap(selectJiraOpsAlert({ ...ALERT, message: "m".repeat(5000) }))["Message"],
    ).toContain("more characters not shown");
  });
});

describe("C3 rollout guard (fail closed)", () => {
  const guard = rowOf("launchdarkly_flag_rollout_set").before?.guard;
  if (guard === undefined) throw new Error("the rollout row has no guard");
  const reply = mcp(ldState());
  const w = (...ids: string[]) => ({
    weights: ids.map((variationId) => ({ variationId, percent: 100 / ids.length })),
  });

  test("it has one fixed reason and applies to every call", () => {
    expect(guard.reason).toBe(
      "name every variation of the flag, by id from launchdarkly_flag_state_get",
    );
    expect(guard.appliesTo(w("v-a"), undefined)).toBe(true);
    expect(guard.appliesTo({}, undefined)).toBe(true);
  });

  test("a request naming every variation exactly once is allowed", () => {
    expect(guard.allows(reply, w("v-a", "v-b"), undefined, undefined)).toBe(true);
    expect(guard.allows(ldState(), w("v-b", "v-a"), undefined, undefined)).toBe(true);
  });

  test("an omitted variation, an unknown id and a duplicate id are each refused", () => {
    expect(guard.allows(reply, w("v-a"), undefined, undefined)).toBe(false);
    expect(guard.allows(reply, w("v-a", "v-zzz"), undefined, undefined)).toBe(false);
    expect(guard.allows(reply, w("v-a", "v-b", "v-zzz"), undefined, undefined)).toBe(false);
    expect(guard.allows(reply, w("v-a", "v-a"), undefined, undefined)).toBe(false);
    expect(guard.allows(reply, w("v-a", "v-a", "v-b"), undefined, undefined)).toBe(false);
  });

  test("ids that differ by case or whitespace are different ids and are refused", () => {
    expect(guard.allows(reply, w("V-A", "v-b"), undefined, undefined)).toBe(false);
    expect(guard.allows(reply, w("v-a ", "v-b"), undefined, undefined)).toBe(false);
    expect(guard.allows(reply, w(" v-a", "v-b"), undefined, undefined)).toBe(false);
    expect(guard.allows(reply, w("v-a", "v-A"), undefined, undefined)).toBe(false);
  });

  test("a 0% variation is allowed and shown", () => {
    const ask = {
      weights: [
        { variationId: "v-a", percent: 0 },
        { variationId: "v-b", percent: 100 },
      ],
    };
    expect(guard.allows(reply, ask, undefined, undefined)).toBe(true);
    const f = fieldMap(selectLaunchdarklyRollout(reply, ask));
    expect(f["Control (v-a)"]).toBe("now 50% -> 0%");
    expect(f["Total in this request"]).toBe("100%");
  });

  test("a failed or unreadable read, or a malformed request, is refused", () => {
    expect(guard.allows(undefined, w("v-a", "v-b"), undefined, undefined)).toBe(false);
    expect(guard.allows("nope", w("v-a", "v-b"), undefined, undefined)).toBe(false);
    expect(guard.allows({ content: [] }, w("v-a", "v-b"), undefined, undefined)).toBe(false);
    for (const weights of [undefined, "x", [], [null], [{ variationId: 3 }], [{}]]) {
      expect(guard.allows(reply, { weights }, undefined, undefined), String(weights)).toBe(false);
    }
  });

  test("a flag with no variations, or one whose preview could not list every variation, is refused", () => {
    expect(
      guard.allows(
        ldState("production", (r) => {
          r.variations = [];
          return r;
        }),
        { weights: [{ variationId: "v-a", percent: 100 }] },
        undefined,
        undefined,
      ),
    ).toBe(false);
    const many = ldState("production", (r) => {
      r.variations = Array.from({ length: 20 }, (_, i) => ({
        _id: `v-${String(i)}`,
        name: `N${String(i)}`,
        value: i,
      })) as unknown as typeof r.variations;
      return r;
    });
    const all = {
      weights: Array.from({ length: 20 }, (_, i) => ({
        variationId: `v-${String(i)}`,
        percent: 5,
      })),
    };
    expect(guard.allows(many, all, undefined, undefined)).toBe(false);
  });
});

describe("C3 rollout field cap (nothing the owner needs is cut)", () => {
  const guard = rowOf("launchdarkly_flag_rollout_set").before?.guard;
  if (guard === undefined) throw new Error("the rollout row has no guard");
  const flagWith = (n: number) =>
    ldState("production", (r) => {
      r.variations = Array.from({ length: n }, (_, i) => ({
        _id: `v-${String(i)}`,
        name: `N${String(i)}`,
        value: i,
      })) as unknown as typeof r.variations;
      r.environments.production.fallthrough = { variation: 0 } as never;
      return r;
    });
  const askAll = (n: number) => ({
    weights: Array.from({ length: n }, (_, i) => ({
      variationId: `v-${String(i)}`,
      percent: 1,
    })),
  });

  test("the largest allowed flag lists every variation and every fixed line within the cap", () => {
    expect(ROLLOUT_MAX_VARIATIONS).toBe(15);
    const n = ROLLOUT_MAX_VARIATIONS;
    expect(guard.allows(flagWith(n), askAll(n), undefined, undefined)).toBe(true);
    const fields = selectLaunchdarklyRollout(flagWith(n), askAll(n));
    expect(fields.length).toBeLessThanOrEqual(BEFORE_STATE_MAX_FIELDS);
    const labels = fields.map((f) => f.label);
    for (const fixed of [
      "Total in this request",
      "On now",
      "Off variation",
      "Fallthrough now",
      "Version",
    ]) {
      expect(labels, fixed).toContain(fixed);
    }
    for (let i = 0; i < n; i += 1) {
      expect(labels.some((l) => l.endsWith(`(v-${String(i)})`))).toBe(true);
    }
  });

  test("one variation more is refused", () => {
    const n = ROLLOUT_MAX_VARIATIONS + 1;
    expect(guard.allows(flagWith(n), askAll(n), undefined, undefined)).toBe(false);
  });
});

// ---- the door: the five rows offered, read, prompted, refused and passed through ---------------

const ENTRY_KEYS: Readonly<Record<string, readonly string[]>> = {
  launchdarkly_flag_state_get: READERS.launchdarkly_flag_toggle.keys,
  flagsmith_feature_state_get: READERS.flagsmith_feature_state_set.keys,
  jira_ops_alert_get: ["alertId"],
};

/** What a server lists for `service`: each write with its 0.6.0 keys, each reader with its keys. */
function c3Listing(service: string, opts: { readonly omitReaders?: boolean } = {}) {
  const out: Record<string, unknown> = {};
  const entry = (keys: readonly string[]) => ({
    description: "tool",
    inputSchema: toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, {}])),
    } as Parameters<typeof toStandardSchema>[0]),
  });
  for (const id of C3_ROWS) {
    if (serviceOf(rowOf(id).actionType) !== service) continue;
    out[mcpClientToolKey(service, id)] = entry(TEMPLATE_KEYS[id]);
    if (opts.omitReaders !== true) {
      const tool = READERS[id].tool;
      out[mcpClientToolKey(service, tool)] = entry(ENTRY_KEYS[tool] ?? []);
    }
  }
  return out;
}

describe("C3 through the real door", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 84);
  });
  afterEach(() => db.close());

  const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;

  async function door(opts: {
    readonly omitReaders?: boolean;
    readonly readReply?: unknown;
    readonly readThrows?: boolean;
    readonly writeReply?: unknown;
  }) {
    for (const s of ["launchdarkly", "flagsmith", "jira"]) {
      const approved = C3_ROWS.filter((id) => serviceOf(rowOf(id).actionType) === s);
      setModelWriteEnablement(db, s, 3, 1, approved);
    }
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => ALLOWED,
      listServerTools: async (service) =>
        c3Listing(service, opts.omitReaders === true ? { omitReaders: true } : {}),
      toolsEpoch: () => 0,
      warn: () => {},
    });
    const prompts: string[] = [];
    const dispatched: PlannedAction[] = [];
    const audits: unknown[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async (p: string) => {
          prompts.push(p);
          return true;
        },
      } as ConsentChannel,
      {
        recordAudit: (entry: unknown) => {
          audits.push(entry);
        },
      } as AuditSink,
      {
        dispatch: async (a: PlannedAction) => {
          dispatched.push(a);
          if (opts.readThrows === true && isBeforeReadActionType(a.type)) {
            throw new Error("the read failed");
          }
          return isBeforeReadActionType(a.type)
            ? opts.readReply
            : (opts.writeReply ?? { ok: true });
        },
      } as ConnectorDispatcher,
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      undefined,
      createBeforeStateRunner(),
    );
    const tools = await buildConnectorWriteAgentTools(
      src,
      () => exec,
      (_s, _t, d) => d,
      new Set(),
    );
    return {
      prompts,
      dispatched,
      audits,
      offered: Object.keys(tools).sort((a, b) => a.localeCompare(b)),
      call: async (name: string, input: Record<string, unknown>) => {
        const t = tools[name] as
          | { execute?: (i: unknown, c: unknown) => Promise<unknown> }
          | undefined;
        if (t?.execute === undefined) throw new Error(`${name} is not offered`);
        return await t.execute(input, {});
      },
    };
  }

  const FIVE = C3_ROWS.map((id) => `${serviceOf(rowOf(id).actionType)}__${id}`).sort((a, b) =>
    a.localeCompare(b),
  );

  test("a wave-3 opt-in that approved the five offers exactly them", async () => {
    expect((await door({})).offered).toEqual(FIVE);
  });

  test("with the reader tools missing the toggle, flag state and alerts are still offered and prompt Before: unavailable", async () => {
    const d = await door({ omitReaders: true });
    expect(d.offered).toEqual(FIVE);
    expect(
      await d.call("launchdarkly__launchdarkly_flag_toggle", CLEAN.launchdarkly_flag_toggle),
    ).toEqual({ ok: true });
    expect(await d.call("jira__jira_ops_alert_close", CLEAN.jira_ops_alert_close)).toEqual({
      ok: true,
    });
    expect(d.prompts[0]).toContain("Before: unavailable");
    expect(d.prompts[1]).toContain("Before: unavailable");
    expect(d.dispatched.map((a) => a.type)).toEqual([
      "launchdarkly.flag.toggle",
      "jira.ops.alert.close",
    ]);
  });

  test("the rollout with its reader missing is refused by the guard: nothing is prompted or dispatched", async () => {
    const d = await door({ omitReaders: true });
    const out = await d.call(
      "launchdarkly__launchdarkly_flag_rollout_set",
      CLEAN.launchdarkly_flag_rollout_set,
    );
    expect(JSON.stringify(out)).toContain(
      "name every variation of the flag, by id from launchdarkly_flag_state_get",
    );
    expect(d.prompts).toEqual([]);
    expect(d.dispatched.some((a) => !isBeforeReadActionType(a.type))).toBe(false);
  });

  test("a rollout whose read throws, or whose reply has no such environment, is refused before the prompt", async () => {
    const throws = await door({ readThrows: true });
    const out = await throws.call(
      "launchdarkly__launchdarkly_flag_rollout_set",
      CLEAN.launchdarkly_flag_rollout_set,
    );
    expect(JSON.stringify(out)).toContain("name every variation");
    expect(throws.prompts).toEqual([]);
    expect(throws.dispatched.some((a) => !isBeforeReadActionType(a.type))).toBe(false);

    const missing = await door({ readReply: mcp({ key: "new-checkout" }) });
    const out2 = await missing.call(
      "launchdarkly__launchdarkly_flag_rollout_set",
      CLEAN.launchdarkly_flag_rollout_set,
    );
    expect(JSON.stringify(out2)).toContain("name every variation");
    expect(missing.prompts).toEqual([]);
    expect(missing.dispatched.some((a) => !isBeforeReadActionType(a.type))).toBe(false);
  });

  test("a toggle whose read throws is still prompted, with Before: unavailable", async () => {
    const d = await door({ readThrows: true });
    expect(
      await d.call("launchdarkly__launchdarkly_flag_toggle", CLEAN.launchdarkly_flag_toggle),
    ).toEqual({ ok: true });
    expect(d.prompts[0]).toContain("Before: unavailable");
  });

  test("a rollout that omits a variation is refused before the prompt; a complete one is prompted with every variation", async () => {
    const d = await door({ readReply: mcp(ldState()) });
    const refused = await d.call("launchdarkly__launchdarkly_flag_rollout_set", {
      ...CLEAN.launchdarkly_flag_rollout_set,
      weights: [{ variationId: "v-a", percent: 100 }],
    });
    expect(JSON.stringify(refused)).toContain("name every variation");
    expect(d.prompts).toEqual([]);
    expect(
      await d.call(
        "launchdarkly__launchdarkly_flag_rollout_set",
        CLEAN.launchdarkly_flag_rollout_set,
      ),
    ).toEqual({ ok: true });
    expect(d.prompts).toHaveLength(1);
    expect(d.prompts[0]).toContain("Control (v-a): now 50% -> 40%");
    expect(d.prompts[0]).toContain("Treatment (v-b): now 50% -> 60%");
    expect(d.prompts[0]).toContain("Total in this request: 100%");
    expect(d.prompts[0]).toContain("In environment production:");
  });

  test("an already-closed alert is shown in the prompt, not blocked", async () => {
    const d = await door({
      readReply: mcp({ id: "abc-123", message: "CPU high", status: "closed", acknowledged: true }),
    });
    expect(
      await d.call("jira__jira_ops_alert_acknowledge", CLEAN.jira_ops_alert_acknowledge),
    ).toEqual({ ok: true });
    expect(d.prompts[0]).toContain("Note: Already closed");
  });

  // Decision 9: the model gets the connector's reply byte for byte; nothing says "done".
  const REPLIES: ReadonlyArray<readonly [string, string, Record<string, unknown>, unknown]> = [
    [
      "Jira accepted",
      "jira__jira_ops_alert_acknowledge",
      CLEAN.jira_ops_alert_acknowledge,
      { status: "accepted", requestId: "req-1", took: 12 },
    ],
    [
      "LaunchDarkly confirmed:false",
      "launchdarkly__launchdarkly_flag_toggle",
      CLEAN.launchdarkly_flag_toggle,
      {
        ok: true,
        confirmed: false,
        projectKey: "default",
        environmentKey: "production",
        flagKey: "new-checkout",
      },
    ],
    [
      "Flagsmith confirmed:true",
      "flagsmith__flagsmith_feature_state_set",
      CLEAN.flagsmith_feature_state_set,
      { ok: true, environmentKey: "env-key-1", featureId: 42, confirmed: true, enabled: true },
    ],
  ];

  for (const [label, name, input, reply] of REPLIES) {
    test(`the model gets the dispatched reply byte for byte: ${label}`, async () => {
      const d = await door({
        readReply: mcp({ message: "m", status: "open", on: false }),
        writeReply: reply,
      });
      const out = await d.call(name, input);
      expect(out).toEqual(reply);
      expect(JSON.stringify(out)).toBe(JSON.stringify(reply));
      expect(JSON.stringify(out)).not.toMatch(/done|completed|succeeded|success/i);
    });
  }

  test("the executor records an accepted or confirmed:false reply like any dispatched write; no audit field says confirmed", async () => {
    const d = await door({
      readReply: mcp({ message: "m", status: "open" }),
      writeReply: { status: "accepted", requestId: "req-1" },
    });
    await d.call("jira__jira_ops_alert_close", CLEAN.jira_ops_alert_close);
    expect(d.audits.length).toBeGreaterThan(0);
    const text = JSON.stringify(d.audits);
    expect(text).not.toMatch(/confirmed/i);
    expect(text).not.toMatch(/"(?:status|result)":"(?:done|completed|confirmed)"/);
  });
});

describe("C3: the connector's own honesty is still in the installed package", () => {
  const read = (rel: string): string =>
    readFileSync(join(installedConnectorsPackageRoot(), "connectors", rel), "utf8");

  test("Jira alert tools say the action is asynchronous and return accepted, not completion", () => {
    const text = read(join("jira", "src", "tools.ts"));
    for (const id of ["jira_ops_alert_acknowledge", "jira_ops_alert_close"]) {
      const i = text.indexOf(`registerWriteTool(
    "${id}"`);
      expect(i, id).toBeGreaterThan(0);
      const desc = text.slice(i, text.indexOf("alertIdSchema", i));
      expect(desc, id).toContain("asynchronous");
      expect(desc, id).toContain("accepted");
    }
  });

  test("the LaunchDarkly result carries confirmed (false means accepted but not shown)", () => {
    const text = read(join("launchdarkly", "src", "tools.ts"));
    expect(text).toContain("confirmed: confirmed(response)");
    expect(text).toContain("the server accepted the write");
  });

  test("the Flagsmith write says confirmed is false when the reply does not show the new state", () => {
    const text = read(join("flagsmith", "src", "tools.ts"));
    expect(text).toContain("does not show the new state");
    expect(text).toContain("`confirmed`");
  });
});
