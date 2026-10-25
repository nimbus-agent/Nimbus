import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgetLayeredConfigForTests } from "../config/layered-config.ts";
import {
  type LayerKind,
  type LayerRef,
  mergeLayerDocs,
  parseLayerDoc,
} from "../config/layered-merge.ts";
import { sourceTypesFor } from "./source-kinds.ts";
import {
  BUILTIN_SOURCE_MAPPING,
  describeSourceMapping,
  parseSourceMapEntry,
  parseSourceMapList,
  parseSourceTypeList,
  resolveSourceMapping,
  sourceFilterSql,
  sourceMapFromList,
  sourceMappingFor,
} from "./source-mapping.ts";

function ref(kind: LayerKind, id: string): LayerRef {
  return { kind, id, path: `/virtual/${kind}-${id}.toml` };
}

const src = (kind: LayerKind, id: string, body: string) =>
  parseLayerDoc(ref(kind, id), `[sources]\n${body}\n`);
const pack = (id: string, body: string) => src("pack", id, body);
const base = (body: string) => src("base", "base", body);
const profile = (body: string) => src("profile", "work", body);

function resolve(...docs: ReturnType<typeof parseLayerDoc>[]) {
  return resolveSourceMapping({ doc: mergeLayerDocs(docs) });
}

describe("resolveSourceMapping", () => {
  test("with no [sources] the mapping equals the built-in table", () => {
    const m = resolve(parseLayerDoc(ref("base", "base"), "[agents]\nhide = []\n"));
    expect(m).toBe(BUILTIN_SOURCE_MAPPING);
    expect([...m.typesFor("decisions")]).toEqual([...sourceTypesFor("decisions")]);
    expect([...m.typesFor("glossary")]).toEqual([...sourceTypesFor("glossary")]);
    expect(m.kindOf("jira:issue")).toBe("ticket");
    expect(m.notes).toEqual([]);
  });

  test("an unknown key in a [sources] section is a note naming the layer and key", () => {
    const m = resolve(base('excludes = ["slack:message"]'));
    expect(m.kindOf("slack:message")).toBe("message");
    expect(m.notes.some((n) => n.includes("excludes") && n.includes("base"))).toBe(true);
    const p = resolve(pack("research", 'maps = ["readwise:highlight=note"]'));
    expect(p.notes.some((n) => n.includes("maps") && n.includes("research"))).toBe(true);
  });

  test("a pack adds a type", () => {
    const m = resolve(pack("research", 'map = ["readwise:highlight=note"]'));
    expect(m.kindOf("readwise:highlight")).toBe("note");
    expect(m.typesFor("decisions").at(-1)).toBe("readwise:highlight");
    expect(m.typesOfKind("note")).toEqual(["readwise:highlight"]);
    expect(m.entries.at(-1)?.origin).toEqual({ kind: "layer", layer: ref("pack", "research") });
    expect(Object.isFrozen(m.typesFor("decisions"))).toBe(true);
  });

  test("two packs with the same entry union", () => {
    const m = resolve(
      pack("a", 'map = ["readwise:highlight=note"]'),
      pack("b", 'map = ["readwise:highlight=note"]'),
    );
    expect(m.entries.filter((e) => e.serviceType === "readwise:highlight")).toHaveLength(1);
    expect(m.notes).toEqual([]);
  });

  test("two packs with different kinds keep the first and note", () => {
    const m = resolve(
      pack("a", 'map = ["readwise:highlight=note"]'),
      pack("b", 'map = ["readwise:highlight=doc"]'),
    );
    expect(m.kindOf("readwise:highlight")).toBe("note");
    expect(m.notes).toHaveLength(1);
  });

  test("a pack entry naming a built-in type is ignored with a note", () => {
    const m = resolve(pack("x", 'map = ["jira:issue=doc"]'));
    expect(m.kindOf("jira:issue")).toBe("ticket");
    expect(m.notes).toHaveLength(1);
    expect(m.notes[0]).toContain("pack:x");
  });

  test("a pack entry naming a personal type is ignored with a note", () => {
    const m = resolve(pack("x", 'map = ["gmail:email=message"]'));
    expect(m.kindOf("gmail:email")).toBeUndefined();
    expect(m.notes).toHaveLength(1);
  });

  test("a pack exclude is ignored with a note", () => {
    const m = resolve(pack("x", 'exclude = ["slack:message"]'));
    expect(m.kindOf("slack:message")).toBe("message");
    expect(m.excluded).toEqual([]);
    expect(m.notes).toHaveLength(1);
  });

  test("a malformed pack map is a note", () => {
    const m = resolve(pack("x", 'map = "readwise:highlight=note"'));
    expect(m.entries).toHaveLength(BUILTIN_SOURCE_MAPPING.entries.length);
    expect(m.notes).toHaveLength(1);
  });

  test("the owner re-kinds a built-in", () => {
    const m = resolve(base('map = ["jira:issue=doc"]'));
    expect(m.kindOf("jira:issue")).toBe("doc");
    expect(m.typesOfKind("doc")).toContain("jira:issue");
    expect(m.typesOfKind("ticket")).not.toContain("jira:issue");
    expect(m.entries.find((e) => e.serviceType === "jira:issue")?.origin).toEqual({
      kind: "layer",
      layer: ref("base", "base"),
    });
  });

  test("the owner may map a personal type", () => {
    const m = resolve(base('map = ["gmail:email=message"]'));
    expect(m.kindOf("gmail:email")).toBe("message");
  });

  test("owner exclude removes built-in and pack types", () => {
    const m = resolve(
      pack("r", 'map = ["readwise:highlight=note"]'),
      base('exclude = ["slack:message","readwise:highlight"]'),
    );
    expect(m.typesFor("decisions")).not.toContain("slack:message");
    expect(m.typesFor("decisions")).not.toContain("readwise:highlight");
    expect(m.excluded.map((e) => e.serviceType)).toEqual(["slack:message", "readwise:highlight"]);
    expect(m.excluded[0]?.layer).toEqual(ref("base", "base"));
  });

  test("profile beats base", () => {
    const m = resolve(
      base('exclude = ["slack:message"]'),
      profile('map = ["slack:message=message"]'),
    );
    expect([...m.typesFor("decisions")]).toEqual([...sourceTypesFor("decisions")]);
    expect(m.excluded).toEqual([]);
  });

  test("a profile exclude beats a base map", () => {
    const m = resolve(base('map = ["jira:issue=doc"]'), profile('exclude = ["jira:issue"]'));
    expect(m.kindOf("jira:issue")).toBeUndefined();
  });

  test("in one layer exclude beats map", () => {
    const m = resolve(base('map = ["jira:issue=doc"]\nexclude = ["jira:issue"]'));
    expect(m.kindOf("jira:issue")).toBeUndefined();
    expect(m.excluded.map((e) => e.serviceType)).toEqual(["jira:issue"]);
  });

  test("nimbus:* never resolves, from any layer", () => {
    const m = resolve(
      pack("p", 'map = ["nimbus:capture=note"]'),
      base('map = ["nimbus:glossary_term=doc"]'),
    );
    expect(m.kindOf("nimbus:capture")).toBeUndefined();
    expect(m.kindOf("nimbus:glossary_term")).toBeUndefined();
    for (const pass of ["decisions", "glossary"] as const) {
      expect(m.typesFor(pass).some((t) => t.startsWith("nimbus:"))).toBe(false);
    }
    expect(m.notes).toHaveLength(2);
  });

  test("owner layer bad values are notes, not applied", () => {
    const m = resolve(
      base('map = "jira:issue=doc"'),
      profile('map = ["jira:issue=wiki"]\nexclude = [1]'),
    );
    expect([...m.typesFor("decisions")]).toEqual([...sourceTypesFor("decisions")]);
    expect(m.kindOf("jira:issue")).toBe("ticket");
    expect(m.excluded).toEqual([]);
    expect(m.notes).toHaveLength(3);
  });
});

describe("sourceMappingFor", () => {
  test("undefined config dir is the built-in mapping", () => {
    expect(sourceMappingFor(undefined)).toBe(BUILTIN_SOURCE_MAPPING);
  });
});

describe("sourceFilterSql", () => {
  test("an empty list is false, not IN ()", () => {
    expect(sourceFilterSql([], "i")).toEqual({ sql: "0", params: [] });
  });
  test("two types", () => {
    expect(sourceFilterSql(["a:b", "c:d"], "i")).toEqual({
      sql: "(i.service || ':' || i.type) IN (?, ?)",
      params: ["a:b", "c:d"],
    });
  });
});

describe("entry grammar", () => {
  test("accepts", () => {
    expect(parseSourceMapEntry("readwise:highlight=note")).toEqual({
      serviceType: "readwise:highlight",
      kind: "note",
    });
    expect(parseSourceMapEntry("ext_foo:item=doc")?.kind).toBe("doc");
  });
  test.each([
    "Readwise:x=note",
    "a:b=wiki",
    "a:b",
    "a=note",
    "nimbus:capture=note",
    "a:b=note=x",
    "",
  ])("rejects %p", (raw) => {
    expect(parseSourceMapEntry(raw)).toBeUndefined();
  });

  test("list parsers are strict", () => {
    expect(parseSourceMapList('["a:b=note", "c:d=doc"]')).toEqual(["a:b=note", "c:d=doc"]);
    for (const bad of ["a:b=note", "[]", '["a:b=note",]', "[a:b=note]", '["a:b=wiki"]']) {
      expect(parseSourceMapList(bad)).toBeUndefined();
    }
    expect(parseSourceMapList(`[${Array(65).fill('"a:b=note"').join(",")}]`)).toBeUndefined();
    expect(parseSourceTypeList('["a:b"]')).toEqual(["a:b"]);
    expect(parseSourceTypeList('["nimbus:capture"]')).toBeUndefined();
    expect(parseSourceTypeList('["a:b=note"]')).toBeUndefined();
  });

  test("sourceMapFromList", () => {
    expect(sourceMapFromList(undefined).size).toBe(0);
    expect([...sourceMapFromList(["a:b=note", "c:d=doc"])]).toEqual([
      ["a:b", "note"],
      ["c:d", "doc"],
    ]);
  });
});

describe("sourceMappingFor a real config dir", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) {
      forgetLayeredConfigForTests(dir);
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  test("reads the owner's nimbus.toml live", () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-source-mapping-"));
    writeFileSync(join(dir, "nimbus.toml"), '[sources]\nexclude = ["slack:message"]\n');
    const m = sourceMappingFor(dir);
    expect(m.typesFor("decisions")).not.toContain("slack:message");
    expect(m.excluded.map((e) => e.serviceType)).toEqual(["slack:message"]);
  });
});

describe("describeSourceMapping", () => {
  test("lists entries with origins, exclusions once per layer, then notes", () => {
    const m = resolve(
      pack("research", 'map = ["readwise:highlight=note"]'),
      base('exclude = ["slack:message", "slack:message"]\nmap = ["jira:issue=bogus"]'),
      profile('exclude = ["slack:message"]'),
    );
    const lines = describeSourceMapping(m);
    expect(lines).toContain("source readwise:highlight is mined as note (pack research)");
    expect(lines).toContain("source jira:issue is mined as ticket (built-in)");
    expect(lines).toContain("source slack:message is excluded by base");
    expect(lines).toContain("source slack:message is excluded by profile");
    expect(lines.filter((l) => l === "source slack:message is excluded by base")).toHaveLength(1);
    expect(lines.at(-1)).toBe(m.notes.at(-1));
    expect(m.notes.length).toBeGreaterThan(0);
  });

  test("an owner entry shows its layer", () => {
    const lines = describeSourceMapping(resolve(base('map = ["jira:issue=doc"]')));
    expect(lines).toContain("source jira:issue is mined as doc (base)");
  });
});

describe("owner layers overriding a pack-added type", () => {
  const pk = () => pack("devops", 'map = ["readwise:highlight=note"]');

  test("a re-kind names the pack, its kind and the owner layer", () => {
    const m = resolve(pk(), base('map = ["readwise:highlight=doc"]'));
    const note = "pack devops maps readwise:highlight as note; overridden by base (doc)";
    expect(m.notes).toContain(note);
    expect(describeSourceMapping(m)).toContain(note);
  });

  test("an exclude names the pack and the owner layer", () => {
    const m = resolve(pk(), profile('exclude = ["readwise:highlight"]'));
    const note = "pack devops maps readwise:highlight as note; excluded by profile";
    expect(m.notes).toContain(note);
    expect(describeSourceMapping(m)).toContain(note);
  });

  test("a built-in re-kind and an owner-only type add no such note", () => {
    const m = resolve(base('map = ["jira:issue=doc", "a:b=note"]'));
    expect(m.notes.filter((n) => n.includes("overridden by"))).toEqual([]);
  });
});
