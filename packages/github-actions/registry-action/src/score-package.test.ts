/**
 * `score-package` over a real directory or `.tgz` with FAKE roles injected: the hash binding to
 * `maintain add`'s packer, the entries recorded, and the refusals that make a job red.
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
import { packExtensionDir } from "../../../registry-format/src/index.ts";
import type { ActionIo } from "./report.ts";
import type { RoleRun } from "./score.ts";
import { runScorePackage, type ScorePackageDeps } from "./score-package.ts";
import { makeExtension, write } from "./testing/registry-repo.ts";

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

/** An unpacked package directory for `o`, holding exactly the files `makeExtension` packs. */
async function packageDir(o: Parameters<typeof makeExtension>[1]): Promise<string> {
  const ext = await makeExtension(scratch, o);
  const dir = mkdtempSync(join(tmp, "pkg-"));
  write(dir, "nimbus.extension.json", ext.manifest);
  write(dir, "README.md", "echo\n");
  if (o?.starterPack !== true) write(dir, "dist/index.js", o?.dist ?? "export default 1;\n");
  for (const [name, text] of Object.entries(o?.evals ?? {})) write(dir, `evals/${name}`, text);
  return dir;
}

async function packedSha(dir: string): Promise<string> {
  const tgz = join(tmp, `${sha256(Buffer.from(dir)).slice(0, 8)}.tgz`);
  await packExtensionDir(dir, tgz);
  return sha256(readFileSync(tgz));
}

describe("score-package", () => {
  test("a directory is packed, and its packageSha256 equals the hash of packExtensionDir's bytes", async () => {
    const dir = await packageDir({ id: "acme/plain" });
    const r = await score(dir);
    expect(r).toEqual({
      "acme/plain@1.0.0": { packageSha256: await packedSha(dir), baseline: BASELINE },
    });
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(r);
  });

  test("a .tgz is hashed as given", async () => {
    const ext = await makeExtension(scratch, { id: "acme/plain" });
    const tgz = join(tmp, "given.tgz");
    writeFileSync(tgz, ext.pkg);
    const r = await score(tgz);
    expect(r["acme/plain@1.0.0"]?.packageSha256).toBe(sha256(ext.pkg));
  });

  test("a directory and its own packed .tgz give the same entry key and hash", async () => {
    const dir = await packageDir({ id: "acme/plain" });
    const tgz = join(tmp, "own.tgz");
    await packExtensionDir(dir, tgz);
    const fromDir = await score(dir);
    const fromTgz = await score(tgz);
    expect(fromTgz).toEqual(fromDir);
    expect(Object.keys(fromTgz)).toEqual(["acme/plain@1.0.0"]);
  });

  test("a suite package gets its quality and its baseline, the baseline run first", async () => {
    const dir = await packageDir({ id: "acme/scored", evals: { "basic.eval.json": SUITE } });
    const r = await score(dir);
    expect(r).toEqual({
      "acme/scored@1.0.0": {
        packageSha256: await packedSha(dir),
        quality: QUALITY,
        baseline: BASELINE,
      },
    });
    expect(calls).toEqual(["baseline acme/scored@1.0.0", "suite acme/scored@1.0.0"]);
    expect(summaries.join("\n")).toContain(
      "50/100 (1 of 2 cases passed); baseline: starts and lists 3 valid tools",
    );
  });

  test("a package without a suite gets a baseline alone, and the suite role never runs", async () => {
    const dir = await packageDir({ id: "acme/plain" });
    await score(dir);
    expect(calls).toEqual(["baseline acme/plain@1.0.0"]);
  });

  test("a starter pack gives {} and runs nothing", async () => {
    const dir = await packageDir({ id: "acme/pack", starterPack: true });
    const r = await score(dir);
    expect(r).toEqual({});
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({});
    expect(calls).toEqual([]);
  });

  test("a gateway older than --baseline: no entry for a plain package, a warning, a green run", async () => {
    const dir = await packageDir({ id: "acme/plain" });
    const r = await score(dir, {
      runBaseline: async () => ({ ...run(""), code: 2, stderrTail: "usage: __nimbus-eval\n" }),
    });
    expect(r).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("acme/plain@1.0.0");
  });

  test("a package that fails inspectPackage fails the job and writes nothing", async () => {
    const bad = join(tmp, "bad.tgz");
    writeFileSync(bad, "not a tarball");
    await expect(score(bad)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("a directory with no manifest fails the job", async () => {
    const dir = mkdtempSync(join(tmp, "empty-"));
    write(dir, "README.md", "x\n");
    await expect(score(dir)).rejects.toThrow();
    expect(existsSync(out)).toBe(false);
  });

  test("a missing path fails the job and names the input", async () => {
    await expect(score(join(tmp, "absent"))).rejects.toThrow('input "package"');
    expect(existsSync(out)).toBe(false);
  });

  test("assertGateway refuses a relative gateway path before anything is read", async () => {
    await expect(
      runScorePackage({ package: join(tmp, "absent"), gateway: "nimbus-gateway", out }, deps),
    ).rejects.toThrow('input "nimbus-gateway" must be an absolute path');
    expect(existsSync(out)).toBe(false);
  });

  test("the work directory is removed, and scores.json is written whole through a rename", async () => {
    const dir = await packageDir({ id: "acme/plain" });
    await score(dir);
    expect(
      readdirSync(scratch).filter((n) => n.startsWith("nimbus-registry-score-package-")),
    ).toEqual([]);
    // writeFileAtomic leaves no temp sibling behind.
    expect(readdirSync(join(tmp, "out"))).toEqual(["scores.json"]);
    expect(readFileSync(out, "utf8").endsWith("\n")).toBe(true);
  });

  test("an output path in a missing directory fails and leaves no temp file", async () => {
    const dir = await packageDir({ id: "acme/plain" });
    await expect(
      runScorePackage({ package: dir, gateway, out: join(tmp, "nope", "scores.json") }, deps),
    ).rejects.toThrow();
    expect(existsSync(join(tmp, "nope"))).toBe(false);
  });
});
