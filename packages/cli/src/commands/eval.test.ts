import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  EVAL_ROLE_STDOUT_MAX_BYTES,
  type EvalCliDeps,
  type EvalSpawnResult,
  parseEvalRoleDocument,
  runEval,
  spawnEvalRole,
} from "./eval.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function report(): Record<string, unknown> {
  return {
    scorer: 1,
    score: 50,
    cases: 2,
    passed: 1,
    rubrics: {
      exact: { cases: 2, passed: 1 },
      "json-match": { cases: 0, passed: 0 },
      "one-of": { cases: 0, passed: 0 },
    },
    results: [
      { suite: "evals/a.eval.json", case: "one", rubric: "exact", pass: true, reason: null },
      {
        suite: "evals/a.eval.json",
        case: "two",
        rubric: "exact",
        pass: false,
        reason: "wrong text",
      },
    ],
  };
}
const okDoc = (): Record<string, unknown> => ({
  ok: true,
  extensionId: "acme/tool",
  version: "1.0.0",
  report: report(),
});

function harness(
  spawn: Partial<EvalSpawnResult> | Error,
  launch: EvalCliDeps["launch"] = () => ({ ok: true, cmd: ["gw", "--x"], cwd: "/w" }),
) {
  const logs: string[] = [];
  const errs: string[] = [];
  const calls: { cmd: string[]; cwd: string | undefined; timeoutMs: number }[] = [];
  const deps: EvalCliDeps = {
    launch,
    spawnRole: async (cmd, cwd, timeoutMs) => {
      calls.push({ cmd, cwd, timeoutMs });
      if (spawn instanceof Error) throw spawn;
      return {
        code: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        timedOut: false,
        ...spawn,
      };
    },
    log: (s) => logs.push(s),
    err: (s) => errs.push(s),
  };
  return { deps, logs, errs, calls };
}

describe("runEval", () => {
  test("success renders the score and exits 0; argv ends with the role args", async () => {
    const h = harness({ stdout: enc(JSON.stringify(okDoc())) });
    expect(await runEval(["--package", "pkgdir"], h.deps)).toBe(0);
    const out = h.logs.join("\n");
    expect(out).toContain("evals/a.eval.json: 1/2");
    expect(out).toContain("FAIL evals/a.eval.json two: wrong text");
    expect(out).toContain("score 50/100 (1 of 2 cases)");
    expect(out).toContain("measured locally; a registry's published score is measured by its CI");
    expect(h.calls[0]?.cmd).toEqual(["gw", "--x", "__nimbus-eval", "--package", resolve("pkgdir")]);
    expect(h.calls[0]?.cwd).toBe("/w");
    expect(h.calls[0]?.timeoutMs).toBe(12 * 60 * 1000);
  });

  test("--suite is forwarded", async () => {
    const h = harness({ stdout: enc(JSON.stringify(okDoc())) });
    await runEval(["--package", "p", "--suite", "evals/a.eval.json"], h.deps);
    expect(h.calls[0]?.cmd.slice(-2)).toEqual(["--suite", "evals/a.eval.json"]);
  });

  test("--json prints the document verbatim", async () => {
    const text = JSON.stringify(okDoc());
    const h = harness({ stdout: enc(`${text}\n`) });
    expect(await runEval(["--package", "p", "--json"], h.deps)).toBe(0);
    expect(h.logs).toEqual([text]);
  });

  test("ok:false exits 2 with the code and the stderr tail", async () => {
    const doc = { ok: false, error: { code: "ERR_X", message: "boom" } };
    const h = harness({ stdout: enc(JSON.stringify(doc)), stderr: enc("child said hi\n") });
    expect(await runEval(["--package", "p"], h.deps)).toBe(2);
    expect(h.errs).toEqual(["eval failed: ERR_X: boom", "child said hi"]);
  });

  test.each([
    ["garbage stdout", { stdout: enc("not json") }],
    ["empty stdout with exit 0", { stdout: new Uint8Array(), code: 0 }],
    ["nonzero exit with no document", { stdout: new Uint8Array(), code: 1 }],
    ["oversized stdout", { stdout: new Uint8Array(EVAL_ROLE_STDOUT_MAX_BYTES + 1) }],
    ["timeout", { timedOut: true }],
  ])("%s exits 2", async (_n, spawn) => {
    const h = harness(spawn);
    expect(await runEval(["--package", "p"], h.deps)).toBe(2);
    expect(h.errs[0]).toStartWith("eval failed:");
    expect(h.logs).toEqual([]);
  });

  test("a launch plan failure exits 2 with its message", async () => {
    const h = harness({}, () => ({ ok: false, message: "no gateway" }));
    expect(await runEval(["--package", "p"], h.deps)).toBe(2);
    expect(h.errs).toEqual(["eval failed: no gateway"]);
    expect(h.calls).toEqual([]);
  });

  test("usage errors exit 2", async () => {
    for (const args of [[], ["--package"], ["--package", "--json"], ["--bogus"]]) {
      const h = harness({});
      expect(await runEval(args, h.deps)).toBe(2);
      expect(h.errs.join("\n")).toContain("usage: nimbus eval --package");
      expect(h.calls).toEqual([]);
    }
  });

  test("--extension and --installed are not available yet", async () => {
    for (const flag of ["--extension", "--installed"]) {
      const h = harness({});
      expect(await runEval([flag, "x"], h.deps)).toBe(2);
      expect(h.errs[0]).toContain("not available yet");
    }
  });
});

describe("parseEvalRoleDocument", () => {
  test("accepts both document shapes", () => {
    expect(parseEvalRoleDocument(JSON.stringify(okDoc()))?.ok).toBe(true);
    expect(parseEvalRoleDocument('{"ok":false,"error":{"code":"a","message":"b"}}')?.ok).toBe(
      false,
    );
  });

  test("rejects invalid documents", () => {
    const bad = (mut: (d: Record<string, unknown>) => void): void => {
      const d = okDoc();
      mut(d);
      expect(parseEvalRoleDocument(JSON.stringify(d))).toBeNull();
    };
    expect(parseEvalRoleDocument("[]")).toBeNull();
    expect(parseEvalRoleDocument('{"ok":1}')).toBeNull();
    expect(parseEvalRoleDocument('{"ok":false}')).toBeNull();
    expect(parseEvalRoleDocument('{"ok":false,"error":{"code":1,"message":"b"}}')).toBeNull();
    bad((d) => {
      d["extensionId"] = 5;
    });
    bad((d) => {
      d["version"] = undefined;
    });
    bad((d) => {
      d["report"] = null;
    });
    bad((d) => {
      (d["report"] as Record<string, unknown>)["results"] = "x";
    });
    bad((d) => {
      (d["report"] as Record<string, unknown>)["results"] = [{ suite: 1 }];
    });
    bad((d) => {
      (d["report"] as Record<string, unknown>)["score"] = 99;
    });
  });
});

describe("spawnEvalRole (real child)", () => {
  const run = (script: string, timeoutMs = 20_000) =>
    spawnEvalRole([process.execPath, "-e", script], undefined, timeoutMs);

  test("captures stdout, stderr and the exit code", async () => {
    const r = await run('process.stdout.write("doc"); console.error("tail"); process.exit(3)');
    expect(new TextDecoder().decode(r.stdout)).toBe("doc");
    expect(new TextDecoder().decode(r.stderr).trim()).toBe("tail");
    expect(r.code).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  test("keeps only the last 64 KiB of stderr", async () => {
    const r = await run('process.stderr.write("a".repeat(100000) + "END")');
    expect(r.stderr.byteLength).toBe(64 * 1024);
    expect(new TextDecoder().decode(r.stderr).endsWith("END")).toBe(true);
  });

  test("kills a child whose stdout overflows the cap", async () => {
    const r = await run(
      'const c="x".repeat(1<<20); for(let i=0;i<40;i++){process.stdout.write(c)} setInterval(()=>{},1000)',
    );
    expect(r.stdout.byteLength).toBeGreaterThan(EVAL_ROLE_STDOUT_MAX_BYTES);
  });

  test("kills a child past the wall-clock deadline", async () => {
    const r = await run("setInterval(()=>{},1000)", 300);
    expect(r.timedOut).toBe(true);
  });

  test("a command that cannot start is reported, not thrown", async () => {
    const r = await spawnEvalRole(["definitely-not-a-real-binary-xyz"], undefined, 1000);
    expect(r.code).toBeNull();
    expect(new TextDecoder().decode(r.stderr)).toContain("could not start the gateway");
  });
});
