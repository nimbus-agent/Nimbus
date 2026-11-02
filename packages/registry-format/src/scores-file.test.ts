import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeScoreEntry, MAX_SCORES_BYTES, readScores, type Scores } from "./scores-file.ts";

const SHA = "a".repeat(64);
const QUALITY = {
  scorer: 1,
  score: 50,
  cases: 2,
  passed: 1,
  rubrics: {
    exact: { cases: 2, passed: 1 },
    "json-match": { cases: 0, passed: 0 },
    "one-of": { cases: 0, passed: 0 },
  },
};
const BASELINE = { scorer: 1, passed: true, tools: 3 };

const V = { id: "acme/x", version: "1.0.0", packageSha256: SHA };
const suite = { ...V, hasEvals: true, starterPack: false };
const plain = { ...V, hasEvals: false, starterPack: false };
const pack = { ...V, hasEvals: false, starterPack: true };

const scoresOf = (entry: unknown): Scores => new Map([["acme/x@1.0.0", entry]]);

describe("judgeScoreEntry with an eval suite (the quality rules, unchanged)", () => {
  test("no scores input signs with nothing", () => {
    expect(judgeScoreEntry(undefined, suite)).toEqual({ ok: true });
  });
  test("no entry is skipped", () => {
    const r = judgeScoreEntry(new Map(), suite);
    expect(r).toEqual({
      ok: false,
      reason: "it has eval suites and scores.json has no score for it; not signed without a score",
    });
  });
  test("a matching quality signs the rebuilt quality", () => {
    const r = judgeScoreEntry(scoresOf({ packageSha256: SHA, quality: QUALITY }), suite);
    expect(r).toEqual({ ok: true, quality: QUALITY });
  });
  test.each([
    ["extra key", { packageSha256: SHA, quality: QUALITY, note: "hi" }],
    ["quality and error", { packageSha256: SHA, quality: QUALITY, error: {} }],
    ["an array", [1]],
    ["null", null],
    ["baseline and sha only", { packageSha256: SHA, baseline: BASELINE }],
  ])("%s is malformed", (_l, entry) => {
    const r = judgeScoreEntry(scoresOf(entry), suite);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toMatch(/malformed/);
  });
  test("another package's digest is refused", () => {
    const r = judgeScoreEntry(scoresOf({ packageSha256: "0".repeat(64), quality: QUALITY }), suite);
    expect(r.ok === false && r.reason).toMatch(/another package/);
  });
  test("an invalid quality is refused with a capped message", () => {
    const bad = { ...QUALITY, ["k".repeat(5000)]: 1 };
    const r = judgeScoreEntry(scoresOf({ packageSha256: SHA, quality: bad }), suite);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason.length).toBeLessThan(400);
  });
  test.each([
    ["a known code", { code: "ERR_EVAL_TIMEOUT", message: "slow" }, "ERR_EVAL_TIMEOUT"],
    ["an odd code", { code: "x\n::error::y", message: "m" }, "ERR_EVAL_FAILED"],
    ["a non-object", "boom", "ERR_EVAL_FAILED"],
  ])("an error entry with %s names a safe code", (_l, error, code) => {
    const r = judgeScoreEntry(scoresOf({ packageSha256: SHA, error }), suite);
    expect(r).toEqual({
      ok: false,
      reason: `its eval failed (${code}); not signed without a score`,
    });
  });

  test("quality plus baseline signs both", () => {
    const r = judgeScoreEntry(
      scoresOf({ baseline: BASELINE, packageSha256: SHA, quality: QUALITY }),
      suite,
    );
    expect(r).toEqual({ ok: true, quality: QUALITY, baseline: BASELINE });
  });
  test("an error with a baseline still skips with the eval-failed reason", () => {
    const r = judgeScoreEntry(
      scoresOf({ baseline: BASELINE, error: { code: "ERR_EVAL_TIMEOUT" }, packageSha256: SHA }),
      suite,
    );
    expect(r).toEqual({
      ok: false,
      reason: "its eval failed (ERR_EVAL_TIMEOUT); not signed without a score",
    });
  });
  test("a valid quality with a malformed baseline signs the quality and ignores the baseline", () => {
    const r = judgeScoreEntry(
      scoresOf({
        baseline: { scorer: 1, passed: false, tools: 0, failure: "it crashed: boom" },
        packageSha256: SHA,
        quality: QUALITY,
      }),
      suite,
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.quality).toEqual(QUALITY);
    expect(r.ok && r.baseline).toBeUndefined();
    expect(r.ok && r.baselineIgnored).toBeDefined();
    expect(r.ok && r.baselineIgnored).not.toContain("boom");
  });
});

describe("judgeScoreEntry without an eval suite", () => {
  test("its own baseline entry signs the baseline", () => {
    expect(judgeScoreEntry(scoresOf({ baseline: BASELINE, packageSha256: SHA }), plain)).toEqual({
      ok: true,
      baseline: BASELINE,
    });
  });
  test("no entry signs nothing and ignores nothing", () => {
    const r = judgeScoreEntry(new Map(), plain);
    expect(r).toEqual({ ok: true });
    expect("baselineIgnored" in r).toBe(false);
  });
  test.each([
    ["another hash", { baseline: BASELINE, packageSha256: "0".repeat(64) }],
    ["extra keys", { baseline: BASELINE, packageSha256: SHA, quality: QUALITY }],
    ["a quality entry", { packageSha256: SHA, quality: QUALITY }],
    ["a non-object", [1]],
  ])("an entry with %s is ignored, never a skip", (_l, entry) => {
    const r = judgeScoreEntry(scoresOf(entry), plain);
    expect(r.ok).toBe(true);
    expect(r.ok && r.baseline).toBeUndefined();
    expect(r.ok && r.baselineIgnored).toBeDefined();
  });
  test("a malformed baseline is ignored, never a skip", () => {
    const r = judgeScoreEntry(scoresOf({ baseline: { passed: true }, packageSha256: SHA }), plain);
    expect(r.ok && r.baseline).toBeUndefined();
    expect(r.ok && r.baselineIgnored).toBeDefined();
  });
  test("a starter pack takes no baseline", () => {
    expect(judgeScoreEntry(scoresOf({ baseline: BASELINE, packageSha256: SHA }), pack)).toEqual({
      ok: true,
    });
  });
  test("scores undefined is ok", () => {
    expect(judgeScoreEntry(undefined, plain)).toEqual({ ok: true });
    expect(judgeScoreEntry(undefined, pack)).toEqual({ ok: true });
  });
  test("__proto__ in the file is only a key", () => {
    let dir = "";
    dir = mkdtempSync(join(tmpdir(), "nimbus-scores-proto-"));
    try {
      const p = join(dir, "s.json");
      const good = JSON.stringify({ baseline: BASELINE, packageSha256: SHA });
      writeFileSync(p, `{"__proto__": ${good}, "acme/x@1.0.0": ${good}}`);
      const scores = readScores(p);
      expect(judgeScoreEntry(scores, plain)).toEqual({ ok: true, baseline: BASELINE });
      expect(judgeScoreEntry(scores, { ...plain, id: "__proto__", version: "x" })).toEqual({
        ok: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readScores", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-scores-file-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const write = (text: string): string => {
    const p = join(tmp, "scores.json");
    writeFileSync(p, text);
    return p;
  };

  test("reads entries into a map", () => {
    expect(readScores(write('{"a@1.0.0": 1}')).get("a@1.0.0")).toBe(1);
  });
  test.each([
    ["an unreadable file", (): string => join(tmp, "absent.json"), /could not be read/],
    ["an array", (): string => write("[]"), /not a JSON object/],
    ["null", (): string => write("null"), /not a JSON object/],
    ["garbage", (): string => write("{not json"), /not valid JSON/],
    [
      "a file over 4 MiB",
      (): string => write(`{${" ".repeat(MAX_SCORES_BYTES)}}`),
      /larger than 4194304 bytes/,
    ],
  ])("%s is refused", (_l, path, why) => {
    expect(() => readScores(path())).toThrow(why);
    expect(() => readScores(path())).toThrow(/^refusing to sign: the scores input \(/);
  });
  test("a file of exactly 4 MiB is read", () => {
    expect(readScores(write(`{${" ".repeat(MAX_SCORES_BYTES - 2)}}`)).size).toBe(0);
    expect(MAX_SCORES_BYTES).toBe(4 * 1024 * 1024);
  });
});
