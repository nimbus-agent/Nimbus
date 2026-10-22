import { describe, expect, test } from "bun:test";
import {
  type LayerDoc,
  type LayerKind,
  type LayerRef,
  mergeLayerDocs,
  parseLayerDoc,
  renderEffectiveDoc,
} from "./layered-merge.ts";
import { parseNimbusDecisionsToml } from "./nimbus-toml.ts";

function ref(kind: LayerKind, id: string): LayerRef {
  return { kind, id, path: `/virtual/${id}.toml` };
}
const base = ref("base", "base");
const profile = ref("profile", "work");

function doc(layer: LayerRef, text: string): LayerDoc {
  return parseLayerDoc(layer, text);
}
function render(...docs: LayerDoc[]): string {
  return renderEffectiveDoc(mergeLayerDocs(docs));
}
function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("layered-merge", () => {
  test("scalar override", () => {
    const merged = mergeLayerDocs([
      doc(base, "[decisions]\nmin_confidence = 0.3"),
      doc(profile, "[decisions]\nmin_confidence = 0.6"),
    ]);
    const text = renderEffectiveDoc(merged);
    expect(text).toContain("min_confidence = 0.6");
    expect(text).not.toContain("0.3");
    const entry = merged.sections[0]?.entries[0];
    expect(entry?.layer.kind).toBe("profile");
    expect(entry?.shadowed).toEqual([{ layer: base, valRaw: "0.3" }]);
  });

  test("table keys merge", () => {
    const text = render(
      doc(base, '[glossary.terms]\nCDR = "a"\nSLA = "b"'),
      doc(profile, '[glossary.terms]\nSLA = "c"'),
    );
    expect(text).toContain('CDR = "a"');
    expect(text).toContain('SLA = "c"');
    expect(text).not.toContain('SLA = "b"');
  });

  test("section only in base is inherited", () => {
    const text = render(doc(base, "[chatops]\nenabled = true"), doc(profile, "[decisions]\nx = 1"));
    expect(text).toContain("[chatops]\nenabled = true");
  });

  test("copied profile does not duplicate arrays or fleet jobs", () => {
    const t = [
      '[[filesystem.roots]]\npath = "/a"',
      '[[filesystem.roots]]\npath = "/b"',
      '[[security.allowlist]]\nhost = "h"',
      '[[fleet.job]]\nname = "a"',
      '[[fleet.job]]\nname = "b"',
    ].join("\n");
    const text = render(doc(base, t), doc(profile, t));
    expect(count(text, "[[filesystem.roots]]")).toBe(2);
    expect(count(text, "[[security.allowlist]]")).toBe(1);
    expect(count(text, "[[fleet.job]]")).toBe(2);
  });

  test("array replaced whole", () => {
    const merged = mergeLayerDocs([
      doc(base, '[[filesystem.roots]]\npath = "/a"\n[[filesystem.roots]]\npath = "/b"'),
      doc(profile, '[[filesystem.roots]]\npath = "/c"'),
    ]);
    const text = renderEffectiveDoc(merged);
    expect(count(text, "[[filesystem.roots]]")).toBe(1);
    expect(text).toContain('path = "/c"');
    expect(merged.sections[0]?.blockLayer?.kind).toBe("profile");
  });

  test("fleet merges by name", () => {
    const text = render(
      doc(base, '[[fleet.job]]\nname = "a"\ninterval_seconds = 60\n[[fleet.job]]\nname = "b"'),
      doc(profile, '[[fleet.job]]\nname = "a"\ninterval_seconds = 120\n[[fleet.job]]\nname = "c"'),
    );
    const names = [...text.matchAll(/name = "(\w)"/g)].map((m) => m[1]);
    expect(names).toEqual(["a", "b", "c"]);
    expect(text).toContain("interval_seconds = 120");
    expect(text).not.toContain("interval_seconds = 60");
  });

  test("same-layer duplicate fleet name kept", () => {
    const text = render(doc(profile, '[[fleet.job]]\nname = "x"\n[[fleet.job]]\nname = "x"'));
    expect(count(text, "[[fleet.job]]")).toBe(2);
  });

  test("passthrough preserved", () => {
    const text = render(doc(profile, '[glossary.terms]\nFOO = "unterminated'));
    expect(text).toContain('FOO = "unterminated');
  });

  test("CRLF and quoted hash survive render", () => {
    const text = render(doc(base, '[connector]\r\nurl = "http://h/#frag" # c\r\nother = 1\r\n'));
    expect(text).not.toContain("\r");
    expect(text).toContain('url = "http://h/#frag" # c');
  });

  test("root keys", () => {
    const text = render(
      doc(base, "schema_version = 1\n[decisions]\nx = 1"),
      doc(profile, "schema_version = 2"),
    );
    expect(text.startsWith("schema_version = 2")).toBe(true);
    expect(text).not.toContain("schema_version = 1");
  });

  test("malformed header does not swallow overrides", () => {
    const text = render(
      doc(base, "[multimodal\nenabled = true\n[decisions]\nmin_confidence = 0.3"),
      doc(profile, "[decisions]\nmin_confidence = 0.6"),
    );
    const decisionsAt = text.indexOf("[decisions]");
    const malformedAt = text.indexOf("[multimodal");
    expect(decisionsAt).toBeGreaterThanOrEqual(0);
    expect(decisionsAt).toBeLessThan(malformedAt);
    expect(text.indexOf("enabled = true")).toBeGreaterThan(malformedAt);
    expect(parseNimbusDecisionsToml(text).minConfidence).toBeCloseTo(0.6, 5);
  });

  test("unterminated quoted header is malformed, not passthrough", () => {
    const parsed = doc(base, '[hitl.quorum."x]\nk = 1');
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]?.malformed).toBe('[hitl.quorum."x]');
    expect(parsed.sections[0]?.header).toBeNull();
  });
});
