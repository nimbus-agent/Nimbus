/**
 * `liveness-check` over real git with FAKE roles and a FAKE host probe injected: which packages are
 * checked, what each entry holds, and what is refused or left out. Nothing leaves the temp directory.
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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PACKAGE_BYTES,
  parseLivenessEntry,
  type RegistryIndex,
  signIndex,
  validatePublish,
} from "../../../registry-format/src/index.ts";
import * as gitTree from "./git-tree.ts";
import {
  LIVENESS_RUN_BUDGET_MS,
  type LivenessCheckDeps,
  newestStableVersions,
  runLivenessCheck,
} from "./liveness-check.ts";
import type { ActionIo } from "./report.ts";
import { type RoleRun, SCORE_MIN_RUN_MS } from "./score-role.ts";
import { runSign } from "./sign.ts";
import {
  copyRegistryRepo,
  git,
  makeExtension,
  makeRegistryRepo,
  originIndex,
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
const BASELINE = { scorer: 1 as const, passed: true as const, tools: 3 };

const run = (stdout: string): RoleRun => ({
  code: 0,
  stdout,
  stderrTail: "",
  timedOut: false,
  overflow: false,
});

let templateDir: string;
let template: RegistryRepo;

beforeAll(async () => {
  templateDir = mkdtempSync(join(tmpdir(), "nimbus-liveness-template-"));
  const scratch = join(templateDir, "scratch");
  mkdirSync(scratch);
  template = await makeRegistryRepo(join(templateDir, "reg"));
  const pubs = [
    { id: "acme/a", evals: { "basic.eval.json": SUITE } },
    { id: "acme/a", version: "0.9.0", evals: { "basic.eval.json": SUITE } },
    {
      id: "acme/a",
      version: "1.1.0",
      channel: "beta" as const,
      evals: { "basic.eval.json": SUITE },
    },
    { id: "acme/other", network: [] },
    { id: "acme/pack", starterPack: true },
  ];
  for (const o of pubs) writePublish(template.maintainer, await makeExtension(scratch, o));
  pushMaintainer(template, "main", "publish");
  const io: ActionIo = { annotate: () => {}, summary: () => {}, log: () => {} };
  await runSign(
    { workspace: template.workspace, rootKey: ROOT_KEY_INPUT },
    { validate: validatePublish, sign: signIndex, git: gitTree, io, tmpdir: () => scratch },
  );
});

afterAll(() => {
  rmSync(templateDir, { recursive: true, force: true });
});

let tmp: string;
let scratch: string;
let repo: RegistryRepo;
let gateway: string;
let out: string;
let logs: string[];
let calls: string[];
let probed: string[];
let nowMs: number;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-liveness-"));
  scratch = join(tmp, "scratch");
  mkdirSync(scratch);
  repo = copyRegistryRepo(template, join(tmp, "reg"));
  gateway = join(tmp, "nimbus-gateway");
  writeFileSync(gateway, "not run: the role is faked");
  out = join(tmp, "liveness-results.json");
  logs = [];
  calls = [];
  probed = [];
  nowMs = Date.parse("2026-11-02T10:00:00Z");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function idOf(dir: string): { id: string; version: string } {
  return JSON.parse(readFileSync(join(dir, "nimbus.extension.json"), "utf8")) as {
    id: string;
    version: string;
  };
}

function deps(over: Partial<LivenessCheckDeps> = {}): LivenessCheckDeps {
  return {
    git: gitTree,
    io: { annotate: () => {}, summary: () => {}, log: (l) => void logs.push(l) },
    tmpdir: () => scratch,
    now: () => nowMs,
    probe: {
      lookup: async (host) => {
        probed.push(host);
        return [{ address: "93.184.216.34", family: 4 }];
      },
      connect: async () => true,
    },
    runRole: async (_gw, dir) => {
      const m = idOf(dir);
      calls.push(`suite ${m.id}@${m.version}`);
      return run(
        `${JSON.stringify({ ok: true, extensionId: m.id, version: m.version, report: REPORT })}\n`,
      );
    },
    runBaseline: async (_gw, dir) => {
      const m = idOf(dir);
      calls.push(`baseline ${m.id}@${m.version}`);
      return run(
        `${JSON.stringify({ ok: true, extensionId: m.id, version: m.version, baseline: BASELINE })}\n`,
      );
    },
    ...over,
  };
}

const check = (over: Partial<LivenessCheckDeps> = {}, nimbusVersion = "10.14.1") =>
  runLivenessCheck({ workspace: repo.workspace, gateway, nimbusVersion, out }, deps(over));

describe("newestStableVersions", () => {
  test("picks the newest stable version per id, in id order, skipping non-semver", () => {
    const e = (channel: "stable" | "beta") => ({ channel }) as never;
    const index = {
      extensions: {
        "z/b": { versions: { "1.0.0": e("stable") } },
        "a/a": {
          versions: {
            "1.0.0": e("stable"),
            "1.10.0": e("stable"),
            "2.0.0": e("beta"),
            "not-semver": e("stable"),
          },
        },
        "m/only-beta": { versions: { "1.0.0": e("beta") } },
      },
    } as unknown as RegistryIndex;
    expect(newestStableVersions(index)).toEqual([
      { id: "a/a", version: "1.10.0" },
      { id: "z/b", version: "1.0.0" },
    ]);
  });
});

describe("runLivenessCheck", () => {
  test("entry shapes: A has hosts, tests and baseline; B baseline only; the starter pack nothing", async () => {
    const r = await check();
    expect(Object.keys(r.extensions).sort()).toEqual(["acme/a@1.0.0", "acme/other@1.0.0"]);
    expect(r.extensions["acme/a@1.0.0"]).toEqual({
      checkedAt: "2026-11-02T10:00:00.000Z",
      hosts: { declared: 1, answered: 1 },
      tests: { cases: 2, passed: 1 },
      baseline: BASELINE,
    });
    expect(r.extensions["acme/other@1.0.0"]).toEqual({
      checkedAt: "2026-11-02T10:00:00.000Z",
      baseline: BASELINE,
    });
    expect(r.nimbusVersion).toBe("10.14.1");
    expect(probed).toEqual(["api.example.com"]);
    for (const e of Object.values(r.extensions)) expect(parseLivenessEntry(e)).toEqual(e);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      format: 1,
      nimbusVersion: "10.14.1",
      extensions: r.extensions,
    });
  });

  test("only the newest stable version is checked: not the newer beta, not the older stable", async () => {
    await check();
    expect(calls.filter((c) => c.includes("acme/a@"))).toEqual([
      "baseline acme/a@1.0.0",
      "suite acme/a@1.0.0",
    ]);
  });

  test("a starter pack runs nothing", async () => {
    await check();
    expect(calls.some((c) => c.includes("acme/pack"))).toBe(false);
  });

  /** Replaces acme/a@1.0.0's package on gh-pages without touching the signed index. */
  function replaceAPackage(bytes: Uint8Array): void {
    const path = originIndex(repo).extensions["acme/a"]?.versions["1.0.0"]?.package ?? "";
    syncMaintainer(repo, "gh-pages");
    write(repo.maintainer, path, bytes);
    pushMaintainer(repo, "gh-pages", "tamper");
    git(repo.maintainer, "checkout", "-q", "main");
  }

  test("a package that differs from the index's hash gets no entry and a logged line", async () => {
    replaceAPackage(Uint8Array.from([0x1f, 0x8b, 1, 2, 3]));
    const r = await check();
    expect(Object.keys(r.extensions)).toEqual(["acme/other@1.0.0"]);
    expect(logs.some((l) => l.includes("acme/a@1.0.0") && l.includes("packageSha256"))).toBe(true);
    expect(calls.some((c) => c.includes("acme/a"))).toBe(false);
  });

  test("a blob that is not gzip data is refused before hashing", async () => {
    replaceAPackage(new TextEncoder().encode("tampered bytes"));
    const r = await check();
    expect(Object.keys(r.extensions)).toEqual(["acme/other@1.0.0"]);
    expect(logs.some((l) => l.includes("acme/a@1.0.0") && l.includes("is not gzip data"))).toBe(
      true,
    );
  });

  test("a blob over MAX_PACKAGE_BYTES is refused before hashing", async () => {
    const big = new Uint8Array(MAX_PACKAGE_BYTES + 1);
    big[0] = 0x1f;
    big[1] = 0x8b;
    replaceAPackage(big);
    const r = await check();
    expect(Object.keys(r.extensions)).toEqual(["acme/other@1.0.0"]);
    expect(logs.some((l) => l.includes("acme/a@1.0.0") && l.includes("is larger than"))).toBe(true);
  });

  test("a spent budget leaves later packages out, each logged", async () => {
    let t = nowMs;
    const r = await check({
      now: () => t,
      runBaseline: async (_gw, dir) => {
        const m = idOf(dir);
        t += LIVENESS_RUN_BUDGET_MS - SCORE_MIN_RUN_MS / 2; // the first package spends it
        return run(
          `${JSON.stringify({ ok: true, extensionId: m.id, version: m.version, baseline: BASELINE })}\n`,
        );
      },
    });
    expect(Object.keys(r.extensions)).toEqual(["acme/a@1.0.0"]);
    expect(r.extensions["acme/a@1.0.0"]?.tests).toBeUndefined();
    expect(logs.some((l) => l.includes("acme/other@1.0.0") && l.includes("budget"))).toBe(true);
  });

  test("a suite timeout reads run-timeout; a sandbox-unavailable role error reads sandbox-unavailable", async () => {
    const timeout = await check({
      runRole: async () => ({ ...run(""), code: null, timedOut: true }),
    });
    expect(timeout.extensions["acme/a@1.0.0"]?.tests).toEqual({ failure: "run-timeout" });

    const unavailable = await check({
      runRole: async (_gw, dir) => {
        const m = idOf(dir);
        return run(
          `${JSON.stringify({ ok: false, extensionId: m.id, version: m.version, error: { code: "ERR_EVAL_SANDBOX_UNAVAILABLE", message: "none" } })}\n`,
        );
      },
    });
    expect(unavailable.extensions["acme/a@1.0.0"]?.tests).toEqual({
      failure: "sandbox-unavailable",
    });

    const other = await check({ runRole: async () => ({ ...run(""), code: 1 }) });
    expect(other.extensions["acme/a@1.0.0"]?.tests).toEqual({ failure: "run-failed" });
  });

  const roleError = (dir: string, code: string): RoleRun => {
    const m = idOf(dir);
    return run(
      `${JSON.stringify({ ok: false, extensionId: m.id, version: m.version, error: { code, message: "x" } })}\n`,
    );
  };

  test("the probe spending the budget skips the baseline and suites; the hosts result is kept", async () => {
    let t = nowMs;
    const r = await check({
      now: () => t,
      probe: {
        lookup: async () => {
          t += LIVENESS_RUN_BUDGET_MS - 1_000;
          return [{ address: "93.184.216.34", family: 4 }];
        },
        connect: async () => true,
      },
    });
    expect(r.extensions["acme/a@1.0.0"]).toEqual({
      checkedAt: "2026-11-02T10:00:00.000Z",
      hosts: { declared: 1, answered: 1 },
    });
    expect(calls).toEqual([]);
    expect(logs.some((l) => l.includes("acme/a@1.0.0") && l.includes("budget is spent"))).toBe(
      true,
    );
  });

  test("a budget-shortened suite that times out is not recorded; a full-cap timeout is run-timeout", async () => {
    let t = nowMs;
    const shortened = await check({
      now: () => t,
      runBaseline: async (_gw, dir) => {
        t += LIVENESS_RUN_BUDGET_MS - 90_000; // leaves 90 s: over the suite minimum, under its cap
        return deps().runBaseline(_gw, dir);
      },
      runRole: async () => ({ ...run(""), code: null, timedOut: true }),
    });
    expect(shortened.extensions["acme/a@1.0.0"]?.baseline).toEqual(BASELINE);
    expect(shortened.extensions["acme/a@1.0.0"]?.tests).toBeUndefined();
    expect(logs.some((l) => l.includes("budget-shortened run timed out; not recorded"))).toBe(true);

    nowMs = Date.parse("2026-11-02T10:00:00Z");
    const full = await check({ runRole: async () => ({ ...run(""), code: null, timedOut: true }) });
    expect(full.extensions["acme/a@1.0.0"]?.tests).toEqual({ failure: "run-timeout" });
  });

  test("a role-reported ERR_EVAL_TIMEOUT follows the same ruling as a runner timeout", async () => {
    const full = await check({ runRole: async (_gw, dir) => roleError(dir, "ERR_EVAL_TIMEOUT") });
    expect(full.extensions["acme/a@1.0.0"]?.tests).toEqual({ failure: "run-timeout" });

    let t = nowMs;
    const shortened = await check({
      now: () => t,
      runBaseline: async (_gw, dir) => {
        t += LIVENESS_RUN_BUDGET_MS - 90_000;
        return deps().runBaseline(_gw, dir);
      },
      runRole: async (_gw, dir) => roleError(dir, "ERR_EVAL_TIMEOUT"),
    });
    expect(shortened.extensions["acme/a@1.0.0"]?.tests).toBeUndefined();
  });

  test("a budget-shortened baseline that times out is not recorded", async () => {
    let t = nowMs;
    const r = await check({
      now: () => t,
      probe: {
        lookup: async () => {
          t += LIVENESS_RUN_BUDGET_MS - 150_000; // 150 s left: over the baseline minimum, under its cap
          return [{ address: "93.184.216.34", family: 4 }];
        },
        connect: async () => true,
      },
      runBaseline: async () => ({ ...run(""), code: null, timedOut: true }),
    });
    expect(r.extensions["acme/a@1.0.0"]?.baseline).toBeUndefined();
    expect(r.extensions["acme/a@1.0.0"]?.hosts).toEqual({ declared: 1, answered: 1 });
    expect(logs.some((l) => l.includes("baseline: budget-shortened run timed out"))).toBe(true);
  });

  test("a baseline that cannot be obtained is left out of the entry", async () => {
    const r = await check({ runBaseline: async () => ({ ...run(""), code: 2 }) });
    expect(Object.keys(r.extensions)).toEqual(["acme/a@1.0.0"]);
    expect(r.extensions["acme/a@1.0.0"]?.baseline).toBeUndefined();
  });

  test.each(["", "v10.15.0", "10.15", "10.14.1\nx", "../1.0.0"])(
    "an invalid nimbus-version %p is refused before any work",
    async (v) => {
      await expect(check({}, v)).rejects.toThrow('input "nimbus-version"');
      expect(calls).toEqual([]);
      expect(() => readFileSync(out)).toThrow();
    },
  );

  test("a relative gateway is refused", async () => {
    await expect(
      runLivenessCheck(
        { workspace: repo.workspace, gateway: "nimbus-gateway", nimbusVersion: "10.14.1", out },
        deps(),
      ),
    ).rejects.toThrow('input "nimbus-gateway" must be an absolute path');
  });
});
