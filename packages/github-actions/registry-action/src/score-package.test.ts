/**
 * `score-package` over a real `.tgz` with FAKE roles injected: the entries recorded, the wording of
 * a mode with no sign run, and the refusals that make a job red. The hash binding to `maintain add`
 * across the two runtimes is proved over the built bundle in
 * `packages/gateway/test/integration/registry-action-score-package.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionIo } from "./report.ts";
import { runScorePackage, type ScorePackageDeps } from "./score-package.ts";
import type { RoleRun } from "./score-role.ts";
import { makeExtension } from "./testing/registry-repo.ts";

setDefaultTimeout(60_000);

const SUITE = JSON.stringify({ format: 1, name: "basic", cases: [] });
const REPORT = {
  scorer: 1 as const,
  score: 50,
  cases: 2,
  passed: 1,
  rubrics: {
    exact: { cases: 2, passed: 1 },
    "json-match": { cases: 0, passed: 0 },
    "one-of": { cases: 0, passed: 0 },
  },
  results: [
    { suite: "basic", case: "a", rubric: "exact", pass: true, reason: null },
    { suite: "basic", case: "b", rubric: "exact", pass: false, reason: "mismatch" },
  ],
};
const { results: _results, ...QUALITY } = REPORT;
const BASELINE = { scorer: 1 as const, passed: true as const, tools: 3 };

const run = (stdout: string): RoleRun => ({
  code: 0,
  stdout,
  stderrTail: "",
  timedOut: false,
  overflow: false,
});

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

let tmp: string;
let scratch: string;
let gateway: string;
let out: string;
let summaries: string[];
let warnings: string[];
let calls: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-score-package-test-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  gateway = join(tmp, "nimbus-gateway");
  writeFileSync(gateway, "not run: the role is faked");
  mkdirSync(join(tmp, "out"));
  out = join(tmp, "out", "scores.json");
  summaries = [];
  warnings = [];
  calls = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const io: ActionIo = {
  annotate: (level, msg) => {
    if (level === "warning") warnings.push(msg);
  },
  summary: (md) => void summaries.push(md),
  log: () => {},
};

function manifestOf(dir: string): { id: string; version: string } {
  return JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8")) as {
    id: string;
    version: string;
  };
}

const deps: ScorePackageDeps = {
  io,
  tmpdir: () => scratch,
  now: () => 0,
  runRole: async (_gw, dir) => {
    const m = manifestOf(dir);
    calls.push(`suite ${m.id}@${m.version}`);
    return run(
      `${JSON.stringify({ ok: true, extensionId: m.id, version: m.version, report: REPORT })}\n`,
    );
  },
  runBaseline: async (_gw, dir) => {
    const m = manifestOf(dir);
    calls.push(`baseline ${m.id}@${m.version}`);
    return run(
      `${JSON.stringify({ ok: true, extensionId: m.id, version: m.version, baseline: BASELINE })}\n`,
    );
  },
};

const score = (pkg: string, over: Partial<ScorePackageDeps> = {}) =>
  runScorePackage({ package: pkg, gateway, out }, { ...deps, ...over });

/** The package `o` describes as a `.tgz` file, with its bytes. */
async function packageTgz(
  o: Parameters<typeof makeExtension>[1],
): Promise<{ path: string; sha: string }> {
  const ext = await makeExtension(scratch, o);
  const path = join(tmp, "package.tgz");
  writeFileSync(path, ext.pkg);
  return { path, sha: sha256(ext.pkg) };
}

/** Anything the mode prints that a registry with no sign run must not read. */
const SIGN_WORDING = /\bsign\b|sign run|default branch|signed without|still signed/i;

describe("score-package", () => {
  test("a .tgz is hashed as given", async () => {
    const { path, sha } = await packageTgz({ id: "acme/plain" });
    const r = await score(path);
    expect(r).toEqual({ "acme/plain@1.0.0": { packageSha256: sha, baseline: BASELINE } });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(r);
  });

  test("the role runs the bytes that were hashed, not the file as it later stands", async () => {
    const { path, sha } = await packageTgz({
      id: "acme/plain",
      dist: "export default 'original';\n",
    });
    let seen = "";
    const r = await score(path, {
      runBaseline: async (gw, roleDir) => {
        // The file changes after the run started: the role must not see it.
        writeFileSync(path, "tampered");
        seen = readFileSync(join(roleDir, "dist", "index.js"), "utf8");
        return deps.runBaseline(gw, roleDir);
      },
    });
    expect(seen).toBe("export default 'original';\n");
    expect(r["acme/plain@1.0.0"]?.packageSha256).toBe(sha);
    expect(readFileSync(path, "utf8")).toBe("tampered");
  });

  test("a suite package gets its quality and its baseline, the baseline run first", async () => {
    const { path, sha } = await packageTgz({
      id: "acme/scored",
      evals: { "basic.eval.json": SUITE },
    });
    const r = await score(path);
    expect(r).toEqual({
      "acme/scored@1.0.0": { packageSha256: sha, quality: QUALITY, baseline: BASELINE },
    });
    expect(calls).toEqual(["baseline acme/scored@1.0.0", "suite acme/scored@1.0.0"]);
    expect(summaries.join("\n")).toContain(
      "50/100 (1 of 2 cases passed); baseline: starts and lists 3 valid tools",
    );
  });

  test("a package without a suite gets a baseline alone, and the suite role never runs", async () => {
    const { path } = await packageTgz({ id: "acme/plain" });
    await score(path);
    expect(calls).toEqual(["baseline acme/plain@1.0.0"]);
  });

  test("a starter pack gives {}, runs nothing, and the summary says why", async () => {
    const { path } = await packageTgz({ id: "acme/pack", starterPack: true });
    const r = await score(path);
    expect(r).toEqual({});
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({});
    expect(calls).toEqual([]);
    const summary = summaries.join("\n");
    expect(summary).toContain("- `acme/pack@1.0.0`: a starter pack never runs");
    expect(summary).not.toContain("No unsigned version");
    expect(summary).not.toMatch(SIGN_WORDING);
  });

  test("a gateway older than --baseline: no entry, a warning, a green run, and the summary says why", async () => {
    const { path } = await packageTgz({ id: "acme/plain" });
    const r = await score(path, {
      runBaseline: async () => ({ ...run(""), code: 2, stderrTail: "usage: __nimbus-eval\n" }),
    });
    expect(r).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("acme/plain@1.0.0");
    expect(warnings[0]).toContain("scores.json holds no baseline for it");
    const summary = summaries.join("\n");
    expect(summary).toContain("- `acme/plain@1.0.0`: no baseline check (`ERR_EVAL_ROLE_FAILED`)");
    expect(summary).not.toContain("No unsigned version");
    expect(`${summary}\n${warnings.join("\n")}`).not.toMatch(SIGN_WORDING);
  });

  test("a failed eval names maintain add and never a sign run", async () => {
    const { path, sha } = await packageTgz({
      id: "acme/scored",
      evals: { "basic.eval.json": SUITE },
    });
    const r = await score(path, {
      runRole: async () => ({ ...run(""), code: 1, stderrTail: "boom\n" }),
    });
    expect(r["acme/scored@1.0.0"]?.packageSha256).toBe(sha);
    const text = `${summaries.join("\n")}\n${warnings.join("\n")}`;
    expect(text).toContain("`maintain add` refuses a package with eval suites");
    expect(text).toContain("**No score:**");
    expect(text).not.toMatch(SIGN_WORDING);
  });

  test("a spent budget says so without naming a sign run", async () => {
    const { path } = await packageTgz({ id: "acme/scored", evals: { "basic.eval.json": SUITE } });
    let t = 0;
    const r = await score(path, {
      now: () => {
        // Past the whole 14-minute budget from the second read on.
        const at = t;
        t = 15 * 60_000;
        return at;
      },
    });
    const entry = r["acme/scored@1.0.0"];
    expect(entry !== undefined && "error" in entry && entry.error.code).toBe("ERR_EVAL_BUDGET");
    expect(calls).toEqual([]);
    const text = `${summaries.join("\n")}\n${warnings.join("\n")}\n${JSON.stringify(r)}`;
    expect(text).toContain("no baseline check (`ERR_EVAL_BUDGET`)");
    expect(text).not.toMatch(SIGN_WORDING);
  });

  test("a no-listing baseline prints the sandbox line, in this mode's words", async () => {
    const { path } = await packageTgz({ id: "acme/plain" });
    await score(path, {
      runBaseline: async (_gw, dir) => {
        const m = manifestOf(dir);
        return run(
          `${JSON.stringify({
            ok: true,
            extensionId: m.id,
            version: m.version,
            baseline: { scorer: 1, passed: false, tools: 0, failure: "no-listing" },
          })}\n`,
        );
      },
    });
    const summary = summaries.join("\n");
    expect(summary).toContain("Check the job's sandbox setup before trusting it");
    expect(summary).toContain("`maintain add` signs the result into the version");
    expect(summary).not.toMatch(SIGN_WORDING);
  });

  test("a package that fails inspectPackage fails the job and writes nothing", async () => {
    const bad = join(tmp, "bad.tgz");
    // Gzip's magic, so this reaches the inspector rather than the input's own refusal.
    writeFileSync(bad, Buffer.from([0x1f, 0x8b, 0x00, 0x00]));
    await expect(score(bad)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a directory is refused, and the refusal names nimbus extension pack", async () => {
    const dir = mkdtempSync(join(tmp, "pkg-"));
    await expect(score(dir)).rejects.toThrow("nimbus extension pack");
    expect(existsSync(out)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a directory named like a .tgz is refused the same way", async () => {
    const dir = join(tmp, "dir.tgz");
    mkdirSync(dir);
    await expect(score(dir)).rejects.toThrow("nimbus extension pack");
    expect(existsSync(out)).toBe(false);
  });

  test("a missing path is refused, names the input and the command", async () => {
    await expect(score(join(tmp, "absent.tgz"))).rejects.toThrow('input "package"');
    await expect(score(join(tmp, "absent.tgz"))).rejects.toThrow("nimbus extension pack");
    expect(existsSync(out)).toBe(false);
  });

  test("a file that is not a .tgz is refused, by name and by content", async () => {
    const named = join(tmp, "package.zip");
    writeFileSync(named, "x");
    await expect(score(named)).rejects.toThrow("does not end in .tgz");
    const content = join(tmp, "text.tgz");
    writeFileSync(content, "not gzip");
    await expect(score(content)).rejects.toThrow("is not gzip data");
    expect(existsSync(out)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("assertGateway refuses a relative gateway path before anything is read", async () => {
    await expect(
      runScorePackage({ package: join(tmp, "absent"), gateway: "nimbus-gateway", out }, deps),
    ).rejects.toThrow('input "nimbus-gateway" must be an absolute path');
    expect(existsSync(out)).toBe(false);
  });

  test("the work directory is removed, and scores.json is written whole through a rename", async () => {
    const { path } = await packageTgz({ id: "acme/plain" });
    await score(path);
    expect(
      readdirSync(scratch).filter((n) => n.startsWith("nimbus-registry-score-package-")),
    ).toEqual([]);
    // writeFileAtomic leaves no temp sibling behind.
    expect(readdirSync(join(tmp, "out"))).toEqual(["scores.json"]);
    expect(readFileSync(out, "utf8").endsWith("\n")).toBe(true);
  });

  test("an output path in a missing directory fails and leaves no temp file", async () => {
    const { path } = await packageTgz({ id: "acme/plain" });
    await expect(
      runScorePackage({ package: path, gateway, out: join(tmp, "nope", "scores.json") }, deps),
    ).rejects.toThrow();
    expect(existsSync(join(tmp, "nope"))).toBe(false);
  });
});
