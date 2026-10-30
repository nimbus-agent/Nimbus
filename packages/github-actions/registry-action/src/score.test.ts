/**
 * `score` over real git with a FAKE role (`runRole` injected), plus the default role runner over a
 * fake `execFile`: the argv, the minimal environment and the caps are asserted on every OS. The one
 * test that runs the REAL `__nimbus-eval` role lives in `score.real.test.ts`.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
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
import { basename, dirname, join } from "node:path";
import { signIndex, validatePublish } from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import type { ExecFileLike } from "./provenance.ts";
import type { ActionIo } from "./report.ts";
import {
  ROLE_STDERR_TAIL_BYTES,
  ROLE_STDOUT_MAX_BYTES,
  ROLE_TIMEOUT_MS,
  type RoleRun,
  roleRunner,
  runScore,
  type ScoreDeps,
  type ScoresFile,
  writeFileAtomic,
} from "./score.ts";
import { runSign } from "./sign.ts";
import {
  copyRegistryRepo,
  makeExtension,
  makeRegistryRepo,
  OTHER_SEED,
  pushMaintainer,
  type RegistryRepo,
  ROOT_KEY_INPUT,
  writePublish,
} from "./testing/registry-repo.ts";

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

function okDoc(id: string, version: string, report: unknown = REPORT): string {
  return `${JSON.stringify({ ok: true, extensionId: id, version, report })}\n`;
}

const run = (over: Partial<RoleRun> = {}): RoleRun => ({
  code: 0,
  stdout: "",
  stderrTail: "",
  timedOut: false,
  overflow: false,
  ...over,
});

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

let templateDir: string;
let template: RegistryRepo;

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), "nimbus-registry-score-template-"));
  template = await makeRegistryRepo(join(templateDir, "reg"));
});

afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true });
});

let tmp: string;
let scratch: string;
let repo: RegistryRepo;
let gateway: string;
let out: string;
let summaries: string[];
let warnings: string[];
let logs: string[];
let roleCalls: { gateway: string; dir: string; files: string[] }[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-score-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  repo = copyRegistryRepo(template, join(tmp, "reg"));
  gateway = join(tmp, "nimbus-gateway");
  writeFileSync(gateway, "not run: the role is faked");
  out = join(tmp, "out", "scores.json");
  mkdirSync(dirname(out));
  summaries = [];
  warnings = [];
  logs = [];
  roleCalls = [];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const io: ActionIo = {
  annotate: (level, msg) => {
    if (level === "warning") warnings.push(msg);
  },
  summary: (md) => void summaries.push(md),
  log: (line) => void logs.push(line),
};

/** Lists what the role would see, relative to the dir it is handed. */
function listFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`],
  );
}

/** A fake role answering per `<id>@<version>` (read from the extracted manifest). */
function fakeRole(answer: (ref: string) => RoleRun | Promise<RoleRun>): ScoreDeps["runRole"] {
  return async (gw, dir) => {
    roleCalls.push({ gateway: gw, dir, files: listFiles(dir).sort() });
    const m = JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8")) as {
      id: string;
      version: string;
    };
    return answer(`${m.id}@${m.version}`);
  };
}

function deps(runRole: ScoreDeps["runRole"]): ScoreDeps {
  return { git: gitTree, io, tmpdir: () => scratch, validate: validatePublish, runRole };
}

const score = (runRole: ScoreDeps["runRole"], gw = gateway): Promise<ScoresFile> =>
  runScore({ workspace: repo.workspace, gateway: gw, out }, deps(runRole));

const readScores = (): unknown => JSON.parse(readFileSync(out, "utf8"));

async function publish(
  o: Parameters<typeof makeExtension>[1],
): Promise<{ id: string; version: string; pkgSha: string }> {
  const ext = await makeExtension(scratch, o);
  writePublish(repo.maintainer, ext);
  return { id: ext.id, version: ext.version, pkgSha: sha256(ext.pkg) };
}

const echoOk = fakeRole((ref) => {
  const [id = "", version = ""] = ref.split("@");
  return run({ stdout: okDoc(id, version) });
});

describe("score mode", () => {
  test("no candidates: scores.json is {} and the role never runs", async () => {
    const r = await score(echoOk);
    expect(r).toEqual({});
    expect(readScores()).toEqual({});
    expect(roleCalls).toEqual([]);
  });

  test("an evals candidate is scored from the extracted package; one without evals/ is absent", async () => {
    const withEvals = await publish({ id: "acme/scored", evals: { "basic.eval.json": SUITE } });
    await publish({ id: "acme/plain" });
    pushMaintainer(repo, "main", "publish two");

    const r = await score(echoOk);

    expect(r).toEqual({
      "acme/scored@1.0.0": { packageSha256: withEvals.pkgSha, quality: QUALITY },
    });
    expect(readScores()).toEqual(r);
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0]?.gateway).toBe(gateway);
    // The extracted package: exactly what inspectPackage puts in `<work>/x`.
    expect(basename(roleCalls[0]?.dir ?? "")).toBe("x");
    expect(roleCalls[0]?.files).toEqual([
      "README.md",
      "dist/index.js",
      "evals/basic.eval.json",
      "nimbus.extension.json",
    ]);
    // The work dir is the score mode's own, and is gone afterwards.
    expect(existsSync(roleCalls[0]?.dir ?? "")).toBe(false);
    expect(summaries.join("\n")).toContain("`acme/scored@1.0.0`: 50/100 (1 of 2 cases passed)");
  });

  test("the quality written is exactly the report minus results", async () => {
    await publish({ id: "acme/scored", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish");
    await score(echoOk);
    const entry = (readScores() as Record<string, { quality: Record<string, unknown> }>)[
      "acme/scored@1.0.0"
    ];
    expect(Object.keys(entry?.quality ?? {}).sort()).toEqual([
      "cases",
      "passed",
      "rubrics",
      "score",
      "scorer",
    ]);
  });

  test("the role's ok:false document is an error entry", async () => {
    const p = await publish({ id: "acme/scored", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish");
    const r = await score(
      fakeRole(() =>
        run({
          stdout: `${JSON.stringify({ ok: false, error: { code: "ERR_EVAL_SUITE_INVALID", message: "bad suite" } })}\n`,
        }),
      ),
    );
    expect(r).toEqual({
      "acme/scored@1.0.0": {
        packageSha256: p.pkgSha,
        error: { code: "ERR_EVAL_SUITE_INVALID", message: "bad suite" },
      },
    });
    expect(warnings.join("\n")).toContain("acme/scored@1.0.0");
  });

  test.each([
    ["a timeout", run({ code: null, timedOut: true }), "ERR_EVAL_TIMEOUT"],
    ["an stdout overflow", run({ code: null, overflow: true }), "ERR_EVAL_OUTPUT_TOO_LARGE"],
    ["garbage", run({ stdout: "not json\n" }), "ERR_EVAL_BAD_OUTPUT"],
    [
      "two documents",
      run({ stdout: okDoc("acme/scored", "1.0.0").repeat(2) }),
      "ERR_EVAL_BAD_OUTPUT",
    ],
    [
      "a report that fails validation",
      run({ stdout: okDoc("acme/scored", "1.0.0", { ...REPORT, score: 99 }) }),
      "ERR_EVAL_BAD_OUTPUT",
    ],
    ["another id", run({ stdout: okDoc("acme/other", "1.0.0") }), "ERR_EVAL_IDENTITY_MISMATCH"],
    [
      "another version",
      run({ stdout: okDoc("acme/scored", "2.0.0") }),
      "ERR_EVAL_IDENTITY_MISMATCH",
    ],
    [
      "a non-zero exit",
      run({ code: 3, stdout: okDoc("acme/scored", "1.0.0"), stderrTail: "boom\nlast words\n" }),
      "ERR_EVAL_ROLE_FAILED",
    ],
  ])("%s is an error entry", async (_label, answer, code) => {
    const p = await publish({ id: "acme/scored", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish");
    const r = await score(fakeRole(() => answer));
    const entry = r["acme/scored@1.0.0"];
    expect(entry?.packageSha256).toBe(p.pkgSha);
    expect(entry !== undefined && "error" in entry ? entry.error.code : undefined).toBe(code);
    expect(readScores()).toEqual(r);
  });

  test("a non-zero exit names the exit code and the last stderr line", async () => {
    await publish({ id: "acme/scored", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish");
    const r = await score(fakeRole(() => run({ code: 3, stderrTail: "boom\nlast words\n" })));
    const entry = r["acme/scored@1.0.0"];
    const message = entry !== undefined && "error" in entry ? entry.error.message : "";
    expect(message).toContain("3");
    expect(message).toContain("last words");
  });

  test("a role that throws is an error entry, and the next candidate is still scored", async () => {
    await publish({ id: "acme/first", evals: { "basic.eval.json": SUITE } });
    const second = await publish({ id: "acme/second", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish two");
    const r = await score(
      fakeRole((ref) => {
        if (ref.startsWith("acme/first")) throw new Error("spawn exploded");
        return run({ stdout: okDoc("acme/second", "1.0.0") });
      }),
    );
    const first = r["acme/first@1.0.0"];
    expect(first !== undefined && "error" in first ? first.error.code : "").toBe(
      "ERR_EVAL_ROLE_FAILED",
    );
    expect(r["acme/second@1.0.0"]).toEqual({ packageSha256: second.pkgSha, quality: QUALITY });
  });

  test("a version that failed its eval binds nothing for the next candidate (sign will not sign it)", async () => {
    // Two first versions of one new id under different publisher keys. Were the failed 1.0.0
    // added to the bindings, 1.1.0 would be refused for its key; sign never signs 1.0.0, so
    // score must judge 1.1.0 exactly as sign will: against the signed index alone.
    await publish({ id: "acme/x", version: "1.0.0", evals: { "basic.eval.json": SUITE } });
    const next = await publish({
      id: "acme/x",
      version: "1.1.0",
      seed: OTHER_SEED,
      evals: { "basic.eval.json": SUITE },
    });
    pushMaintainer(repo, "main", "publish two");
    const r = await score(
      fakeRole((ref) =>
        ref === "acme/x@1.0.0"
          ? run({ code: 1, stderrTail: "failed" })
          : run({ stdout: okDoc("acme/x", "1.1.0") }),
      ),
    );
    expect(r["acme/x@1.1.0"]).toEqual({ packageSha256: next.pkgSha, quality: QUALITY });
  });

  test("a scored version binds the next candidate, as sign will", async () => {
    await publish({ id: "acme/x", version: "1.0.0", evals: { "basic.eval.json": SUITE } });
    await publish({
      id: "acme/x",
      version: "1.1.0",
      seed: OTHER_SEED,
      evals: { "basic.eval.json": SUITE },
    });
    pushMaintainer(repo, "main", "publish two");
    const r = await score(echoOk);
    expect(Object.keys(r)).toEqual(["acme/x@1.0.0"]);
    expect(summaries.join("\n")).toContain("extensions/acme/x/1.1.0");
  });

  test("a candidate that fails validation is not scored", async () => {
    await publish({ id: "acme/bad", badSignature: true, evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish");
    const r = await score(echoOk);
    expect(r).toEqual({});
    expect(roleCalls).toEqual([]);
    expect(summaries.join("\n")).toContain("extensions/acme/bad/1.0.0");
  });

  test("already-signed versions are not scored again", async () => {
    await publish({ id: "acme/plain" });
    pushMaintainer(repo, "main", "publish");
    await runSign(
      { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT },
      { validate: validatePublish, sign: signIndex, git: gitTree, io, tmpdir: () => scratch },
    );
    // A later evals version of another extension is the only candidate left.
    await publish({ id: "acme/scored", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish more");
    const r = await score(echoOk);
    expect(Object.keys(r)).toEqual(["acme/scored@1.0.0"]);
    expect(roleCalls).toHaveLength(1);
  });

  test("a relative nimbus-gateway path fails the mode and writes nothing", async () => {
    await expect(score(echoOk, "nimbus-gateway")).rejects.toThrow(
      'input "nimbus-gateway" must be an absolute path',
    );
    expect(existsSync(out)).toBe(false);
  });

  test("a missing nimbus-gateway file fails the mode and writes nothing", async () => {
    await expect(score(echoOk, join(tmp, "absent"))).rejects.toThrow(
      'input "nimbus-gateway" must be an absolute path to an existing file',
    );
    expect(existsSync(out)).toBe(false);
  });
});

describe("writeFileAtomic", () => {
  test("writes a temp sibling, then renames it over the target", () => {
    const target = join(tmp, "scores.json");
    const calls: string[] = [];
    let tempPath = "";
    writeFileAtomic(target, "{}\n", {
      writeFileSync: (p, data, opts) => {
        calls.push("write");
        tempPath = String(p);
        expect(opts).toEqual({ flag: "wx" });
        writeFileSync(p, data, opts);
      },
      renameSync: (from, to) => {
        calls.push("rename");
        expect(String(from)).toBe(tempPath);
        expect(String(to)).toBe(target);
        expect(existsSync(target)).toBe(false);
        writeFileSync(String(to), readFileSync(String(from)));
        rmSync(String(from));
      },
    });
    expect(calls).toEqual(["write", "rename"]);
    expect(dirname(tempPath)).toBe(dirname(target));
    expect(basename(tempPath)).not.toBe(basename(target));
    expect(readFileSync(target, "utf8")).toBe("{}\n");
  });

  test("a failed rename leaves no temp file behind", () => {
    const target = join(tmp, "scores.json");
    expect(() =>
      writeFileAtomic(target, "{}\n", {
        writeFileSync,
        renameSync: () => {
          throw new Error("rename failed");
        },
      }),
    ).toThrow("rename failed");
    expect(readdirSync(tmp).filter((n) => n.startsWith("scores.json"))).toEqual([]);
  });
});

describe("the default role runner", () => {
  type Call = { file: string; args: string[]; opts: Parameters<ExecFileLike>[2] };

  function fakeExec(
    reply: (
      call: Call,
    ) => [err: { code?: unknown; killed?: boolean } | null, stdout: string, stderr: string],
  ): { exec: ExecFileLike; calls: Call[]; homeExisted: boolean[] } {
    const calls: Call[] = [];
    const homeExisted: boolean[] = [];
    const exec: ExecFileLike = (file, args, opts, done) => {
      const call = { file, args, opts };
      calls.push(call);
      homeExisted.push(existsSync(String(opts.env["HOME"])));
      const [err, stdout, stderr] = reply(call);
      queueMicrotask(() => done(err, stdout, stderr));
      return undefined;
    };
    return { exec, calls, homeExisted };
  }

  test("runs <gateway> __nimbus-eval --package <dir> --json with a minimal env and the caps", async () => {
    const f = fakeExec(() => [null, "{}\n", ""]);
    const r = await roleRunner(f.exec, () => scratch)("/abs/nimbus-gateway", "/work/x");
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0];
    expect(call?.file).toBe("/abs/nimbus-gateway");
    expect(call?.args).toEqual(["__nimbus-eval", "--package", "/work/x", "--json"]);
    expect(Object.keys(call?.opts.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
    expect(call?.opts.env["PATH"]).toBe(process.env["PATH"] ?? "");
    // A fresh private HOME under the runner's temp dir, there during the run and gone after.
    const home = String(call?.opts.env["HOME"]);
    expect(dirname(home)).toBe(scratch);
    expect(f.homeExisted).toEqual([true]);
    expect(existsSync(home)).toBe(false);
    expect(call?.opts.maxBuffer).toBe(8 * 1024 * 1024);
    expect(call?.opts.timeout).toBe(12 * 60_000);
    expect(call?.opts.windowsHide).toBe(true);
    expect(ROLE_STDOUT_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(ROLE_TIMEOUT_MS).toBe(12 * 60_000);
    expect(r).toEqual({
      code: 0,
      stdout: "{}\n",
      stderrTail: "",
      timedOut: false,
      overflow: false,
    });
  });

  test("the secrets in this process's environment never reach the role", async () => {
    const saved = process.env["INPUT_ROOT-KEY"];
    process.env["INPUT_ROOT-KEY"] = "secret";
    try {
      const f = fakeExec(() => [null, "", ""]);
      await roleRunner(f.exec, () => scratch)("/g", "/d");
      expect(JSON.stringify(f.calls[0]?.opts.env)).not.toContain("secret");
    } finally {
      if (saved === undefined) delete process.env["INPUT_ROOT-KEY"];
      else process.env["INPUT_ROOT-KEY"] = saved;
    }
  });

  test("an exit code is reported with the stderr tail capped at 64 KiB", async () => {
    const stderr = `${"a".repeat(ROLE_STDERR_TAIL_BYTES)}TAIL`;
    const f = fakeExec(() => [{ code: 3 }, "", stderr]);
    const r = await roleRunner(f.exec, () => scratch)("/g", "/d");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.overflow).toBe(false);
    expect(r.stderrTail).toHaveLength(ROLE_STDERR_TAIL_BYTES);
    expect(r.stderrTail.endsWith("TAIL")).toBe(true);
    expect(ROLE_STDERR_TAIL_BYTES).toBe(64 * 1024);
  });

  test("a kill at the deadline is a timeout", async () => {
    const f = fakeExec(() => [{ code: null, killed: true }, "partial", ""]);
    const r = await roleRunner(f.exec, () => scratch)("/g", "/d");
    expect(r).toMatchObject({ code: null, timedOut: true, overflow: false });
  });

  test("stdout past the cap is an overflow, not a timeout", async () => {
    const f = fakeExec(() => [
      { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true },
      "x",
      "",
    ]);
    const r = await roleRunner(f.exec, () => scratch)("/g", "/d");
    expect(r).toMatchObject({ code: null, timedOut: false, overflow: true });
  });

  test("a spawn failure is no exit code and says why", async () => {
    const f = fakeExec(() => [{ code: "EACCES" }, "", ""]);
    const r = await roleRunner(f.exec, () => scratch)("/g", "/d");
    expect(r.code).toBeNull();
    expect(r.stderrTail).toContain("EACCES");
  });

  test("a synchronous throw from execFile is a failed run, and HOME is still removed", async () => {
    let home = "";
    const exec: ExecFileLike = (_file, _args, opts) => {
      home = String(opts.env["HOME"]);
      throw new Error("spawn EINVAL");
    };
    const r = await roleRunner(exec, () => scratch)("/g", "/d");
    expect(r.code).toBeNull();
    expect(r.stderrTail).toContain("spawn EINVAL");
    expect(existsSync(home)).toBe(false);
  });
});
