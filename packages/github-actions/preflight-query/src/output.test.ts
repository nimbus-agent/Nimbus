import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOWED_OUTPUT_NAMES, setOutput } from "./output.ts";

let tmpDir: string;
let outFile: string;
let prevGithubOutput: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "preflight-output-"));
  outFile = join(tmpDir, "GITHUB_OUTPUT");
  prevGithubOutput = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outFile;
});

afterEach(() => {
  if (prevGithubOutput === undefined) delete process.env.GITHUB_OUTPUT;
  else process.env.GITHUB_OUTPUT = prevGithubOutput;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("ALLOWED_OUTPUT_NAMES", () => {
  test("exposes the five documented preflight-query outputs", () => {
    expect(ALLOWED_OUTPUT_NAMES.has("verdict")).toBe(true);
    expect(ALLOWED_OUTPUT_NAMES.has("incident-count")).toBe(true);
    expect(ALLOWED_OUTPUT_NAMES.has("failing-ci-count")).toBe(true);
    expect(ALLOWED_OUTPUT_NAMES.has("merge-conflict-count")).toBe(true);
    expect(ALLOWED_OUTPUT_NAMES.has("result-json")).toBe(true);
    expect(ALLOWED_OUTPUT_NAMES.size).toBe(5);
  });
});

describe("setOutput", () => {
  test(String.raw`writes name<<delim\nvalue\ndelim heredoc when GITHUB_OUTPUT is set`, () => {
    setOutput("verdict", "ok");
    const written = readFileSync(outFile, "utf8");
    const m = /^verdict<<(EOF_[0-9a-f]{32})\nok\n\1\n$/.exec(written);
    expect(m).not.toBeNull();
  });

  test("preserves multiline JSON value verbatim inside the heredoc", () => {
    const json = '{"verdict":"warn","findings":{"incidents":[1,2]}}';
    setOutput("result-json", json);
    const written = readFileSync(outFile, "utf8");
    expect(written).toContain(`\n${json}\n`);
  });

  test("rejects names outside the allowlist", () => {
    expect(() => setOutput("not-allowed", "anything")).toThrow(/refusing to set unknown output/);
  });

  test("silently no-ops when GITHUB_OUTPUT is unset", () => {
    delete process.env.GITHUB_OUTPUT;
    expect(() => setOutput("verdict", "ok")).not.toThrow();
    expect(() => readFileSync(outFile, "utf8")).toThrow();
  });

  test("delimiter is fresh per call (do/while body always runs at least once)", () => {
    setOutput("verdict", "ok");
    setOutput("incident-count", "0");
    const written = readFileSync(outFile, "utf8");
    const delims = Array.from(written.matchAll(/EOF_[0-9a-f]{32}/g)).map((m) => m[0]);
    expect(delims).toHaveLength(4);
    expect(delims[0]).toBe(delims[1]);
    expect(delims[2]).toBe(delims[3]);
    expect(delims[0]).not.toBe(delims[2]);
  });

  test("crypto.randomUUID delimiter shape — no dashes in the suffix", () => {
    setOutput("merge-conflict-count", "3");
    const written = readFileSync(outFile, "utf8");
    const delim = written.match(/EOF_([0-9a-f-]+)/)?.[1];
    expect(delim).toBeDefined();
    expect(delim).not.toContain("-");
    expect(delim).toHaveLength(32);
  });
});
