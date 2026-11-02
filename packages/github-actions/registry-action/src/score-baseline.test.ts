/**
 * The baseline run's judge, and the runner that adds `--baseline`. The role is faked here; the one
 * test over a real role lives in `score.real.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type RoleRun, type RoleSpawnOptions, roleRunner } from "./score.ts";
import {
  BASELINE_MIN_RUN_MS,
  BASELINE_ROLE_TIMEOUT_MS,
  baselineRoleRunner,
  judgeBaselineRun,
} from "./score-baseline.ts";

const WANT = { id: "acme/x", version: "1.0.0" };

const run = (over: Partial<RoleRun> = {}): RoleRun => ({
  code: 0,
  stdout: "",
  stderrTail: "",
  timedOut: false,
  overflow: false,
  ...over,
});

const doc = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;
const good = doc({
  ok: true,
  extensionId: "acme/x",
  version: "1.0.0",
  baseline: { scorer: 1, passed: true, tools: 3 },
});

describe("judgeBaselineRun", () => {
  test("a good document for this id and version is its baseline", () => {
    expect(judgeBaselineRun(run({ stdout: good }), WANT)).toEqual({
      baseline: { scorer: 1, passed: true, tools: 3 },
    });
  });

  test("a failed baseline is still a baseline, a displayed fact", () => {
    const failed = doc({
      ok: true,
      extensionId: "acme/x",
      version: "1.0.0",
      baseline: { scorer: 1, passed: false, tools: 0, failure: "no-listing" },
    });
    expect(judgeBaselineRun(run({ stdout: failed }), WANT)).toEqual({
      baseline: { scorer: 1, passed: false, tools: 0, failure: "no-listing" },
    });
  });

  test("a document for another <id>@<version> is ERR_EVAL_IDENTITY_MISMATCH", () => {
    const other = doc({
      ok: true,
      extensionId: "acme/y",
      version: "1.0.0",
      baseline: { scorer: 1, passed: true, tools: 1 },
    });
    const r = judgeBaselineRun(run({ stdout: other }), WANT);
    expect("error" in r && r.error.code).toBe("ERR_EVAL_IDENTITY_MISMATCH");
  });

  test("an old gateway (exit 2, empty stdout, a usage line) is an error naming the exit", () => {
    const r = judgeBaselineRun(
      run({
        code: 2,
        stderrTail: "usage: __nimbus-eval --package <absolute dir> [--suite <file>]\n",
      }),
      WANT,
    );
    expect("error" in r && r.error.code).toBe("ERR_EVAL_ROLE_FAILED");
    expect("error" in r && r.error.message).toContain("exited 2");
  });

  test("two lines, garbage or an empty stdout are ERR_EVAL_BAD_OUTPUT", () => {
    for (const stdout of [`${good}${good}`, "not json\n", "", '{"ok":true}\n']) {
      const r = judgeBaselineRun(run({ stdout }), WANT);
      expect("error" in r && r.error.code).toBe("ERR_EVAL_BAD_OUTPUT");
    }
  });

  test("the role's ok:false document is an error with the role's code", () => {
    const refused = doc({
      ok: false,
      error: { code: "ERR_EVAL_SANDBOX_UNAVAILABLE", message: "no sandbox here" },
    });
    expect(judgeBaselineRun(run({ stdout: refused }), WANT)).toEqual({
      error: { code: "ERR_EVAL_SANDBOX_UNAVAILABLE", message: "no sandbox here" },
    });
  });

  test("timedOut and overflow are each an error, never a baseline", () => {
    const t = judgeBaselineRun(run({ code: null, timedOut: true, stdout: good }), WANT);
    expect("error" in t && t.error.code).toBe("ERR_EVAL_TIMEOUT");
    const o = judgeBaselineRun(run({ overflow: true, stdout: good }), WANT);
    expect("error" in o && o.error.code).toBe("ERR_EVAL_OUTPUT_TOO_LARGE");
  });

  test("an error message from the role's stderr is one clipped line", () => {
    const r = judgeBaselineRun(
      run({ code: 1, stderrTail: `first\n::error::injected\r\n${"x".repeat(5000)}` }),
      WANT,
    );
    const message = "error" in r ? r.error.message : "";
    expect(message).not.toMatch(/[\r\n]/);
    expect(message.length).toBeLessThanOrEqual(1000);
  });
});

describe("baselineRoleRunner", () => {
  test("spawns the same role with --baseline, and defaults to the baseline's own deadline", async () => {
    expect(BASELINE_ROLE_TIMEOUT_MS).toBe(3 * 60_000);
    expect(BASELINE_MIN_RUN_MS).toBe(120_000);
    const calls: { args: string[]; opts: RoleSpawnOptions }[] = [];
    const spawnFake = (_file: string, args: string[], opts: RoleSpawnOptions) => {
      calls.push({ args, opts });
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      child["pid"] = undefined;
      child["stdout"] = new PassThrough();
      child["stderr"] = new PassThrough();
      child["kill"] = () => true;
      queueMicrotask(() => {
        (child["stdout"] as PassThrough).end();
        (child["stderr"] as PassThrough).end();
        child.emit("exit", 0, null);
        child.emit("close");
      });
      return child as never;
    };
    await baselineRoleRunner(
      spawnFake,
      () => process.cwd(),
      () => {},
    )("/abs/gw", "/work/x");
    await roleRunner(
      spawnFake,
      () => process.cwd(),
      () => {},
    )("/abs/gw", "/work/x");
    expect(calls[0]?.args).toEqual([
      "__nimbus-eval",
      "--package",
      "/work/x",
      "--baseline",
      "--json",
    ]);
    expect(calls[1]?.args).toEqual(["__nimbus-eval", "--package", "/work/x", "--json"]);
    expect(calls[0]?.opts.env).toEqual({
      PATH: process.env["PATH"] ?? "",
      HOME: calls[0]?.opts.env["HOME"] ?? "",
    });
  });
});
