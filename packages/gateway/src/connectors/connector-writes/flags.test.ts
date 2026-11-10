import { describe, expect, test } from "bun:test";

import {
  FLAGS_ROWS,
  ROLLOUT_MAX_VARIATIONS,
  selectFlagsmithState,
  selectLaunchdarklyRollout,
  selectLaunchdarklyToggle,
} from "./flags.ts";
import type { BeforeStateReader } from "./types.ts";

function reader(toolId: string): BeforeStateReader {
  const r = FLAGS_ROWS.find((x) => x.toolId === toolId)?.before;
  if (r === undefined) throw new Error(`no reader for ${toolId}`);
  return r;
}

function value(fields: readonly { label: string; value: string }[], label: string): string {
  return fields.find((f) => f.label === label)?.value ?? "<absent>";
}

const LD_REPLY = {
  on: true,
  offVariationId: "v-off",
  fallthrough: { variationId: "v-on" },
  version: "7",
  variations: [
    { id: "v-on", name: "Enabled" },
    { id: "v-off", value: false },
    { id: "v-json", value: { a: 1 } },
    { id: "v-blank" },
    { name: "no id" },
  ],
};

describe("LaunchDarkly toggle before-state", () => {
  test("names the switch change, the off variation and a single-variation fallthrough", () => {
    const f = selectLaunchdarklyToggle(LD_REPLY, { on: false });
    expect(value(f, "On now")).toBe("true");
    expect(value(f, "Change")).toBe("turns it OFF (it is on now)");
    expect(value(f, "Off variation")).toBe("false (v-off)");
    expect(value(f, "Fallthrough now")).toBe("single variation Enabled (v-on)");
  });

  test("a request equal to the current state is a no-op, an off flag turns ON", () => {
    expect(value(selectLaunchdarklyToggle(LD_REPLY, { on: true }), "Change")).toBe(
      "no change (already on)",
    );
    const off = { ...LD_REPLY, on: false };
    expect(value(selectLaunchdarklyToggle(off, { on: false }), "Change")).toBe(
      "no change (already off)",
    );
    expect(value(selectLaunchdarklyToggle(off, { on: true }), "Change")).toBe(
      "turns it ON (it is off now)",
    );
  });

  test("a non-boolean request shows no Change line", () => {
    expect(value(selectLaunchdarklyToggle(LD_REPLY, { on: "yes" }), "Change")).toBe("<absent>");
  });

  test("variation labels fall back from name to value (string, JSON) to id", () => {
    const f = (id: string): string =>
      value(selectLaunchdarklyToggle({ ...LD_REPLY, offVariationId: id }, {}), "Off variation");
    expect(f("v-json")).toBe('{"a":1} (v-json)');
    expect(f("v-blank")).toBe("v-blank (v-blank)");
  });

  test("an unresolved numeric off variation is shown raw, a missing one is omitted", () => {
    const raw = selectLaunchdarklyToggle(
      { ...LD_REPLY, offVariationId: undefined, offVariation: 3 },
      {},
    );
    expect(value(raw, "Off variation")).toBe("unresolved (raw value 3)");
    const none = selectLaunchdarklyToggle({ ...LD_REPLY, offVariationId: undefined }, {});
    expect(value(none, "Off variation")).toBe("<absent>");
  });

  test("an off variation id the flag does not list shows as the bare id", () => {
    const f = selectLaunchdarklyToggle({ ...LD_REPLY, offVariationId: "ghost" }, {});
    expect(value(f, "Off variation")).toBe("ghost");
  });

  test("a rollout fallthrough reads rollout; no fallthrough omits the line", () => {
    const rollout = selectLaunchdarklyToggle(
      { ...LD_REPLY, fallthrough: { rollout: [{ variationId: "v-on", weightPercent: 100 }] } },
      {},
    );
    expect(value(rollout, "Fallthrough now")).toBe("rollout");
    const none = selectLaunchdarklyToggle({ ...LD_REPLY, fallthrough: undefined }, {});
    expect(value(none, "Fallthrough now")).toBe("<absent>");
  });

  test("a reply whose `on` is not a boolean throws, so the prompt reads unavailable", () => {
    expect(() => selectLaunchdarklyToggle({ ...LD_REPLY, on: "true" }, {})).toThrow("no on");
    expect(() => selectLaunchdarklyToggle("nope", {})).toThrow();
  });
});

describe("LaunchDarkly rollout before-state", () => {
  const rolloutReply = {
    ...LD_REPLY,
    variations: [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ],
    fallthrough: {
      rollout: [
        { variationId: "a", weightPercent: 70 },
        { variationId: "b", weightPercent: 30 },
        { variationId: "", weightPercent: 5 },
        { variationId: "c", weightPercent: "x" },
      ],
    },
  };

  test("lists every variation now and after, then the total", () => {
    const f = selectLaunchdarklyRollout(rolloutReply, {
      weights: [
        { variationId: "a", percent: 40 },
        { variationId: "b", percent: 60 },
      ],
    });
    expect(value(f, "Alpha (a)")).toBe("now 70% -> 40%");
    expect(value(f, "Beta (b)")).toBe("now 30% -> 60%");
    expect(value(f, "Total in this request")).toBe("100%");
  });

  test("a variation the request omits, an unknown id and a junk percent are all named", () => {
    const f = selectLaunchdarklyRollout(rolloutReply, {
      weights: [
        { variationId: "a", percent: 50 },
        { variationId: "a", percent: 99 },
        { variationId: "zzz", percent: "lots" },
        { percent: 1 },
        "junk",
      ],
    });
    expect(value(f, "Alpha (a)")).toBe("now 70% -> 50%");
    expect(value(f, "Beta (b)")).toBe("now 30% -> NOT IN THIS REQUEST");
    expect(value(f, "UNKNOWN variation id zzz")).toBe(
      "requested (percent is not a number), but the flag has no such variation",
    );
    expect(value(f, "Total in this request")).toBe("50%");
  });

  test("a single-variation fallthrough reads 100 / 0, and none reads unknown", () => {
    const single = selectLaunchdarklyRollout(
      { ...rolloutReply, fallthrough: { variationId: "b" } },
      {},
    );
    expect(value(single, "Alpha (a)")).toBe("now 0% -> NOT IN THIS REQUEST");
    expect(value(single, "Beta (b)")).toBe("now 100% -> NOT IN THIS REQUEST");
    const none = selectLaunchdarklyRollout(
      { ...rolloutReply, fallthrough: null },
      { weights: "x" },
    );
    expect(value(none, "Alpha (a)")).toBe("now unknown -> NOT IN THIS REQUEST");
    expect(value(none, "Total in this request")).toBe("<absent>");
  });

  test("a fractional total is rounded to three places", () => {
    const f = selectLaunchdarklyRollout(rolloutReply, {
      weights: [
        { variationId: "a", percent: 33.3333333 },
        { variationId: "b", percent: 33.3333333 },
      ],
    });
    expect(value(f, "Total in this request")).toBe("66.667%");
  });
});

describe("LaunchDarkly rollout guard (fail closed)", () => {
  const guard = reader("launchdarkly_flag_rollout_set").guard;
  const flag = { on: true, variations: [{ id: "a" }, { id: "b" }] };
  const allows = (reply: unknown, picked: Record<string, unknown>): boolean =>
    guard?.allows(reply, picked, undefined, undefined) ?? false;

  test("applies to every request", () => {
    expect(guard?.appliesTo({}, undefined)).toBe(true);
  });

  test("allows a request naming every variation exactly once", () => {
    expect(
      allows(flag, {
        weights: [
          { variationId: "b", percent: 50 },
          { variationId: "a", percent: 50 },
        ],
      }),
    ).toBe(true);
  });

  test.each([
    ["an omitted variation", [{ variationId: "a", percent: 100 }]],
    ["an id the flag lacks", [{ variationId: "a" }, { variationId: "b" }, { variationId: "c" }]],
    ["a repeated id", [{ variationId: "a" }, { variationId: "a" }]],
    ["an entry without an id", [{ variationId: "a" }, { percent: 1 }]],
    ["an empty list", []],
  ])("refuses %s", (_n, weights) => {
    expect(allows(flag, { weights })).toBe(false);
  });

  test("refuses without a weights list, an unreadable reply or a flag without variations", () => {
    expect(allows(flag, {})).toBe(false);
    expect(allows("not an object", { weights: [{ variationId: "a" }] })).toBe(false);
    expect(allows({ on: true, variations: [] }, { weights: [{ variationId: "a" }] })).toBe(false);
  });

  test("refuses a flag with more variations than the prompt can list without cutting one", () => {
    const ids = Array.from({ length: ROLLOUT_MAX_VARIATIONS + 1 }, (_v, i) => `v${String(i)}`);
    expect(
      allows(
        { on: true, variations: ids.map((id) => ({ id })) },
        { weights: ids.map((variationId) => ({ variationId, percent: 1 })) },
      ),
    ).toBe(false);
  });
});

describe("read arguments", () => {
  test("LaunchDarkly needs all three keys as non-empty strings and sends only them", () => {
    const args = reader("launchdarkly_flag_toggle").args;
    expect(args({ projectKey: "p", flagKey: "f", environmentKey: "e", on: true })).toEqual({
      projectKey: "p",
      flagKey: "f",
      environmentKey: "e",
    });
    expect(args({ projectKey: "p", flagKey: "", environmentKey: "e" })).toBeUndefined();
    expect(args({ projectKey: "p", flagKey: "f" })).toBeUndefined();
    expect(args({ flagKey: "f", environmentKey: "e" })).toBeUndefined();
  });

  test("Flagsmith needs an environment and a positive integer feature id", () => {
    const args = reader("flagsmith_feature_state_set").args;
    expect(args({ environmentKey: "env", featureId: 12, enabled: true })).toEqual({
      environmentKey: "env",
      featureId: 12,
    });
    expect(args({ environmentKey: "", featureId: 12 })).toBeUndefined();
    expect(args({ environmentKey: "env", featureId: 0 })).toBeUndefined();
  });
});

describe("Flagsmith feature state before-state", () => {
  const reply = (over: Record<string, unknown> = {}): unknown => ({
    environment_default: { enabled: false, value: { type: "string", value: "old" } },
    segment_overrides: [{}, {}],
    ...over,
  });

  test("shows the switch, the value now and the segment overrides the write does not change", () => {
    const f = selectFlagsmithState(reply(), { enabled: true });
    expect(value(f, "Enabled now")).toBe("false");
    expect(value(f, "Change")).toBe("turns it ON (it is off now)");
    expect(value(f, "Value now")).toBe("string old");
    expect(value(f, "Segment overrides")).toBe("2 (not changed by this write)");
  });

  test("names a value change and a type change", () => {
    const same = selectFlagsmithState(reply(), { value: { type: "string", value: "new" } });
    expect(value(same, "Change")).toBe("sets the value to string new");
    const typed = selectFlagsmithState(reply(), {
      enabled: false,
      value: { type: "int", value: 4 },
    });
    expect(value(typed, "Change")).toBe(
      "no change (already off); sets the value to int 4 (the type changes from string to int)",
    );
  });

  test("a current value with no type makes the type unknown", () => {
    const f = selectFlagsmithState(
      reply({ environment_default: { enabled: true, value: "plain" } }),
      { value: { type: "bool", value: true } },
    );
    expect(value(f, "Change")).toBe("sets the value to bool true (the current type is unknown)");
    expect(value(f, "Value now")).toBe('"plain"');
  });

  test("an untyped or odd requested value is shown as JSON, never failing", () => {
    const f1 = selectFlagsmithState(reply(), { value: "raw" });
    expect(value(f1, "Change")).toContain('sets the value to "raw"');
    const f2 = selectFlagsmithState(reply(), { value: { value: { nested: 1 } } });
    expect(value(f2, "Change")).toContain('? {"nested":1}');
    const f3 = selectFlagsmithState(reply(), { value: null });
    expect(value(f3, "Change")).toBe("<absent>");
  });

  test("unexpected stored shapes read unknown", () => {
    const f = selectFlagsmithState(
      { environment_default: { enabled: "maybe" }, segment_overrides: "x" },
      {},
    );
    expect(value(f, "Enabled now")).toBe("unknown");
    expect(value(f, "Value now")).toBe("unknown");
    expect(value(f, "Segment overrides")).toBe("unknown");
    expect(value(f, "Change")).toBe("<absent>");
  });

  test("overrides not shown are counted", () => {
    const f = selectFlagsmithState(reply({ segmentOverridesNotShown: 4 }), {});
    expect(value(f, "Segment overrides")).toBe("2 (not changed by this write) (4 more not shown)");
    const g = selectFlagsmithState(reply({ segmentOverridesNotShown: 0 }), {});
    expect(value(g, "Segment overrides")).toBe("2 (not changed by this write)");
  });

  test("a reply without environment_default throws", () => {
    expect(() => selectFlagsmithState({}, {})).toThrow("no environment_default");
    expect(() => selectFlagsmithState({ environment_default: 3 }, {})).toThrow();
  });
});
