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
import {
  type EvalRecordDocument,
  MAX_EVAL_CASES,
  MAX_EVAL_SUITES,
} from "@nimbus-dev/registry-format";
import {
  prepareRecord,
  RECORD_NOTE,
  type RecordPlan,
  renderRecorded,
  sameFileName,
  skipLines,
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

describe("prepareRecord refusals before any launch", () => {
  const inputsText = JSON.stringify({
    format: 1,
    name: "g",
    cases: [{ name: "a", tool: "echo", input: {} }],
  });

  function prepWith(
    pkg: string,
    over: { out?: string; force?: boolean; inputs?: string } = {},
    warn: (s: string) => void = () => {},
  ) {
    const inputs = join(pkg, "i.json");
    writeFileSync(inputs, over.inputs ?? inputsText);
    return prepareRecord({ pkg, record: inputs, out: over.out, force: over.force ?? false }, warn);
  }

  function message(r: ReturnType<typeof prepareRecord>): string {
    return r.ok ? "" : r.message;
  }

  test("an inputs file that is not valid inputs says why", () => {
    const pkg = pkgDir();
    const r = prepWith(pkg, { inputs: "{nope" });
    expect(r.ok).toBe(false);
    expect(message(r).length).toBeGreaterThan(0);
  });

  test.each([
    ["an absolute --out", join(tmpdir(), "a.eval.json"), "relative to the package"],
    ["a --out that leaves the package", "../a.eval.json", "stay inside the package"],
    ["a --out that is not an eval suite file", "evals/notes.txt", "named <name>.eval.json"],
    ["a --out with a colon", "evals/a:b.eval.json", "':' or control characters"],
    ["a --out naming a Windows device", "evals/con.eval.json", "reserved device"],
  ])("refuses %s", (_n, out, fragment) => {
    const pkg = pkgDir();
    const r = prepWith(pkg, { out });
    expect(r.ok).toBe(false);
    expect(message(r)).toContain(fragment);
  });

  test("an existing target needs --force, and --force allows a regular file", () => {
    const pkg = pkgDir();
    mkdirSync(join(pkg, "evals"));
    writeFileSync(join(pkg, "evals", "golden.eval.json"), "old");
    expect(message(prepWith(pkg))).toContain("without --force");
    expect(prepWith(pkg, { force: true }).ok).toBe(true);
  });

  test("an evals that is a plain file is refused", () => {
    const pkg = pkgDir();
    writeFileSync(join(pkg, "evals"), "file");
    expect(message(prepWith(pkg))).toContain("not a plain directory");
  });

  test("a broken sibling suite is warned about and not counted", () => {
    const pkg = pkgDir();
    mkdirSync(join(pkg, "evals"));
    writeFileSync(join(pkg, "evals", "broken.eval.json"), "{nope");
    const warnings: string[] = [];
    const r = prepWith(pkg, {}, (s) => warnings.push(s));
    expect(r.ok).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("evals/broken.eval.json is not counted");
  });

  test("too many existing suites, or too many cases in them, is refused", () => {
    const suite = (name: string, n: number) =>
      JSON.stringify({
        format: 1,
        name,
        cases: Array.from({ length: n }, (_, i) => ({
          name: `c${String(i)}`,
          tool: "echo",
          input: {},
          expect: { rubric: "exact", value: "x" },
        })),
      });
    const many = pkgDir();
    mkdirSync(join(many, "evals"));
    for (let i = 0; i < MAX_EVAL_SUITES; i++) {
      writeFileSync(join(many, "evals", `s${String(i)}.eval.json`), suite(`s${String(i)}`, 1));
    }
    expect(message(prepWith(many))).toContain(`at most ${String(MAX_EVAL_SUITES)} are scored`);

    const big = pkgDir();
    mkdirSync(join(big, "evals"));
    writeFileSync(join(big, "evals", "big.eval.json"), suite("big", MAX_EVAL_CASES));
    expect(message(prepWith(big))).toContain("case cap");
  });
});

describe("renderRecorded and skipLines", () => {
  test("report the counts, each skip's reason with control characters stripped, and the note", () => {
    const lines = renderRecorded("evals/golden.eval.json", {
      ...doc,
      skipped: [
        { case: "bad\u001b[31mname", why: "call-failed" },
        { case: "other", why: "reply-too-large" },
      ],
    });
    expect(lines[0]).toBe("wrote evals/golden.eval.json: 1 cases recorded, 2 skipped");
    expect(lines[1]).toContain(": the tool call failed");
    expect(lines[1]).not.toContain("\u001b");
    expect(lines[2]).toBe("  other: its reply was too large to record");
    expect(lines.at(-1)).toBe(RECORD_NOTE);
    expect(skipLines([])).toEqual([]);
  });
});
