import { describe, expect, test } from "bun:test";
import { mergeLayerDocs, parseLayerDoc } from "../config/layered-merge.ts";
import { CATALOG_AGENT_NAMES } from "./agent-catalog.ts";
import { resolveAgentVisibility, visibleAgentNames } from "./agent-visibility.ts";

const base = (body: string) =>
  parseLayerDoc({ kind: "base", id: "base", path: "/virtual/base.toml" }, `[agents]\n${body}\n`);
const snapshot = (body: string) => ({ doc: mergeLayerDocs([base(body)]) });

describe("visibleAgentNames", () => {
  test("with no [agents] section every catalog agent is visible and none user-hidden", () => {
    const v = visibleAgentNames({ doc: mergeLayerDocs([]) });
    expect(v.basis).toBe("all");
    expect([...v.visible].sort()).toEqual([...CATALOG_AGENT_NAMES].sort());
    expect(v.userHidden.size).toBe(0);
  });

  test("an agent the base file hides is visible=false and reported as user-hidden", () => {
    const first = CATALOG_AGENT_NAMES[0];
    expect(first).toBeDefined();
    const v = visibleAgentNames(snapshot(`hide = ["${first}"]`));
    expect(v.visible.has(first as string)).toBe(false);
    expect([...v.userHidden]).toEqual([first as string]);
  });
});

describe("resolveAgentVisibility overrides order", () => {
  test("overrides are sorted by agent name in code-unit order", () => {
    const v = resolveAgentVisibility(snapshot('hide = ["standup", "catchup", "oncall"]'), [
      "catchup",
      "oncall",
      "standup",
    ]);
    expect(v.overrides.map((o) => o.agent)).toEqual(["catchup", "oncall", "standup"]);
  });
});
