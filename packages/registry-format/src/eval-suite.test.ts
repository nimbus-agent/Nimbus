import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_ENTRY_COUNT,
  MAX_EVAL_JSON_DEPTH,
  MAX_EVAL_SUITE_FILE_BYTES,
  MAX_MANIFEST_BYTES,
} from "./caps.ts";
import { RegistryError } from "./errors.ts";
import {
  EVAL_RUBRIC_KINDS,
  evalSuitesFromFiles,
  isEvalSuiteFile,
  jsonDepth,
  loadEvalSuites,
  parseEvalSuite,
  parseEvalSuites,
  readEvalPackageFiles,
} from "./eval-suite.ts";
import { listPackageFiles } from "./package-set.ts";

const CAN_SYMLINK = ((): boolean => {
  const probe = mkdtempSync(join(tmpdir(), "nimbus-symprobe-"));
  try {
    writeFileSync(join(probe, "a"), "a");
    symlinkSync(join(probe, "a"), join(probe, "b"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

const enc = new TextEncoder();
const bytesOf = (v: unknown): Uint8Array => enc.encode(JSON.stringify(v));

function suiteWith(caseOver: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    format: 1,
    name: "s",
    cases: [
      { name: "c1", tool: "t", input: {}, expect: { rubric: "exact", value: "ok" }, ...caseOver },
    ],
    ...top,
  };
}

function expectRefused(fn: () => unknown, fragment: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RegistryError);
  const err = caught as RegistryError;
  expect(err.code).toBe("ERR_REGISTRY_EVAL_SUITE_INVALID");
  expect(err.message).toContain(fragment);
}

const parse = (v: unknown) => parseEvalSuite("evals/a.eval.json", bytesOf(v));

function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = { a: v };
  return v;
}

function pathOf(s: { cases: readonly { expect: object }[] }): unknown {
  const e = s.cases[0]?.expect;
  return e === undefined ? undefined : Reflect.get(e, "path");
}

function jm(value: unknown): Record<string, unknown> {
  return { expect: { rubric: "json-match", value } };
}

describe("parseEvalSuite", () => {
  test("rubric kinds are fixed and ordered", () => {
    expect([...EVAL_RUBRIC_KINDS]).toEqual(["exact", "json-match", "one-of"]);
  });

  test("parses a minimal suite", () => {
    expect(parse(suiteWith())).toEqual({
      file: "evals/a.eval.json",
      name: "s",
      cases: [
        {
          name: "c1",
          tool: "t",
          input: {},
          expect: { rubric: "exact", value: "ok", error: false },
        },
      ],
    });
  });

  test("error defaults to false and can be true", () => {
    const s = parse(suiteWith({ expect: { rubric: "exact", value: "x", error: true } }));
    expect(s.cases[0]?.expect.error).toBe(true);
  });

  test("one-of path defaults to null; explicit paths kept", () => {
    const a = parse(suiteWith({ expect: { rubric: "one-of", values: [1, "a"] } }));
    expect(a.cases[0]?.expect).toEqual({
      rubric: "one-of",
      values: [1, "a"],
      path: null,
      error: false,
    });
    const b = parse(suiteWith({ expect: { rubric: "one-of", values: [1], path: "/a/b" } }));
    expect(pathOf(b)).toBe("/a/b");
    const c = parse(suiteWith({ expect: { rubric: "one-of", values: [1], path: "" } }));
    expect(pathOf(c)).toBe("");
  });

  test("json-match accepts any JSON value and valid $type markers", () => {
    const s = parse(suiteWith(jm({ a: { $type: "string" }, b: [{ $type: "null" }] })));
    expect(s.cases[0]?.expect.rubric).toBe("json-match");
    for (const t of ["string", "number", "boolean", "null", "array", "object"]) {
      parse(suiteWith(jm({ $type: t })));
    }
    parse(suiteWith(jm(null)));
  });

  test("refuses a BOM", () => {
    const body = enc.encode(JSON.stringify(suiteWith()));
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body]);
    expectRefused(() => parseEvalSuite("evals/a.eval.json", withBom), "BOM");
  });

  test("refuses invalid UTF-8 and invalid JSON", () => {
    expectRefused(() => parseEvalSuite("evals/a.eval.json", new Uint8Array([0xff])), "UTF-8");
    expectRefused(() => parseEvalSuite("evals/a.eval.json", enc.encode("{nope")), "JSON");
  });

  test("refuses a file over 1 MiB", () => {
    expectRefused(
      () => parseEvalSuite("evals/a.eval.json", new Uint8Array(1024 * 1024 + 1)),
      "too large",
    );
  });

  test("refuses bad top levels", () => {
    expectRefused(() => parse([]), "object");
    expectRefused(() => parse(null), "object");
    expectRefused(() => parse(suiteWith({}, { format: 2 })), "format");
    expectRefused(() => parse(suiteWith({}, { extra: 1 })), "extra");
    expectRefused(() => parse(suiteWith({}, { name: "" })), "name");
    expectRefused(() => parse(suiteWith({}, { name: 5 })), "name");
    expectRefused(() => parse(suiteWith({}, { name: "x".repeat(121) })), "name");
    expectRefused(() => parse(suiteWith({}, { cases: [] })), "cases");
    expectRefused(() => parse(suiteWith({}, { cases: "no" })), "cases");
    expectRefused(() => parse({ format: 1, name: "s" }), "cases");
  });

  test("refuses bad cases", () => {
    expectRefused(() => parse(suiteWith({}, { cases: [5] })), "case");
    const dup = { name: "d", tool: "t", input: {}, expect: { rubric: "exact", value: "a" } };
    expectRefused(() => parse(suiteWith({}, { cases: [dup, dup] })), "duplicate");
    expectRefused(() => parse(suiteWith({ weight: 2 })), "weight");
    expectRefused(() => parse(suiteWith({ name: "" })), "name");
    expectRefused(() => parse(suiteWith({ tool: "" })), "tool");
    expectRefused(() => parse(suiteWith({ tool: "t".repeat(129) })), "tool");
    expectRefused(() => parse(suiteWith({ input: [] })), "input");
    expectRefused(() => parse(suiteWith({ input: null })), "input");
    expectRefused(() => parse(suiteWith({ expect: undefined })), "expect");
    expectRefused(() => parse(suiteWith({ expect: null })), "expect");
    expectRefused(() => parse(suiteWith({ expect: "exact" })), "expect");
  });

  test("input size cap", () => {
    const ok = { a: "x".repeat(64 * 1024 - 8) };
    expect(enc.encode(JSON.stringify(ok)).length).toBe(64 * 1024);
    parse(suiteWith({ input: ok }));
    const big = { a: "x".repeat(64 * 1024 - 7) };
    expect(enc.encode(JSON.stringify(big)).length).toBe(65_537);
    expectRefused(() => parse(suiteWith({ input: big })), "input");
  });

  test("input size counts UTF-8 bytes, not characters", () => {
    const multi = { a: "é".repeat(33_000) };
    expectRefused(() => parse(suiteWith({ input: multi })), "input");
  });

  test("depth boundaries", () => {
    expect(jsonDepth(1)).toBe(0);
    expect(jsonDepth(null)).toBe(0);
    expect(jsonDepth({})).toBe(1);
    expect(jsonDepth([])).toBe(1);
    expect(jsonDepth([[1]])).toBe(2);
    expect(jsonDepth({ a: { b: 1 } })).toBe(2);
    expect(jsonDepth(nested(64))).toBe(64);
    parse(suiteWith({ input: nested(MAX_EVAL_JSON_DEPTH) }));
    expectRefused(() => parse(suiteWith({ input: nested(MAX_EVAL_JSON_DEPTH + 1) })), "depth");
    expectRefused(() => parse(suiteWith(jm(nested(MAX_EVAL_JSON_DEPTH + 1)))), "depth");
    expectRefused(
      () =>
        parse(
          suiteWith({
            expect: { rubric: "one-of", values: [nested(MAX_EVAL_JSON_DEPTH + 1)] },
          }),
        ),
      "depth",
    );
  });

  test("refuses bad expects", () => {
    const ex = (e: unknown) => suiteWith({ expect: e });
    expectRefused(() => parse(ex(5)), "expect");
    expectRefused(() => parse(ex({ rubric: "fuzzy", value: "a" })), "rubric");
    expectRefused(() => parse(ex({ rubric: "exact", value: 1 })), "value");
    expectRefused(() => parse(ex({ rubric: "exact" })), "value");
    expectRefused(() => parse(ex({ rubric: "exact", value: "a", error: "y" })), "error");
    expectRefused(() => parse(ex({ rubric: "exact", value: "a", values: [] })), "values");
    expectRefused(() => parse(ex({ rubric: "json-match" })), "value");
    expectRefused(() => parse(ex({ rubric: "json-match", value: 1, path: "/a" })), "path");
    expectRefused(() => parse(ex({ rubric: "one-of", values: [] })), "values");
    expectRefused(() => parse(ex({ rubric: "one-of", values: "a" })), "values");
    expectRefused(() => parse(ex({ rubric: "one-of", values: [1], path: "a" })), "path");
    expectRefused(() => parse(ex({ rubric: "one-of", values: [1], path: 3 })), "path");
    expectRefused(() => parse(ex({ rubric: "one-of", values: [1], value: 1 })), "value");
  });

  test("refuses invalid $type markers", () => {
    expectRefused(() => parse(suiteWith(jm({ $type: "str" }))), "$type");
    expectRefused(() => parse(suiteWith(jm({ $type: "string", x: 1 }))), "$type");
    expectRefused(() => parse(suiteWith(jm({ $type: 5 }))), "$type");
    expectRefused(() => parse(suiteWith(jm([{ k: { $type: "x" } }]))), "$type");
  });
});

describe("parseEvalSuite case cap", () => {
  test("refuses a single suite with 201 cases", () => {
    const cases = Array.from({ length: 201 }, (_, i) => ({
      name: `c${i}`,
      tool: "t",
      input: {},
      expect: { rubric: "exact", value: "ok" },
    }));
    expectRefused(() => parse({ format: 1, name: "s", cases }), "cases");
  });
});

describe("parseEvalSuites", () => {
  const file = (name: string, cases = 1) => ({
    file: `evals/${name}.eval.json`,
    bytes: bytesOf({
      format: 1,
      name,
      cases: Array.from({ length: cases }, (_, i) => ({
        name: `c${i}`,
        tool: "t",
        input: {},
        expect: { rubric: "exact", value: "ok" },
      })),
    }),
  });

  test("sorts by file name", () => {
    const out = parseEvalSuites([file("b"), file("a")]);
    expect(out.map((s) => s.name)).toEqual(["a", "b"]);
  });

  test("refuses 21 files", () => {
    const files = Array.from({ length: 21 }, (_, i) => file(`s${String(i).padStart(2, "0")}`));
    expectRefused(() => parseEvalSuites(files), "suite files");
    expect(parseEvalSuites(files.slice(0, 20))).toHaveLength(20);
  });

  test("refuses duplicate file entries", () => {
    expectRefused(() => parseEvalSuites([file("a"), file("a")]), "duplicate");
  });

  test("refuses 201 cases across files", () => {
    expectRefused(() => parseEvalSuites([file("a", 100), file("b", 101)]), "cases");
    expect(parseEvalSuites([file("a", 100), file("b", 100)])).toHaveLength(2);
  });
});

describe("isEvalSuiteFile", () => {
  test("matches only direct children of evals/", () => {
    expect(isEvalSuiteFile("evals/x.eval.json")).toBe(true);
    expect(isEvalSuiteFile("evals/sub/x.eval.json")).toBe(false);
    expect(isEvalSuiteFile("evals/x.json")).toBe(false);
    expect(isEvalSuiteFile("x.eval.json")).toBe(false);
  });
});

describe("loadEvalSuites", () => {
  const goodText = JSON.stringify(suiteWith());

  test("no evals/ dir gives []", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      expect(loadEvalSuites(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads only direct *.eval.json children", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      mkdirSync(join(root, "evals", "sub"), { recursive: true });
      writeFileSync(join(root, "evals", "a.eval.json"), goodText);
      writeFileSync(join(root, "evals", "fixture.txt"), "not json");
      writeFileSync(join(root, "evals", "sub", "b.eval.json"), "{bad");
      const out = loadEvalSuites(root);
      expect(out.map((s) => s.file)).toEqual(["evals/a.eval.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a directory named like a suite is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      mkdirSync(join(root, "evals", "d.eval.json"), { recursive: true });
      expectRefused(() => loadEvalSuites(root), "evals/d.eval.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!CAN_SYMLINK)("a symlinked suite file is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      mkdirSync(join(root, "evals"));
      writeFileSync(join(root, "target.json"), goodText);
      symlinkSync(join(root, "target.json"), join(root, "evals", "a.eval.json"));
      expectRefused(() => loadEvalSuites(root), "symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an oversized suite file is refused without being read", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      mkdirSync(join(root, "evals"));
      writeFileSync(
        join(root, "evals", "big.eval.json"),
        Buffer.alloc(MAX_EVAL_SUITE_FILE_BYTES + 1, 0x20),
      );
      expectRefused(() => loadEvalSuites(root), "too large");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a wrong-case suite name is refused, not skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      mkdirSync(join(root, "evals"));
      writeFileSync(join(root, "evals", "x.Eval.json"), goodText);
      expectRefused(() => loadEvalSuites(root), "evals/x.Eval.json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("evals that is a regular file is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      writeFileSync(join(root, "evals"), "x");
      expectRefused(() => loadEvalSuites(root), "directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!CAN_SYMLINK)("a symlinked evals directory is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      mkdirSync(join(root, "real"));
      symlinkSync(join(root, "real"), join(root, "evals"), "junction");
      expectRefused(() => loadEvalSuites(root), "symlink");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function expectCode(fn: () => unknown, code: string, fragment: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(RegistryError);
  expect((caught as RegistryError).code).toBe(code);
  expect((caught as RegistryError).message).toContain(fragment);
}

describe("readEvalPackageFiles", () => {
  let root: string;
  const put = (rel: string, body: string | Uint8Array): void => {
    const p = join(root, ...rel.split("/"));
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  };
  const withRoot = (fn: () => void): void => {
    root = mkdtempSync(join(tmpdir(), "nimbus-pkgfiles-"));
    try {
      fn();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("returns the exact bytes of exactly the listed files", () => {
    withRoot(() => {
      const bin = new Uint8Array([0, 255, 0xef, 0xbb, 0xbf, 10, 13]);
      put("dist/index.js", bin);
      put("evals/a.eval.json", JSON.stringify(suiteWith()));
      put("nimbus.extension.json", "{}");
      put("README.md", "unlisted");
      const out = readEvalPackageFiles(root, [
        "dist/index.js",
        "evals/a.eval.json",
        "nimbus.extension.json",
      ]);
      expect([...out.keys()]).toEqual([
        "dist/index.js",
        "evals/a.eval.json",
        "nimbus.extension.json",
      ]);
      expect(new Uint8Array(out.get("dist/index.js") ?? [])).toEqual(bin);
      expect(new TextDecoder().decode(out.get("evals/a.eval.json"))).toBe(
        JSON.stringify(suiteWith()),
      );
    });
  });

  test("an empty list reads nothing", () => {
    withRoot(() => {
      expect(readEvalPackageFiles(root, []).size).toBe(0);
    });
  });

  test("a directory is refused as a non-regular file", () => {
    withRoot(() => {
      put("dist/index.js", "x");
      expectCode(
        () => readEvalPackageFiles(root, ["dist"]),
        "ERR_REGISTRY_PACKAGE_FILE_SET",
        "regular file",
      );
      mkdirSync(join(root, "evals", "d.eval.json"), { recursive: true });
      expectRefused(() => readEvalPackageFiles(root, ["evals/d.eval.json"]), "regular file");
    });
  });

  test.skipIf(!CAN_SYMLINK)("a symlink is refused, never followed", () => {
    withRoot(() => {
      put("target.js", "x");
      put("evals/real.json", JSON.stringify(suiteWith()));
      mkdirSync(join(root, "dist"));
      symlinkSync(join(root, "target.js"), join(root, "dist", "index.js"));
      symlinkSync(join(root, "evals", "real.json"), join(root, "evals", "a.eval.json"));
      expectCode(
        () => readEvalPackageFiles(root, ["dist/index.js"]),
        "ERR_REGISTRY_PACKAGE_FILE_SET",
        "symlink",
      );
      expectRefused(() => readEvalPackageFiles(root, ["evals/a.eval.json"]), "symlink");
    });
  });

  test("an oversized suite or manifest is refused before it is read", () => {
    withRoot(() => {
      put("evals/big.eval.json", Buffer.alloc(MAX_EVAL_SUITE_FILE_BYTES + 1, 0x20));
      put("nimbus.extension.json", Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20));
      expectRefused(() => readEvalPackageFiles(root, ["evals/big.eval.json"]), "too large");
      expectCode(
        () => readEvalPackageFiles(root, ["nimbus.extension.json"]),
        "ERR_REGISTRY_PACKAGE_FILE_SET",
        "too large",
      );
    });
  });

  test("an unsafe, duplicate or excessive file list is refused before any read", () => {
    withRoot(() => {
      put("a.js", "x");
      for (const rel of ["../a.js", "/a.js", "dist//a.js", "dist\\a.js", "./a.js", ""]) {
        expectCode(
          () => readEvalPackageFiles(root, [rel]),
          "ERR_REGISTRY_PACKAGE_FILE_SET",
          "package-relative",
        );
      }
      expectCode(
        () => readEvalPackageFiles(root, ["a.js", "a.js"]),
        "ERR_REGISTRY_PACKAGE_FILE_SET",
        "duplicate",
      );
      const many = Array.from({ length: MAX_ENTRY_COUNT + 1 }, (_, i) => `f${String(i)}`);
      expectCode(
        () => readEvalPackageFiles(root, many),
        "ERR_REGISTRY_PACKAGE_FILE_SET",
        String(MAX_ENTRY_COUNT),
      );
    });
  });

  test("a missing file throws", () => {
    withRoot(() => {
      expect(() => readEvalPackageFiles(root, ["dist/nope.js"])).toThrow();
    });
  });
});

describe("evalSuitesFromFiles", () => {
  const good = bytesOf(suiteWith());
  const named = (name: string): Uint8Array => bytesOf(suiteWith({}, { name }));

  test("parses only direct evals/*.eval.json entries, sorted", () => {
    const files = new Map<string, Uint8Array>([
      ["evals/b.eval.json", named("b")],
      ["evals/a.eval.json", named("a")],
      ["evals/fixture.txt", enc.encode("not json")],
      ["evals/sub/c.eval.json", enc.encode("{bad")],
      ["dist/x.eval.json", enc.encode("{bad")],
      ["nimbus.extension.json", enc.encode("{}")],
    ]);
    expect(evalSuitesFromFiles(files).map((s) => s.file)).toEqual([
      "evals/a.eval.json",
      "evals/b.eval.json",
    ]);
  });

  test("no suite entries give []", () => {
    expect(evalSuitesFromFiles(new Map())).toEqual([]);
    expect(evalSuitesFromFiles(new Map([["dist/index.js", good]]))).toEqual([]);
  });

  test("a wrong-case suite name is refused, not skipped", () => {
    expectRefused(
      () => evalSuitesFromFiles(new Map([["evals/x.Eval.json", good]])),
      "evals/x.Eval.json",
    );
  });

  test("a directory named like a suite is refused", () => {
    expectRefused(
      () => evalSuitesFromFiles(new Map([["evals/d.eval.json/inner", good]])),
      "evals/d.eval.json",
    );
  });

  test("a malformed or oversized suite is refused like loadEvalSuites", () => {
    expectRefused(
      () => evalSuitesFromFiles(new Map([["evals/a.eval.json", enc.encode("{bad")]])),
      "not valid JSON",
    );
    expectRefused(
      () =>
        evalSuitesFromFiles(
          new Map([["evals/a.eval.json", new Uint8Array(MAX_EVAL_SUITE_FILE_BYTES + 1)]]),
        ),
      "too large",
    );
  });

  test("agrees with loadEvalSuites on a real package directory", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evals-"));
    try {
      mkdirSync(join(root, "evals", "sub"), { recursive: true });
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "nimbus.extension.json"), "{}");
      writeFileSync(join(root, "dist", "index.js"), "x");
      writeFileSync(join(root, "evals", "b.eval.json"), named("b"));
      writeFileSync(join(root, "evals", "a.eval.json"), named("a"));
      writeFileSync(join(root, "evals", "fixture.txt"), "x");
      writeFileSync(join(root, "evals", "sub", "c.txt"), "x");
      const fromBytes = evalSuitesFromFiles(readEvalPackageFiles(root, listPackageFiles(root)));
      expect(fromBytes).toEqual(loadEvalSuites(root));
      expect(fromBytes).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
