import { describe, expect, test } from "bun:test";
import {
  type LayerRef,
  layerLabel,
  layerValues,
  mergeLayerDocs,
  parseLayerDoc,
} from "./layered-merge.ts";

const base: LayerRef = { kind: "base", id: "base", path: "/virtual/base.toml" };
const profile: LayerRef = { kind: "profile", id: "work", path: "/virtual/work.toml" };

describe("layerLabel", () => {
  test("joins kind and id with a colon", () => {
    expect(layerLabel(profile)).toBe("profile:work");
    expect(layerLabel(base)).toBe("base:base");
  });
});

describe("layerValues", () => {
  const merged = mergeLayerDocs([
    parseLayerDoc(base, "[decisions]\nmin_confidence = 0.3\nother = 1"),
    parseLayerDoc(profile, "[decisions]\nmin_confidence = 0.6"),
  ]);
  const entries = merged.sections.flatMap((s) => s.entries);

  test("returns shadowed layers low to high, then the winner", () => {
    const values = layerValues(entries, "min_confidence");
    expect(values.map((v) => [layerLabel(v.layer), v.valRaw])).toEqual([
      ["base:base", "0.3"],
      ["profile:work", "0.6"],
    ]);
  });

  test("a key set in one layer yields a single value", () => {
    const values = layerValues(entries, "other");
    expect(values).toHaveLength(1);
    expect(values[0]?.valRaw).toBe("1");
  });

  test("an unknown key yields nothing", () => {
    expect(layerValues(entries, "missing")).toEqual([]);
  });
});
