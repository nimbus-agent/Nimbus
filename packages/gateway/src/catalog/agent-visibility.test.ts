import { describe, expect, test } from "bun:test";
import {
  type LayerKind,
  type LayerRef,
  mergeLayerDocs,
  parseLayerDoc,
} from "../config/layered-merge.ts";
import {
  describeAgentVisibility,
  normaliseAgentName,
  resolveAgentVisibility,
} from "./agent-visibility.ts";

const KNOWN = ["catchup", "decisions", "oncall", "standup"] as const;

function ref(kind: LayerKind, id: string): LayerRef {
  return { kind, id, path: `/virtual/${kind}-${id}.toml` };
}

const pack = (id: string, body: string) => parseLayerDoc(ref("pack", id), `[agents]\n${body}\n`);
const base = (body: string) => parseLayerDoc(ref("base", "base"), `[agents]\n${body}\n`);
const profile = (body: string) => parseLayerDoc(ref("profile", "work"), `[agents]\n${body}\n`);

function resolve(...docs: ReturnType<typeof parseLayerDoc>[]) {
  return resolveAgentVisibility({ doc: mergeLayerDocs(docs) }, KNOWN);
}

const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe("resolveAgentVisibility", () => {
  test("no pack sets visible: every agent starts visible", () => {
    const v = resolve(base('show = ["oncall"]'));
    expect(v.basis).toBe("all");
    expect(sorted(v.visible)).toEqual([...KNOWN]);
  });

  test("packs union their lists", () => {
    const v = resolve(pack("ops", 'visible = ["oncall"]'), pack("data", 'visible = ["decisions"]'));
    expect(v.basis).toBe("packs");
    expect(sorted(v.visible)).toEqual(["decisions", "oncall"]);
    expect(v.packs).toEqual(["ops", "data"]);
  });

  test("the base file hides an agent", () => {
    const v = resolve(base('hide = ["standup"]'));
    expect(sorted(v.visible)).toEqual(["catchup", "decisions", "oncall"]);
    expect(v.overrides).toEqual([{ agent: "standup", visible: false, layer: ref("base", "base") }]);
  });

  test("the profile's show beats the base's hide", () => {
    const v = resolve(base('hide = ["decisions"]'), profile('show = ["decisions"]'));
    expect(v.visible.has("decisions")).toBe(true);
    expect(v.overrides).toEqual([
      { agent: "decisions", visible: true, layer: ref("profile", "work") },
    ]);
  });

  test("hide beats show within one layer", () => {
    const v = resolve(base('show = ["oncall"]\nhide = ["oncall"]'));
    expect(v.visible.has("oncall")).toBe(false);
    expect(v.overrides).toEqual([{ agent: "oncall", visible: false, layer: ref("base", "base") }]);
  });

  test("show adds an agent no pack listed", () => {
    const v = resolve(pack("ops", 'visible = ["oncall"]'), base('show = ["standup"]'));
    expect(sorted(v.visible)).toEqual(["oncall", "standup"]);
  });

  test("a typo in a pack list drops only that name", () => {
    const v = resolve(pack("ops", 'visible = ["oncall", "standpu"]'));
    expect(v.basis).toBe("packs");
    expect(sorted(v.visible)).toEqual(["oncall"]);
    expect(v.notes).toContain('unknown agent "standpu" in pack:ops [agents] visible');
  });

  test("normalises the agents. prefix on both sides", () => {
    expect(normaliseAgentName("agents.standup")).toBe("standup");
    expect(normaliseAgentName("standup")).toBe("standup");
    const v = resolve(
      pack("ops", 'visible = ["agents.oncall"]'),
      base('show = ["agents.standup"]'),
    );
    expect(sorted(v.visible)).toEqual(["oncall", "standup"]);
    const w = resolve(base('hide = ["agents.standup"]'));
    expect(w.visible.has("standup")).toBe(false);
  });

  test("a user-file visible is ignored and noted", () => {
    const v = resolve(base('visible = ["oncall"]'));
    expect(v.basis).toBe("all");
    expect(sorted(v.visible)).toEqual([...KNOWN]);
    expect(v.notes).toEqual([
      "[agents] visible in base:base is ignored: only packs set it; use show and hide",
    ]);
  });

  test("an unknown name is dropped and noted; the rest applies", () => {
    const v = resolve(base('hide = ["agents.standpu", "standup"]'));
    expect(v.visible.has("standup")).toBe(false);
    expect(v.notes).toEqual(['unknown agent "standpu" in base:base [agents] hide']);
    const w = resolve(base('hide = ["standpu"]'));
    expect(w.notes).toEqual(v.notes);
  });

  test("a malformed show is ignored and noted", () => {
    const v = resolve(base('show = "decisions"\nhide = 42'));
    expect(sorted(v.visible)).toEqual([...KNOWN]);
    expect(v.notes).toContain("[agents] show in base:base is not an array of agent names; ignored");
    expect(v.notes).toContain("[agents] hide in base:base is not an array of agent names; ignored");
  });

  test("a malformed pack visible is skipped and noted", () => {
    const v = resolve(pack("ops", 'visible = "oncall"'));
    expect(v.basis).toBe("all");
    expect(v.notes).toEqual([
      "[agents] visible in pack:ops is not an array of agent names; ignored",
    ]);
  });

  test("no [agents] section: every agent visible, no notes", () => {
    const v = resolveAgentVisibility(
      { doc: mergeLayerDocs([parseLayerDoc(ref("base", "base"), '[llm]\nx = "y"\n')]) },
      KNOWN,
    );
    expect(v.basis).toBe("all");
    expect(sorted(v.visible)).toEqual([...KNOWN]);
    expect(v.packs).toEqual([]);
    expect(v.overrides).toEqual([]);
    expect(v.notes).toEqual([]);
  });

  test("a key repeated in one layer counts the lower layers once", () => {
    const v = resolve(
      pack("ops", 'visible = ["oncall"]'),
      pack("data", 'visible = ["decisions"]\nvisible = ["decisions"]'),
    );
    expect(v.packs).toEqual(["ops", "data"]);
    expect(sorted(v.visible)).toEqual(["decisions", "oncall"]);
  });

  test("a user layer repeating a key counts each layer once", () => {
    const v = resolve(
      base('show = ["catchup"]'),
      profile('show = ["standup"]\nshow = ["standup"]'),
    );
    expect(v.overrides).toEqual([
      { agent: "catchup", visible: true, layer: ref("base", "base") },
      { agent: "standup", visible: true, layer: ref("profile", "work") },
    ]);
  });

  test("the profile's hide beats the base's show", () => {
    const v = resolve(base('show = ["decisions"]'), profile('hide = ["decisions"]'));
    expect(v.visible.has("decisions")).toBe(false);
    expect(v.overrides).toEqual([
      { agent: "decisions", visible: false, layer: ref("profile", "work") },
    ]);
  });

  test("describeAgentVisibility renders the summary, overrides and notes", () => {
    const v = resolve(
      pack("ops", 'visible = ["oncall"]'),
      pack("data", 'visible = ["decisions"]'),
      base('show = ["standup"]\nhide = ["decisions", "nope"]'),
    );
    expect(describeAgentVisibility(v)).toEqual([
      "agent visibility: the agents listed by packs ops, data",
      'agent "decisions" is hidden by base:base',
      'agent "standup" is shown by base:base',
      'unknown agent "nope" in base:base [agents] hide',
    ]);
    expect(describeAgentVisibility(resolve())[0]).toBe(
      "agent visibility: all agents (no active pack sets [agents] visible)",
    );
  });
});
