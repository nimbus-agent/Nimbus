import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalRecordDocument } from "@nimbus-dev/registry-format";
import {
  prepareRecord,
  type RecordPlan,
  sameFileName,
  writeRecordedSuite,
} from "./eval-record-cli.ts";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) {
    rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

function pkgDir(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-eval-record-cli-"));
  made.push(d);
  return d;
}

const doc: Extract<EvalRecordDocument, { ok: true }> = {
  ok: true,
  extensionId: "acme/tool",
  version: "1.0.0",
  suite: {
    format: 1,
    name: "golden",
    cases: [
      { name: "a", tool: "echo", input: { text: "a" }, expect: { rubric: "exact", value: "a" } },
    ],
  },
  skipped: [],
};

function planFor(pkg: string, force: boolean): RecordPlan {
  return {
    inputsAbs: join(pkg, "i.json"),
    outRel: "evals/golden.eval.json",
    outAbs: join(pkg, "evals", "golden.eval.json"),
    force,
  };
}

function canSymlink(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "nimbus-symlink-probe-"));
  try {
    symlinkSync(probe, join(probe, "l"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

describe("sameFileName", () => {
  test("is exact on linux and case-insensitive elsewhere", () => {
    expect(sameFileName("A.eval.json", "a.eval.json", "linux")).toBe(false);
    expect(sameFileName("A.eval.json", "a.eval.json", "win32")).toBe(true);
    expect(sameFileName("A.eval.json", "a.eval.json", "darwin")).toBe(true);
    expect(sameFileName("a.eval.json", "b.eval.json", "win32")).toBe(false);
  });
});

describe("writeRecordedSuite re-checks right before writing", () => {
  test("evals/ swapped for a plain file after the pre-check is refused", () => {
    const pkg = pkgDir();
    mkdirSync(join(pkg, "evals"));
    rmSync(join(pkg, "evals"), { recursive: true });
    writeFileSync(join(pkg, "evals"), "swapped");
    expect(() => writeRecordedSuite(pkg, planFor(pkg, false), doc)).toThrow(/plain directory/);
  });

  test("a target that is a directory is refused even with --force", () => {
    const pkg = pkgDir();
    mkdirSync(join(pkg, "evals", "golden.eval.json"), { recursive: true });
    expect(() => writeRecordedSuite(pkg, planFor(pkg, true), doc)).toThrow(/not a regular file/);
  });

  test.skipIf(!canSymlink())("a symlinked target is refused even with --force", () => {
    const pkg = pkgDir();
    mkdirSync(join(pkg, "evals"));
    const real = join(pkg, "real.txt");
    writeFileSync(real, "KEEP");
    symlinkSync(real, join(pkg, "evals", "golden.eval.json"), "file");
    expect(() => writeRecordedSuite(pkg, planFor(pkg, true), doc)).toThrow(/not a regular file/);
  });

  test("creates evals/ and writes when everything is as expected", () => {
    const pkg = pkgDir();
    writeRecordedSuite(pkg, planFor(pkg, false), doc);
    expect(readdirSync(join(pkg, "evals"))).toEqual(["golden.eval.json"]);
    expect(existsSync(join(pkg, "evals", "golden.eval.json"))).toBe(true);
  });
});

describe("prepareRecord", () => {
  const inputsText = JSON.stringify({
    format: 1,
    name: "g",
    cases: [{ name: "a", tool: "echo", input: {} }],
  });

  function prep(pkg: string, inputs: string) {
    return prepareRecord({ pkg, record: inputs, out: undefined, force: false }, () => {});
  }

  test("an inputs path that is not a regular file is refused before any launch", () => {
    const pkg = pkgDir();
    const r = prep(pkg, pkg);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("not a regular file");
  });

  test("an inputs file with a single BOM is accepted", () => {
    const pkg = pkgDir();
    const f = join(pkg, "i.json");
    writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(inputsText)]));
    expect(prep(pkg, f).ok).toBe(true);
  });

  test("a stale temp file of this target is swept; other files stay", () => {
    const pkg = pkgDir();
    mkdirSync(join(pkg, "evals"));
    const stale = join(pkg, "evals", ".golden.eval.json.0123456789ab.tmp");
    const other = join(pkg, "evals", ".other.eval.json.0123456789ab.tmp");
    writeFileSync(stale, "partial");
    writeFileSync(other, "keep");
    const f = join(pkg, "i.json");
    writeFileSync(f, inputsText);
    expect(prep(pkg, f).ok).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });
});
