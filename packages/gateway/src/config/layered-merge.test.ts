import { describe, expect, test } from "bun:test";
import {
  type LayerDoc,
  type LayerKind,
  type LayerRef,
  mergeLayerDocs,
  parseLayerDoc,
  renderEffectiveDoc,
  UNPARSED_SECTION_HEADER,
} from "./layered-merge.ts";
import { parseNimbusDecisionsToml } from "./nimbus-toml.ts";
import { parseGlossaryManualToml } from "./nimbus-toml-glossary-terms.ts";

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

  test("malformed block keys are not attributed to a valid section (single layer)", () => {
    const text = render(
      doc(base, "[multimodal\nenabled = false\n[decisions]\nmin_confidence = 0.3"),
    );
    const cfg = parseNimbusDecisionsToml(text);
    expect(cfg.enabled).toBe(true);
    expect(cfg.minConfidence).toBeCloseTo(0.3, 5);
    expect(text).toContain(`[${UNPARSED_SECTION_HEADER}]`);
  });

  test("malformed block keys are not attributed to a valid section (two layers)", () => {
    const text = render(
      doc(base, "[multimodal\nenabled = false\n[decisions]\nmin_confidence = 0.3"),
      doc(profile, "[decisions]\nmin_confidence = 0.6"),
    );
    const cfg = parseNimbusDecisionsToml(text);
    expect(cfg.enabled).toBe(true);
    expect(cfg.minConfidence).toBeCloseTo(0.6, 5);
  });

  test("no sentinel when nothing is malformed", () => {
    expect(render(doc(base, "[decisions]\nx = 1"))).not.toContain(UNPARSED_SECTION_HEADER);
  });

  test("single-layer round trip preserves what the section parsers read", () => {
    const original = [
      "schema_version = 1",
      "[decisions]",
      "min_confidence = 0.7",
      "max_llm_calls_per_pass = 4",
      "[glossary.terms]",
      'CDR = "call detail record"',
      "[[filesystem.roots]]",
      'path = "/a"',
      "[[filesystem.roots]]",
      'path = "/b"',
      "[[fleet.job]]",
      'name = "a"',
      "[[fleet.job]]",
      'name = "b"',
      "",
    ].join("\n");
    const rendered = render(doc(base, original));
    expect(parseNimbusDecisionsToml(rendered)).toEqual(parseNimbusDecisionsToml(original));
    expect(parseGlossaryManualToml(rendered)).toEqual(parseGlossaryManualToml(original));
  });

  test("higher-layer fleet job replaces every same-named lower-layer copy", () => {
    const text = render(
      doc(
        base,
        '[[fleet.job]]\nname = "x"\ninterval_seconds = 1\n[[fleet.job]]\nname = "y"\n[[fleet.job]]\nname = "x"\ninterval_seconds = 2',
      ),
      doc(profile, '[[fleet.job]]\nname = "x"\ninterval_seconds = 9'),
    );
    const names = [...text.matchAll(/name = "(\w)"/g)].map((m) => m[1]);
    expect(names).toEqual(["x", "y"]);
    expect(text).toContain("interval_seconds = 9");
    expect(text).not.toContain("interval_seconds = 1");
    expect(text).not.toContain("interval_seconds = 2");
  });

  describe("fleet job replaces", () => {
    const pack = ref("pack", "ops");
    const job = (): string => ["[[fleet.job]]", 'name = "nightly"'].join("\n");
    const twice = [job(), job()].join("\n");
    const nightly = (merged: ReturnType<typeof mergeLayerDocs>) =>
      merged.sections.filter((s) => s.header === "fleet.job");

    test("a user job replacing a pack job records the pack layer", () => {
      const merged = mergeLayerDocs([doc(pack, job()), doc(base, job())]);
      expect(nightly(merged)[0]?.replaces).toEqual([pack]);
    });

    test("a profile job replacing base and pack records both, low to high", () => {
      const merged = mergeLayerDocs([doc(pack, job()), doc(base, job()), doc(profile, job())]);
      expect(nightly(merged)).toHaveLength(1);
      expect(nightly(merged)[0]?.replaces).toEqual([pack, base]);
    });

    test("two lower copies in one layer are recorded once", () => {
      const merged = mergeLayerDocs([doc(pack, twice), doc(base, job())]);
      expect(nightly(merged)[0]?.replaces).toEqual([pack]);
    });

    test("an unreplaced job has no replaces field", () => {
      const merged = mergeLayerDocs([doc(pack, job())]);
      expect(nightly(merged)[0]?.replaces).toBeUndefined();
    });

    test("a same-layer duplicate replaces nothing", () => {
      const merged = mergeLayerDocs([doc(base, twice)]);
      expect(nightly(merged)).toHaveLength(2);
      expect(nightly(merged)[1]?.replaces).toBeUndefined();
    });
  });
});
