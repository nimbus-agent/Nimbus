import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ALLOWED_OUTPUT_NAMES, setOutput } from "./output.ts";

let tmpDir: string;
let outFile: string;
let prevGithubOutput: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "annotate-output-"));
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
  test("exposes the three documented annotate-action outputs", () => {
    expect(ALLOWED_OUTPUT_NAMES.has("external-id")).toBe(true);
    expect(ALLOWED_OUTPUT_NAMES.has("is-new")).toBe(true);
    expect(ALLOWED_OUTPUT_NAMES.has("dora-eligible")).toBe(true);
    expect(ALLOWED_OUTPUT_NAMES.size).toBe(3);
  });
});

describe("setOutput", () => {
  test("writes name<<delim\\nvalue\\ndelim heredoc when GITHUB_OUTPUT is set", () => {
    setOutput("external-id", "github-actions:abc123:production");
    const written = readFileSync(outFile, "utf8");
    const m = /^external-id<<(EOF_[0-9a-f]{32})\ngithub-actions:abc123:production\n\1\n$/.exec(
      written,
    );
    expect(m).not.toBeNull();
  });

  test("rejects names outside the allowlist (defends GITHUB_OUTPUT against smuggled keys)", () => {
    expect(() => setOutput("not-allowed", "anything")).toThrow(/refusing to set unknown output/);
  });

  test("silently no-ops when GITHUB_OUTPUT is unset", () => {
    delete process.env.GITHUB_OUTPUT;
    expect(() => setOutput("external-id", "v")).not.toThrow();
    expect(() => readFileSync(outFile, "utf8")).toThrow();
  });

  test("delimiter is fresh per call (do/while body always runs at least once)", () => {
    setOutput("external-id", "v1");
    setOutput("is-new", "true");
    const written = readFileSync(outFile, "utf8");
    const delims = Array.from(written.matchAll(/EOF_[0-9a-f]{32}/g)).map((m) => m[0]);
    expect(delims).toHaveLength(4);
    expect(delims[0]).toBe(delims[1]);
    expect(delims[2]).toBe(delims[3]);
    expect(delims[0]).not.toBe(delims[2]);
  });

  test("crypto.randomUUID delimiter shape — no dashes in the suffix", () => {
    setOutput("dora-eligible", "true");
    const written = readFileSync(outFile, "utf8");
    const delim = written.match(/EOF_([0-9a-f-]+)/)?.[1];
    expect(delim).toBeDefined();
    expect(delim).not.toContain("-");
    expect(delim).toHaveLength(32);
  });
});
