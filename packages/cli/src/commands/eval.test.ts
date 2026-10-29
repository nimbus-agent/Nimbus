import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { type EvalCaseOutcome, scoreEval } from "@nimbus-dev/registry-format";
import {
  type ByteKeeper,
  EVAL_ROLE_STDOUT_MAX_BYTES,
  type EvalCliDeps,
  type EvalSpawnResult,
  firstBytesKeeper,
  lastBytesKeeper,
  packageRelativeSuite,
  parseEvalRoleDocument,
  readCapped,
  runEval,
  spawnEvalRole,
  spawnEvalRoleWithGrace,
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

  test.each([
    ["a Windows separator", "evals\\a.eval.json"],
    ["a leading ./", "./evals/a.eval.json"],
    ["an absolute path inside the package", join(resolve("p"), "evals", "a.eval.json")],
  ])("--suite with %s is passed package-relative and POSIX", async (_n, suite) => {
    const h = harness({ stdout: enc(JSON.stringify(okDoc())) });
    await runEval(["--package", "p", "--suite", suite], h.deps);
    expect(h.calls[0]?.cmd.slice(-2)).toEqual(["--suite", "evals/a.eval.json"]);
  });

  test("--json prints the document verbatim", async () => {
    const text = JSON.stringify(okDoc());
    const h = harness({ stdout: enc(`${text}\n`) });
    expect(await runEval(["--package", "p", "--json"], h.deps)).toBe(0);
    expect(h.logs).toEqual([text]);
  });

  test("--json on an eval error prints the role's error document on stdout, exit 2", async () => {
    const doc = { ok: false, error: { code: "ERR_X", message: "boom" } };
    const h = harness({ stdout: enc(`${JSON.stringify(doc)}\n`), stderr: enc("child said hi\n") });
    expect(await runEval(["--package", "p", "--json"], h.deps)).toBe(2);
    expect(h.logs).toEqual([JSON.stringify(doc)]);
    expect(h.errs).toEqual(["child said hi"]);
  });

  test.each([
    ["no document", { stdout: enc("not json") }, "ERR_EVAL_NO_DOCUMENT"],
    ["a timeout", { timedOut: true }, "ERR_EVAL_WALL_CLOCK"],
    [
      "oversized output",
      { stdout: new Uint8Array(EVAL_ROLE_STDOUT_MAX_BYTES + 1) },
      "ERR_EVAL_OUTPUT_TOO_LARGE",
    ],
  ])("--json with %s prints a JSON error document on stdout, exit 2", async (_n, spawn, code) => {
    const h = harness(spawn);
    expect(await runEval(["--package", "p", "--json"], h.deps)).toBe(2);
    expect(h.logs).toHaveLength(1);
    const printed = JSON.parse(h.logs[0] ?? "") as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(printed.ok).toBe(false);
    expect(printed.error.code).toBe(code);
    expect(printed.error.message.length).toBeGreaterThan(0);
    expect(h.errs.join("\n")).not.toContain("eval failed");
  });

  test("--json with a launch failure prints a JSON error document", async () => {
    const h = harness({}, () => ({ ok: false, message: "no gateway" }));
    expect(await runEval(["--package", "p", "--json"], h.deps)).toBe(2);
    expect(JSON.parse(h.logs[0] ?? "")).toEqual({
      ok: false,
      error: { code: "ERR_EVAL_LAUNCH", message: "no gateway" },
    });
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

  test("--package prose carries no raw control characters from the role document", async () => {
    const evil = "\u001b[2K\u009b2J\nX";
    const r = report();
    const results = (r["results"] as Record<string, unknown>[]).map((x) => ({
      ...x,
      case: `${String(x["case"])}${evil}`,
    }));
    const doc = { ...okDoc(), extensionId: `acme/tool${evil}`, report: { ...r, results } };
    const bad = { ok: false, error: { code: `ERR_X${evil}`, message: `boom${evil}` } };
    const outputs: string[] = [];
    for (const d of [doc, bad]) {
      const h = harness({ stdout: enc(JSON.stringify(d)), stderr: enc(`tail${evil}\nline2`) });
      await runEval(["--package", "p"], h.deps);
      outputs.push(...h.logs, ...h.errs);
    }
    const all = outputs.join("");
    expect(all).toContain("two");
    expect(all).toContain("boom");
    expect(all).not.toContain("\u001b");
    expect(all).not.toContain("\u009b");
    // Only the failure prints the stderr tail; it keeps its line breaks, every line stripped.
    expect(outputs.filter((l) => l.includes("\n"))).toEqual(["tail[2K2J\nX\nline2"]);
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

  test("--installed is not available yet", async () => {
    const h = harness({});
    expect(await runEval(["--installed"], h.deps)).toBe(2);
    expect(h.errs[0]).toContain("not available yet");
  });
});

function ipcEntry(): Record<string, unknown> {
  return { id: "acme/tool", version: "1.0.0", ok: true, report: report() };
}

function extHarness(opts: {
  raw?: unknown;
  entry?: Record<string, unknown>;
  rpcError?: Error;
  tty?: boolean;
}) {
  const h = harness({});
  const rpc: { method: string; params: unknown }[] = [];
  let connects = 0;
  const deps: EvalCliDeps = {
    ...h.deps,
    isTTY: () => opts.tty ?? true,
    withClient: async (fn) => {
      connects += 1;
      return await fn(async <T>(method: string, params: unknown) => {
        rpc.push({ method, params });
        if (opts.rpcError) throw opts.rpcError;
        if ("raw" in opts) return opts.raw as T;
        return { results: [opts.entry ?? ipcEntry()] } as T;
      });
    },
  };
  return { deps, logs: h.logs, errs: h.errs, rpc, connects: () => connects };
}

describe("runEval --extension", () => {
  test("renders the report through the shared renderer and exits 0", async () => {
    const h = extHarness({});
    expect(await runEval(["--extension", "acme/tool"], h.deps)).toBe(0);
    expect(h.rpc).toEqual([{ method: "extension.eval", params: { ids: ["acme/tool"] } }]);
    const out = h.logs.join("\n");
    expect(out).toContain("acme/tool 1.0.0");
    expect(out).toContain("evals/a.eval.json: 1/2");
    expect(out).toContain("FAIL evals/a.eval.json two: wrong text");
    expect(out).toContain("score 50/100 (1 of 2 cases)");
  });

  test("--json prints the result entry", async () => {
    const h = extHarness({});
    expect(await runEval(["--extension", "acme/tool", "--json"], h.deps)).toBe(0);
    expect(JSON.parse(h.logs[0] ?? "")).toEqual(ipcEntry());
  });

  test("a per-id error exits 2 as `eval failed: CODE: message`", async () => {
    const entry = {
      id: "acme/tool",
      version: null,
      ok: false,
      error: { code: "ERR_X", message: "nope" },
    };
    const h = extHarness({ entry });
    expect(await runEval(["--extension", "acme/tool"], h.deps)).toBe(2);
    expect(h.errs.join("\n")).toContain("eval failed: ERR_X: nope");
    const j = extHarness({ entry });
    expect(await runEval(["--extension", "acme/tool", "--json"], j.deps)).toBe(2);
    expect(JSON.parse(j.logs[0] ?? "")).toEqual(entry);
  });

  test("prose output carries no raw control characters from the extension or the gateway", async () => {
    const evil = "\u001b[2K\u009b2J\nX";
    const hostile = (s: string): string => `${s}${evil}`;
    const r = report();
    const results = (r["results"] as Record<string, unknown>[]).map((x) => ({
      ...x,
      suite: hostile("evals/a.eval.json"),
      case: hostile(String(x["case"])),
      reason: x["reason"] === null ? null : hostile(String(x["reason"])),
    }));
    const okEntry = {
      id: "acme/tool",
      version: hostile("1.0.0"),
      ok: true,
      report: { ...r, results },
    };
    const failEntry = {
      id: "acme/tool",
      version: hostile("1.0.0"),
      ok: false,
      error: { code: hostile("ERR_X"), message: hostile("takedown reason") },
    };
    const outputs: string[] = [];
    for (const opts of [
      { entry: okEntry },
      { entry: failEntry },
      { rpcError: new Error(hostile("gateway said no")) },
    ]) {
      const h = extHarness(opts);
      await runEval(["--extension", "acme/tool"], h.deps);
      outputs.push(...h.logs, ...h.errs);
    }
    const all = outputs.join("");
    expect(all).toContain("two");
    expect(all).toContain("takedown reason");
    expect(all).toContain("gateway said no");
    expect(all).not.toContain("\u001b");
    expect(all).not.toContain("\u009b");
    expect(all).not.toContain("\n");
  });

  test("--json keeps the gateway's strings verbatim (JSON escaping is line-safe)", async () => {
    const entry = {
      id: "acme/tool",
      version: null,
      ok: false,
      error: { code: "ERR_X", message: "a\u001b[2K\nb" },
    };
    const h = extHarness({ entry });
    expect(await runEval(["--extension", "acme/tool", "--json"], h.deps)).toBe(2);
    expect(h.logs[0]).not.toContain("\n");
    expect(JSON.parse(h.logs[0] ?? "")).toEqual(entry);
  });

  test("the id is trimmed before it is sent and compared", async () => {
    const h = extHarness({});
    expect(await runEval(["--extension", "  acme/tool "], h.deps)).toBe(0);
    expect(h.rpc).toEqual([{ method: "extension.eval", params: { ids: ["acme/tool"] } }]);
  });

  test("a denied approval exits 2", async () => {
    const h = extHarness({ rpcError: new Error("ERR_EXTENSION_EVAL_NOT_APPROVED: denied") });
    expect(await runEval(["--extension", "acme/tool"], h.deps)).toBe(2);
    expect(h.errs.join("\n")).toContain("ERR_EXTENSION_EVAL_NOT_APPROVED");
  });

  test("--yes / -y and non-TTY are refused before connecting", async () => {
    for (const [args, tty] of [
      [["--extension", "a/b", "--yes"], true],
      [["--extension", "a/b", "-y"], true],
      [["--extension", "a/b"], false],
    ] as const) {
      const h = extHarness({ tty });
      expect(await runEval([...args], h.deps)).toBe(2);
      expect(h.connects()).toBe(0);
      expect(h.errs.length).toBeGreaterThan(0);
    }
  });

  test.each([
    ["null results", { results: null }],
    ["empty results", { results: [] }],
    ["not an object", "nope"],
    ["wrong id", { results: [{ ...ipcEntry(), id: "other/ext" }] }],
    ["ok without report", { results: [{ id: "acme/tool", version: "1.0.0", ok: true }] }],
    [
      "report whose score disagrees with its counts",
      { results: [{ ...ipcEntry(), report: { ...report(), score: 99 } }] },
    ],
    ["not ok without error", { results: [{ id: "acme/tool", version: null, ok: false }] }],
    ["a string entry", { results: ["acme/tool"] }],
  ])("malformed answer (%s) exits 2 as ERR_EVAL_BAD_RESPONSE", async (_n, raw) => {
    const h = extHarness({ raw });
    expect(await runEval(["--extension", "acme/tool"], h.deps)).toBe(2);
    expect(h.errs.join("\n")).toContain("eval failed");
    const j = extHarness({ raw });
    expect(await runEval(["--extension", "acme/tool", "--json"], j.deps)).toBe(2);
    expect(JSON.parse(j.logs[0] ?? "").error.code).toBe("ERR_EVAL_BAD_RESPONSE");
  });

  test.each([
    [["--extension", "-y"]],
    [["--extension"]],
    [["--extension", "--json"]],
    [["--extension", "a/b", "--package", "p"]],
    [["--extension", "a/b", "--suite", "s"]],
  ])("usage error %p", async (args) => {
    const h = extHarness({});
    expect(await runEval([...args], h.deps)).toBe(2);
    expect(h.connects()).toBe(0);
    expect(h.errs.join("\n")).toContain("usage:");
  });
});

describe("packageRelativeSuite", () => {
  const pkg = resolve("some-pkg");
  test.each([
    ["evals/x.eval.json", "evals/x.eval.json"],
    ["evals\\x.eval.json", "evals/x.eval.json"],
    ["./evals/x.eval.json", "evals/x.eval.json"],
    [".\\evals\\x.eval.json", "evals/x.eval.json"],
    [join(pkg, "evals", "x.eval.json"), "evals/x.eval.json"],
  ])("%s -> %s", (suite, want) => {
    expect(packageRelativeSuite(pkg, suite)).toBe(want);
  });

  test("a path outside the package is passed on (POSIX) for the role to refuse", () => {
    expect(packageRelativeSuite(pkg, "../elsewhere/x.eval.json")).toBe("../elsewhere/x.eval.json");
    const outside = join(resolve("other"), "x.eval.json");
    expect(packageRelativeSuite(pkg, outside)).toBe(outside.replaceAll("\\", "/"));
  });
});

describe("parseEvalRoleDocument", () => {
  test("accepts a report built by the real registry-format scorer", () => {
    const outcomes: EvalCaseOutcome[] = [
      { suite: "evals/a.eval.json", case: "one", rubric: "exact", pass: true, reason: null },
      { suite: "evals/a.eval.json", case: "two", rubric: "json-match", pass: false, reason: "x" },
      { suite: "evals/b.eval.json", case: "three", rubric: "one-of", pass: true, reason: null },
    ];
    const report = scoreEval(outcomes);
    expect(report).not.toBeNull();
    const text = JSON.stringify({ ok: true, extensionId: "acme.x", version: "1.0.0", report });
    const doc = parseEvalRoleDocument(text);
    expect(doc?.ok).toBe(true);
    if (doc?.ok !== true) return;
    expect(doc.report).toEqual(JSON.parse(JSON.stringify(report)));
  });

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
    bad((d) => {
      const rep = d["report"] as { results: unknown[] };
      rep.results = rep.results.slice(1);
    });
    bad((d) => {
      const rep = d["report"] as { results: { pass: boolean }[] };
      for (const r of rep.results) r.pass = true;
    });
  });
});

// Real-child spawns hang under macOS `--parallel` (oven-sh/bun#41024); Linux and Windows cover them.
describe.skipIf(process.platform === "darwin")("spawnEvalRole (real child)", () => {
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

  test("keeps exactly the last 64 KiB when stderr arrives in many small chunks", async () => {
    const r = await run(
      "for(let i=0;i<5000;i++){process.stderr.write(String(i%10).repeat(40)+String.fromCharCode(10))}",
    );
    expect(r.stderr.byteLength).toBe(64 * 1024);
    const full = Array.from(
      { length: 5000 },
      (_, i) => `${String(i % 10).repeat(40)}
`,
    ).join("");
    expect(new TextDecoder().decode(r.stderr)).toBe(full.slice(full.length - 64 * 1024));
  });

  test("does not wait forever on a pipe a grandchild still holds", async () => {
    const t0 = Date.now();
    const r = await spawnEvalRoleWithGrace(
      [
        process.execPath,
        "-e",
        'Bun.spawn([process.execPath,"-e","setTimeout(()=>{},6000)"],{stdio:["ignore","inherit","inherit"]}).unref(); process.stdout.write("hi")',
      ],
      undefined,
      20_000,
      200,
    );
    expect(Date.now() - t0).toBeLessThan(4500);
    expect(new TextDecoder().decode(r.stdout)).toBe("hi");
  });

  test("a clean exit leaves no grace timer holding the caller's process open", async () => {
    // A child PROCESS calls spawnEvalRoleWithGrace with a 10 s grace on a child that exits at
    // once: the call returns at EOF either way, but a pending grace timer would keep that
    // process alive for the full 10 s after it.
    const evalModule = join(import.meta.dir, "eval.ts").replaceAll("\\", "/");
    const script = [
      `import { spawnEvalRoleWithGrace } from ${JSON.stringify(evalModule)};`,
      `const r = await spawnEvalRoleWithGrace([process.execPath, "-e", "process.stdout.write('x')"], undefined, 20000, 10000);`,
      `process.stdout.write(new TextDecoder().decode(r.stdout));`,
    ].join("\n");
    const t0 = Date.now();
    const outer = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
    const [out, code] = await Promise.all([new Response(outer.stdout).text(), outer.exited]);
    expect(code).toBe(0);
    expect(out).toBe("x");
    expect(Date.now() - t0).toBeLessThan(7000);
  }, 20_000);

  test("a child that overflows stdout and ignores the kill is killed hard after the grace", async () => {
    // Before, an overflow sent only the soft kill: a child ignoring it ran on to the wall clock.
    const t0 = Date.now();
    const r = await spawnEvalRoleWithGrace(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM",()=>{}); const c="x".repeat(1<<20); for(let i=0;i<40;i++){process.stdout.write(c)} setInterval(()=>{},1000)',
      ],
      undefined,
      30_000,
      300,
    );
    expect(r.stdout.byteLength).toBeGreaterThan(EVAL_ROLE_STDOUT_MAX_BYTES);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 40_000);

  test("a child that ignores the wall-clock kill is killed hard after the grace", async () => {
    const t0 = Date.now();
    const r = await spawnEvalRoleWithGrace(
      [
        process.execPath,
        "-e",
        'process.on("SIGTERM",()=>{}); process.stdout.write("up"); setInterval(()=>{},1000)',
      ],
      undefined,
      500,
      300,
    );
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(8000);
  }, 20_000);
});

describe("readCapped and its keepers", () => {
  /** A stream of `count` chunks of `size` bytes, chunk i filled with `i % 251`. */
  function chunkStream(count: number, size: number): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i === count) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(size).fill(i % 251));
        i += 1;
      },
    });
  }

  const never = new Promise<void>(() => {});

  test("the last-bytes keeper never retains more than max + one chunk over 10 000 chunks", async () => {
    const max = 1000;
    const chunk = 7;
    const inner = lastBytesKeeper(max);
    let peak = 0;
    const spy: ByteKeeper = {
      push: (c) => {
        inner.push(c);
        peak = Math.max(peak, inner.retained());
      },
      retained: () => inner.retained(),
      overflowed: () => inner.overflowed(),
      bytes: () => inner.bytes(),
    };
    const out = await readCapped(chunkStream(10_000, chunk), spy, never);
    expect(peak).toBeLessThanOrEqual(max + chunk);
    expect(out.byteLength).toBe(max);
    // The tail is exactly the last `max` bytes of the stream.
    const full = new Uint8Array(10_000 * chunk);
    for (let i = 0; i < 10_000; i++) full.fill(i % 251, i * chunk, (i + 1) * chunk);
    expect(out).toEqual(full.subarray(full.byteLength - max));
  });

  test("the first-bytes keeper reports overflow once and stops retaining", async () => {
    let overflows = 0;
    const keeper = firstBytesKeeper(100, () => {
      overflows += 1;
    });
    const out = await readCapped(chunkStream(50, 10), keeper, never);
    expect(overflows).toBe(1);
    expect(keeper.overflowed()).toBe(true);
    expect(out.byteLength).toBe(110); // everything up to and including the chunk that overflowed
    expect(keeper.retained()).toBe(110);
  });

  test("a stream that ends under the cap is kept whole", async () => {
    const out = await readCapped(
      chunkStream(3, 4),
      firstBytesKeeper(100, () => {}),
      never,
    );
    expect(out.byteLength).toBe(12);
  });

  test("stop cancels a reader whose pipe never ends", async () => {
    const stuck = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
    });
    const out = await readCapped(stuck, lastBytesKeeper(10), Promise.resolve());
    expect(out.byteLength).toBeLessThanOrEqual(3);
  });
});
