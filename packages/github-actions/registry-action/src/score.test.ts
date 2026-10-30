/**
 * `score` over real git with a FAKE role (`runRole` injected), plus the default role runner over a
 * fake `spawn`: the argv, the minimal environment and the caps are asserted on every OS. The one
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
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { PassThrough } from "node:stream";
import { signIndex, validatePublish } from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import type { ActionIo } from "./report.ts";
import {
  type KillProcess,
  ROLE_DRAIN_GRACE_MS,
  ROLE_KILL_BOUND_MS,
  ROLE_STDERR_TAIL_BYTES,
  ROLE_STDOUT_MAX_BYTES,
  ROLE_TIMEOUT_MS,
  type RoleRun,
  type RoleSpawnOptions,
  roleRunner,
  runScore,
  SCORE_RUN_BUDGET_MS,
  type ScoreDeps,
  type ScoresFile,
  type SpawnLike,
  scoreCandidate,
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
  syncMaintainer,
  write,
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
let roleCalls: { gateway: string; dir: string; files: string[]; timeoutMs: number | undefined }[];
/** The fake clock score mode reads its run budget from. */
let clock: number;

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
  clock = 1_000_000;
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
  return async (gw, dir, timeoutMs) => {
    roleCalls.push({ gateway: gw, dir, files: listFiles(dir).sort(), timeoutMs });
    const m = JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8")) as {
      id: string;
      version: string;
    };
    return answer(`${m.id}@${m.version}`);
  };
}

function deps(runRole: ScoreDeps["runRole"]): ScoreDeps {
  return {
    git: gitTree,
    io,
    tmpdir: () => scratch,
    validate: validatePublish,
    runRole,
    now: () => clock,
  };
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

  test("under the run budget every evals candidate runs with the full role timeout", async () => {
    await publish({ id: "acme/one", evals: { "basic.eval.json": SUITE } });
    await publish({ id: "acme/two", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish two");

    const r = await score(echoOk);

    expect(Object.values(r).every((e) => "quality" in e)).toBe(true);
    expect(Object.keys(r).sort()).toEqual(["acme/one@1.0.0", "acme/two@1.0.0"]);
    expect(roleCalls.map((c) => c.timeoutMs)).toEqual([ROLE_TIMEOUT_MS, ROLE_TIMEOUT_MS]);
  });

  test("hanging suites spend the run budget: later candidates get ERR_EVAL_BUDGET, unrun", async () => {
    expect(SCORE_RUN_BUDGET_MS).toBe(14 * 60_000);
    for (const id of ["acme/one", "acme/two", "acme/three"]) {
      await publish({ id, evals: { "basic.eval.json": SUITE } });
    }
    pushMaintainer(repo, "main", "publish three");
    // Each run hangs until the deadline it was given.
    const hang = fakeRole(() => {
      clock += roleCalls.at(-1)?.timeoutMs ?? 0;
      return run({ code: null, timedOut: true });
    });

    const r = await score(hang);

    // The first gets the role's own deadline; the second only what is left of the budget.
    expect(roleCalls.map((c) => c.timeoutMs)).toEqual([ROLE_TIMEOUT_MS, 2 * 60_000]);
    const codes = Object.values(r).map((e) => ("error" in e ? e.error.code : "quality"));
    expect(codes.sort()).toEqual(["ERR_EVAL_BUDGET", "ERR_EVAL_TIMEOUT", "ERR_EVAL_TIMEOUT"]);
    const spent = Object.entries(r).find(
      ([, e]) => "error" in e && e.error.code === "ERR_EVAL_BUDGET",
    );
    expect(spent?.[1]).toEqual({
      packageSha256: expect.any(String),
      error: {
        code: "ERR_EVAL_BUDGET",
        message:
          "not scored this run: earlier evals spent the score job's time budget; it is scored again on the next sign run (a push to the default branch or a workflow_dispatch)",
      },
    });
    const messages = Object.values(r).map((e) => ("error" in e ? e.error.message : ""));
    // The budget, not the suite, set the second deadline: the message says so.
    expect(messages).toContain(
      "the eval did not finish within 2 minutes (the score job's remaining time budget; the cap is 12 minutes)",
    );
    // The role's own cap names no budget.
    expect(messages).toContain("the eval did not finish within 12 minutes");
    expect(readScores()).toEqual(r);
  });

  test("failed versions are listed with the remedy, in the summary and the warning", async () => {
    await publish({ id: "acme/bad", evals: { "basic.eval.json": SUITE } });
    await publish({ id: "acme/good", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish two");
    await score(
      fakeRole((ref) =>
        ref === "acme/bad@1.0.0"
          ? run({ code: 1, stderrTail: "boom" })
          : run({ stdout: okDoc("acme/good", "1.0.0") }),
      ),
    );
    const remedy =
      "A version whose eval failed is not signed, so it is scored again on every sign run (a push to the default branch or a workflow_dispatch) until it scores or its directory is removed from the default branch; meanwhile each attempt spends time budget that later versions need.";
    const summary = summaries.join("\n");
    // Exactly the failed version is listed, followed by the remedy.
    expect(summary).toContain(`**Not signed** (no score):\n\n- \`acme/bad@1.0.0\`\n\n${remedy}`);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("eval of acme/bad@1.0.0 failed (ERR_EVAL_ROLE_FAILED)");
    expect(warnings[0]).toContain(remedy);
  });

  test("with no failed version the summary carries no remedy", async () => {
    await publish({ id: "acme/good", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish");
    await score(echoOk);
    expect(summaries.join("\n")).not.toContain("Not signed");
    expect(warnings).toEqual([]);
  });

  test("a budget with under a minute left runs nothing more", async () => {
    await publish({ id: "acme/one", evals: { "basic.eval.json": SUITE } });
    await publish({ id: "acme/two", evals: { "basic.eval.json": SUITE } });
    pushMaintainer(repo, "main", "publish two");
    // The first run returns with 59 s of the budget left.
    const slow = fakeRole((ref) => {
      clock += SCORE_RUN_BUDGET_MS - 59_000;
      const [id = "", version = ""] = ref.split("@");
      return run({ stdout: okDoc(id, version) });
    });

    const r = await score(slow);

    expect(roleCalls).toHaveLength(1);
    const codes = Object.values(r).map((e) => ("error" in e ? e.error.code : "quality"));
    expect(codes.sort()).toEqual(["ERR_EVAL_BUDGET", "quality"]);
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

  test("a changed signed version refuses the run as score, not sign, and writes nothing", async () => {
    await publish({ id: "acme/plain" });
    pushMaintainer(repo, "main", "publish");
    await runSign(
      { workspace: repo.workspace, rootKey: ROOT_KEY_INPUT },
      { validate: validatePublish, sign: signIndex, git: gitTree, io, tmpdir: () => scratch },
    );
    syncMaintainer(repo, "main");
    write(repo.maintainer, "extensions/acme/plain/1.0.0/package.tgz", "tampered");
    pushMaintainer(repo, "main", "tamper");
    const err = await score(echoOk).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err?.message).toStartWith("refusing to score: already-signed versions changed");
    expect(err?.message).toContain("extensions/acme/plain/1.0.0/package.tgz differs");
    expect(existsSync(out)).toBe(false);
  });

  test("scoreCandidate never throws when removing its directory fails", async () => {
    const ext = await makeExtension(scratch, {
      id: "acme/scored",
      evals: { "basic.eval.json": SUITE },
    });
    const removed: string[] = [];
    const entry = await scoreCandidate(
      {
        verdict: { id: ext.id, version: ext.version, packageSha256: sha256(ext.pkg) },
        packageBytes: ext.pkg,
      },
      { gateway, work: scratch },
      echoOk,
      () => {},
      (p) => {
        removed.push(p);
        throw new Error("EBUSY: resource busy");
      },
    );
    expect(entry).toEqual({ packageSha256: sha256(ext.pkg), quality: QUALITY });
    expect(removed).toHaveLength(1);
    expect(dirname(removed[0] ?? "")).toBe(scratch);
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
  const POSIX = process.platform !== "win32";

  type Call = { file: string; args: string[]; opts: RoleSpawnOptions };

  /** A spawned process that does what the test tells it to, and records its kills. */
  class FakeChild extends EventEmitter {
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly kills: Array<NodeJS.Signals | number | undefined> = [];
    exited = false;
    constructor(readonly pid: number | undefined) {
      super();
    }
    kill(signal?: NodeJS.Signals | number): boolean {
      this.kills.push(signal);
      return true;
    }
    /** Exits with `code` (or by `signal`) and, unless `holdStdio`, closes its stdio. */
    end(code: number | null, signal: NodeJS.Signals | null = null, holdStdio = false): void {
      this.exited = true;
      this.emit("exit", code, signal);
      if (holdStdio) return;
      this.stdout.end();
      this.stderr.end();
      this.emit("close", code, signal);
    }
  }

  interface Harness {
    spawn: SpawnLike;
    calls: Call[];
    children: FakeChild[];
    homeExisted: boolean[];
    groupKills: Array<[number, NodeJS.Signals]>;
    kill: KillProcess;
  }

  /** `behave` drives each spawned child; a group kill ends it by SIGKILL (holding its stdio open when told to). */
  function harness(
    behave: (child: FakeChild) => void,
    o: { pid?: number | undefined; holdStdioOnKill?: boolean } = {},
  ): Harness {
    const h: Harness = {
      calls: [],
      children: [],
      homeExisted: [],
      groupKills: [],
      spawn: (file, args, opts) => {
        h.calls.push({ file, args, opts });
        h.homeExisted.push(existsSync(opts.env["HOME"] ?? ""));
        const child = new FakeChild("pid" in o ? o.pid : 4242);
        h.children.push(child);
        queueMicrotask(() => behave(child));
        return child;
      },
      kill: (pid, signal) => {
        h.groupKills.push([pid, signal]);
        const child = h.children.find((c) => c.pid === -pid);
        // After the role exited, the sweep finds nothing left in the group.
        if (child === undefined || child.exited) {
          throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
        }
        child.end(null, signal, o.holdStdioOnKill === true);
      },
    };
    return h;
  }

  /** Ends a child that a Windows `child.kill` was sent to, as the OS would. */
  function endOnChildKill(child: FakeChild, holdStdio = false): void {
    const kill = child.kill.bind(child);
    child.kill = (signal) => {
      const r = kill(signal);
      if (!child.exited) {
        child.end(null, "SIGKILL", holdStdio);
      }
      return r;
    };
  }

  const run = (h: Harness, timeoutMs?: number, rm?: (p: string) => void): Promise<RoleRun> =>
    roleRunner(h.spawn, () => scratch, rm, h.kill)("/abs/nimbus-gateway", "/work/x", timeoutMs);

  test("spawns <gateway> __nimbus-eval --package <dir> --json, minimal env, no shell, own group on POSIX", async () => {
    const h = harness((c) => {
      c.stdout.write("{}\n");
      c.end(0);
    });
    const r = await run(h);
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0];
    expect(call?.file).toBe("/abs/nimbus-gateway");
    expect(call?.args).toEqual(["__nimbus-eval", "--package", "/work/x", "--json"]);
    expect(Object.keys(call?.opts.env ?? {}).sort()).toEqual(["HOME", "PATH"]);
    expect(call?.opts.env["PATH"]).toBe(process.env["PATH"] ?? "");
    expect(call?.opts.windowsHide).toBe(true);
    expect(call?.opts.shell).toBe(false);
    expect(call?.opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(call?.opts.detached).toBe(POSIX);
    // A fresh private HOME under the runner's temp dir, there during the run and gone after.
    const home = String(call?.opts.env["HOME"]);
    expect(dirname(home)).toBe(scratch);
    expect(h.homeExisted).toEqual([true]);
    expect(existsSync(home)).toBe(false);
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

  test("after a clean exit the role's group is swept on POSIX, and nothing is killed on Windows", async () => {
    const h = harness((c) => {
      c.end(0);
    });
    await run(h);
    expect(h.groupKills).toEqual(POSIX ? [[-4242, "SIGKILL"]] : []);
    expect(h.children[0]?.kills).toEqual([]);
  });

  test("the secrets in this process's environment never reach the role", async () => {
    const saved = process.env["INPUT_ROOT-KEY"];
    process.env["INPUT_ROOT-KEY"] = "secret";
    try {
      const h = harness((c) => {
        c.end(0);
      });
      await run(h);
      expect(JSON.stringify(h.calls[0]?.opts.env)).not.toContain("secret");
    } finally {
      if (saved === undefined) delete process.env["INPUT_ROOT-KEY"];
      else process.env["INPUT_ROOT-KEY"] = saved;
    }
  });

  test("at the deadline the whole group is SIGKILLed (the role alone on Windows) and the run is a timeout", async () => {
    // A role that never exits by itself and prints a little first.
    const h = harness((c) => {
      endOnChildKill(c);
      c.stdout.write("partial");
    });
    const started = Date.now();
    const r = await run(h, 100);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r).toMatchObject({ code: null, timedOut: true, overflow: false, stdout: "partial" });
    if (POSIX) {
      expect(h.groupKills[0]).toEqual([-4242, "SIGKILL"]);
      expect(h.children[0]?.kills).toEqual([]);
    } else {
      expect(h.groupKills).toEqual([]);
      expect(h.children[0]?.kills).toEqual(["SIGKILL"]);
    }
  });

  test("a process left holding the role's stdio cannot block the run: it resolves after the drain grace", async () => {
    // The kill ends the role, but its stdio never closes (an orphan still holds the pipes).
    const h = harness(
      (c) => {
        endOnChildKill(c, true);
        c.stderr.write("held\n");
      },
      { holdStdioOnKill: true },
    );
    const started = Date.now();
    const r = await run(h, 100);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(ROLE_DRAIN_GRACE_MS - 50);
    expect(took).toBeLessThan(ROLE_DRAIN_GRACE_MS + 10_000);
    expect(r).toMatchObject({ code: null, timedOut: true, stderrTail: "held\n" });
    // The streams are destroyed once the run resolves: nothing keeps reading them.
    expect(h.children[0]?.stdout.destroyed).toBe(true);
    expect(h.children[0]?.stderr.destroyed).toBe(true);
    expect(ROLE_DRAIN_GRACE_MS).toBe(2_000);
  });

  test("a deadline passed to the runner replaces the role timeout", async () => {
    const h = harness((c) => endOnChildKill(c));
    const r = await run(h, 50);
    expect(r.timedOut).toBe(true);
  });

  test("with no deadline given the role gets ROLE_TIMEOUT_MS; a given one is used as is", async () => {
    const spy = spyOn(globalThis, "setTimeout");
    try {
      const delays = async (timeoutMs?: number): Promise<unknown[]> => {
        spy.mockClear();
        await run(
          harness((c) => c.end(0)),
          timeoutMs,
        );
        return spy.mock.calls.map((call) => call[1]);
      };
      const omitted = await delays();
      expect(omitted).toContain(ROLE_TIMEOUT_MS);
      const given = await delays(90_000);
      expect(given).toContain(90_000);
      expect(given).not.toContain(ROLE_TIMEOUT_MS);
    } finally {
      spy.mockRestore();
    }
  });

  test("a kill that no exit follows still ends the run within ROLE_KILL_BOUND_MS, as a timeout", async () => {
    // Neither the group kill nor the role kill ends anything: a role stuck in the kernel.
    const h: Harness = harness(() => {});
    h.kill = (pid, signal) => {
      h.groupKills.push([pid, signal]);
    };
    const started = Date.now();
    const r = await run(h, 50);
    const took = Date.now() - started;
    expect(r).toMatchObject({ code: null, timedOut: true, overflow: false });
    expect(took).toBeGreaterThanOrEqual(ROLE_KILL_BOUND_MS - 100);
    expect(took).toBeLessThan(ROLE_KILL_BOUND_MS + 10_000);
    expect(ROLE_KILL_BOUND_MS).toBe(5_000);
  });

  test("an overflow kill that no exit follows still ends the run, as an overflow", async () => {
    const h: Harness = harness((c) => {
      c.stdout.write(Buffer.alloc(ROLE_STDOUT_MAX_BYTES + 1, 0x78));
    });
    h.kill = (pid, signal) => {
      h.groupKills.push([pid, signal]);
    };
    const r = await run(h, 60_000);
    expect(r).toMatchObject({ code: null, timedOut: false, overflow: true });
  });

  test("stdout past the cap after the exit is an overflow, but no kill is sent after the exit", async () => {
    // The role exits with its stdio held open; during the drain grace the stdout floods.
    const h = harness((c) => {
      c.end(0, null, true);
      c.stdout.write(Buffer.alloc(ROLE_STDOUT_MAX_BYTES + 1, 0x78));
    });
    const r = await run(h);
    expect(r).toMatchObject({ code: 0, overflow: true, timedOut: false });
    // Only the sweep at the exit itself (POSIX); nothing after it.
    expect(h.groupKills).toEqual(POSIX ? [[-4242, "SIGKILL"]] : []);
    expect(h.children[0]?.kills).toEqual([]);
  });

  test("a role that exits in time is not a timeout, and its deadline never fires later", async () => {
    const h = harness((c) => {
      c.end(0);
    });
    const r = await run(h, 200);
    await new Promise((res) => setTimeout(res, 400));
    expect(r.timedOut).toBe(false);
    expect(h.children[0]?.kills).toEqual([]);
    expect(h.groupKills.length).toBeLessThanOrEqual(1);
  });

  test("an exit code is reported with the stderr tail capped at 64 KiB, counted in bytes", async () => {
    const h = harness((c) => {
      // Multibyte text first, so a character count would keep more than 64 KiB of bytes.
      c.stderr.write("é".repeat(ROLE_STDERR_TAIL_BYTES));
      c.stderr.write("a".repeat(ROLE_STDERR_TAIL_BYTES - 4));
      c.stderr.write("TAIL");
      c.end(3);
    });
    const r = await run(h);
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.overflow).toBe(false);
    expect(Buffer.byteLength(r.stderrTail)).toBe(ROLE_STDERR_TAIL_BYTES);
    expect(r.stderrTail).toBe(`${"a".repeat(ROLE_STDERR_TAIL_BYTES - 4)}TAIL`);
    expect(ROLE_STDERR_TAIL_BYTES).toBe(64 * 1024);
  });

  test("stderr does not count toward the stdout cap", async () => {
    const h = harness((c) => {
      c.stderr.write(Buffer.alloc(ROLE_STDOUT_MAX_BYTES + 1, 0x61));
      c.stdout.write("{}\n");
      c.end(0);
    });
    const r = await run(h);
    expect(r).toMatchObject({ code: 0, stdout: "{}\n", overflow: false });
    expect(Buffer.byteLength(r.stderrTail)).toBe(ROLE_STDERR_TAIL_BYTES);
  });

  test("stdout past the cap kills the group and is an overflow, not a timeout", async () => {
    const h = harness((c) => {
      endOnChildKill(c);
      c.stdout.write(Buffer.alloc(ROLE_STDOUT_MAX_BYTES, 0x78));
      c.stdout.write("y");
    });
    const r = await run(h);
    expect(r).toMatchObject({ code: null, timedOut: false, overflow: true });
    expect(r.stdout).toHaveLength(ROLE_STDOUT_MAX_BYTES);
    if (POSIX) expect(h.groupKills[0]).toEqual([-4242, "SIGKILL"]);
    else expect(h.children[0]?.kills).toEqual(["SIGKILL"]);
  });

  test("a group already gone (ESRCH) is not an error, and the role is not killed again", async () => {
    // The kill finds nothing (ESRCH), and the role exits on its own shortly after.
    const h: Harness = harness((c) => {
      setTimeout(() => {
        c.end(null, "SIGKILL");
      }, 300);
    });
    h.kill = (pid, signal) => {
      h.groupKills.push([pid, signal]);
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    };
    const r = await run(h, 50);
    expect(r.timedOut).toBe(true);
    expect(h.children[0]?.kills).toEqual(POSIX ? [] : ["SIGKILL"]);
  });

  test("a group kill that fails otherwise (EPERM) falls back to killing the role", async () => {
    const h: Harness = harness((c) => endOnChildKill(c));
    h.kill = (pid, signal) => {
      h.groupKills.push([pid, signal]);
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    };
    const r = await run(h, 50);
    expect(r.timedOut).toBe(true);
    expect(h.children[0]?.kills).toEqual(["SIGKILL"]);
  });

  test("a spawn failure (the error event, no pid) is no exit code and says why", async () => {
    const h = harness(
      (c) => {
        c.emit(
          "error",
          Object.assign(new Error("spawn /abs/nimbus-gateway ENOENT"), { code: "ENOENT" }),
        );
      },
      { pid: undefined },
    );
    const r = await run(h);
    expect(r).toMatchObject({ code: null, stdout: "", timedOut: false, overflow: false });
    expect(r.stderrTail).toBe("could not run the gateway: ENOENT\n");
  });

  test("an error event from a started role does not end the run; its exit does", async () => {
    const h = harness((c) => {
      c.emit("error", new Error("kill EPERM"));
      c.stdout.write("{}\n");
      c.end(0);
    });
    const r = await run(h);
    expect(r).toMatchObject({ code: 0, stdout: "{}\n" });
  });

  test("the run resolves exactly once, and HOME is removed exactly once", async () => {
    const removed: string[] = [];
    const h = harness((c) => {
      c.end(0);
      c.emit("close", 0, null);
      c.emit("exit", 0, null);
    });
    await run(h, undefined, (p) => {
      removed.push(p);
      rmSync(p, { recursive: true, force: true });
    });
    await new Promise((res) => setTimeout(res, ROLE_DRAIN_GRACE_MS + 200));
    expect(removed).toHaveLength(1);
  });

  test("a failure removing HOME still resolves the run", async () => {
    const h = harness((c) => {
      c.stdout.write("{}");
      c.end(0);
    });
    const removed: string[] = [];
    const r = await run(h, undefined, (p) => {
      removed.push(p);
      throw new Error("EBUSY: resource busy");
    });
    expect(r).toMatchObject({ code: 0, stdout: "{}" });
    expect(removed).toEqual([String(h.calls[0]?.opts.env["HOME"])]);
    rmSync(removed[0] ?? "", { recursive: true, force: true });
  });

  test("a failure removing HOME after a synchronous throw still resolves the run", async () => {
    const spawnThrows: SpawnLike = () => {
      throw new Error("spawn EINVAL");
    };
    let home = "";
    const r = await roleRunner(
      spawnThrows,
      () => scratch,
      (p) => {
        home = p;
        throw new Error("EBUSY");
      },
    )("/g", "/d");
    expect(r.code).toBeNull();
    expect(r.stderrTail).toContain("spawn EINVAL");
    rmSync(home, { recursive: true, force: true });
  });

  test("a synchronous throw from spawn is a failed run, and HOME is still removed", async () => {
    let home = "";
    const spawnThrows: SpawnLike = (_file, _args, opts) => {
      home = opts.env["HOME"] ?? "";
      throw new Error("spawn EINVAL");
    };
    const r = await roleRunner(spawnThrows, () => scratch)("/g", "/d");
    expect(r).toMatchObject({ code: null, stdout: "", timedOut: false, overflow: false });
    expect(r.stderrTail).toBe("could not start the gateway: spawn EINVAL");
    expect(existsSync(home)).toBe(false);
  });
});
