import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalReport, EvalRoleDocument } from "@nimbus-dev/registry-format";

import { EXTENSION_STAGE_DIR_NAME } from "../../platform/sandbox/sandbox-cwd.ts";
import {
  adaptEvalClient,
  defaultEvalRun,
  type EvalRoleDeps,
  type EvalRunLoaders,
  evalServerDefs,
  exitAfterFlush,
  normaliseEvalReply,
  REAL_EVAL_LOADERS,
  REAL_ROLE_DEPS,
  runEvalRole,
} from "./eval-role.ts";
import { EvalRunError } from "./eval-source.ts";

const REPORT = { score: 1 } as unknown as EvalReport;

interface Harness {
  deps: EvalRoleDeps;
  out: string[];
  err: string[];
  exits: number[];
  calls: { packageDir: string; suiteFile?: string }[];
}

function harness(run: EvalRoleDeps["run"]): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const calls: { packageDir: string; suiteFile?: string }[] = [];
  const deps: EvalRoleDeps = {
    writeStdout: (s) => out.push(s),
    writeStderr: (s) => err.push(s),
    exit: (c) => exits.push(c),
    run: (a) => {
      calls.push(a);
      return run(a);
    },
  };
  return { deps, out, err, exits, calls };
}

const OK: EvalRoleDocument = { ok: true, extensionId: "a.b", version: "1.0.0", report: REPORT };

describe("runEvalRole", () => {
  test.each([
    [[]],
    [["--suite", "x"]],
    [["--package"]],
    [["--package", "/p", "--bogus"]],
    [["--package", "/p", "--suite"]],
    [["--package", "/p", "--package", "/q"]],
    [["--package", "/p", "--suite", "a", "--suite", "b"]],
    [["stray"]],
    [["--package", "--json"]],
    [["--package", "/p", "--suite", "--json"]],
  ])("usage error %j exits 2 with empty stdout", async (argv) => {
    const h = harness(async () => OK);
    await runEvalRole(argv, h.deps);
    expect(h.out).toEqual([]);
    expect(h.exits).toEqual([2]);
    expect(h.err.join("")).toContain("usage");
    expect(h.calls).toEqual([]);
  });

  test("success writes exactly one parseable line and exits 0", async () => {
    const h = harness(async () => OK);
    await runEvalRole(["--package", "/p", "--suite", "s.eval.json", "--json"], h.deps);
    expect(h.out).toHaveLength(1);
    expect(h.out[0]?.endsWith("\n")).toBe(true);
    expect(JSON.parse(h.out[0] ?? "")).toEqual(OK);
    expect(h.exits).toEqual([0]);
    expect(h.calls).toEqual([{ packageDir: "/p", suiteFile: "s.eval.json" }]);
  });

  test("without --suite the suiteFile key is absent", async () => {
    const h = harness(async () => OK);
    await runEvalRole(["--package", "/p"], h.deps);
    expect(h.calls).toEqual([{ packageDir: "/p" }]);
  });

  test("an EvalRunError maps to ok:false with its code", async () => {
    const h = harness(async () => {
      throw new EvalRunError("ERR_EVAL_NO_SUITES", "none");
    });
    await runEvalRole(["--package", "/p"], h.deps);
    expect(JSON.parse(h.out[0] ?? "")).toEqual({
      ok: false,
      error: { code: "ERR_EVAL_NO_SUITES", message: "none" },
    });
    expect(h.exits).toEqual([0]);
  });

  test("an unknown throw maps to ERR_EVAL_INTERNAL", async () => {
    const h = harness(async () => {
      throw new Error("boom");
    });
    await runEvalRole(["--package", "/p"], h.deps);
    expect(JSON.parse(h.out[0] ?? "")).toEqual({
      ok: false,
      error: { code: "ERR_EVAL_INTERNAL", message: "boom" },
    });
  });

  test("a non-Error throw is stringified", async () => {
    const h = harness(async () => {
      throw "plain";
    });
    await runEvalRole(["--package", "/p"], h.deps);
    expect(JSON.parse(h.out[0] ?? "").error.message).toBe("plain");
  });

  test("console.log inside run lands on stderr and is restored afterwards", async () => {
    const before = { log: console.log, info: console.info, debug: console.debug };
    const h = harness(async () => {
      console.log("noise");
      console.info("info", 1);
      console.debug("dbg");
      return OK;
    });
    await runEvalRole(["--package", "/p"], h.deps);
    expect(h.out).toHaveLength(1);
    const err = h.err.join("");
    expect(err).toContain("noise");
    expect(err).toContain("info 1");
    expect(err).toContain("dbg");
    expect(console.log).toBe(before.log);
    expect(console.info).toBe(before.info);
    expect(console.debug).toBe(before.debug);
  });

  test("the document is written while console output still goes to stderr", async () => {
    const before = console.log;
    const h = harness(async () => OK);
    const write = h.deps.writeStdout;
    let redirectedAtWrite = false;
    h.deps.writeStdout = (s) => {
      redirectedAtWrite = console.log !== before;
      console.log("late library line");
      write(s);
    };
    await runEvalRole(["--package", "/p"], h.deps);
    expect(redirectedAtWrite).toBe(true);
    expect(h.out).toHaveLength(1);
    expect(h.err.join("")).toContain("late library line");
    expect(console.log).toBe(before);
  });

  test("console is restored even when run throws", async () => {
    const before = console.log;
    const h = harness(async () => {
      throw new Error("x");
    });
    await runEvalRole(["--package", "/p"], h.deps);
    expect(console.log).toBe(before);
  });
});

describe("defaultEvalRun", () => {
  test("a relative package dir is an EvalRunError, before any spawn", async () => {
    await expect(defaultEvalRun({ packageDir: "not/absolute" })).rejects.toBeInstanceOf(
      EvalRunError,
    );
  });

  test("a relative package dir with a suite file is refused the same way", async () => {
    await expect(
      defaultEvalRun({ packageDir: "also/relative", suiteFile: "x.eval.json" }),
    ).rejects.toBeInstanceOf(EvalRunError);
  });
});

describe("error-reply adapter", () => {
  const hidden = (content: unknown) => (o: unknown) =>
    (o as { __c?: unknown }).__c === undefined ? undefined : content;

  test("server definitions carry onToolError: return", () => {
    const defs = evalServerDefs({ s: { command: "c", args: ["a"], env: {} } });
    expect(Object.values(defs)[0]).toEqual({
      command: "c",
      args: ["a"],
      env: {},
      onToolError: "return",
    });
  });

  test("a raw envelope with isError passes through unchanged", () => {
    const raw = { content: [{ type: "text", text: "no" }], isError: true };
    expect(normaliseEvalReply(raw, () => undefined)).toBe(raw);
  });

  test("structuredContent with hidden content normalises to {content}", () => {
    const content = [{ type: "text", text: "hi" }];
    expect(normaliseEvalReply({ __c: 1, x: 2 }, hidden(content))).toEqual({ content });
  });

  test("scalars and objects without hidden content pass through", () => {
    expect(normaliseEvalReply(5, hidden([]))).toBe(5);
    expect(normaliseEvalReply(null, hidden([]))).toBe(null);
    const o = { y: 1 };
    expect(normaliseEvalReply(o, () => undefined)).toBe(o);
  });

  test("adaptEvalClient normalises execute results and forwards disconnect", async () => {
    let disconnected = 0;
    const content = [{ type: "text", text: "hi" }];
    const client = adaptEvalClient(
      {
        disconnect: async () => {
          disconnected++;
        },
        listToolsWithErrors: async () => ({
          tools: {
            a: { execute: async () => ({ __c: 1 }) },
            b: { description: "no execute" },
          },
          errors: { e: 1 },
        }),
      },
      hidden(content),
    );
    const { tools, errors } = await client.listToolsWithErrors();
    const [toolA, toolB] = Object.values(tools);
    expect(errors).toEqual({ e: 1 });
    expect(await toolA?.execute?.({})).toEqual({ content });
    expect(toolB?.execute).toBeUndefined();
    await client.disconnect();
    expect(disconnected).toBe(1);
  });
});

describe("defaultEvalRun with injected loaders", () => {
  let root: string;
  let pkg: string;
  let sandboxDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "nimbus-eval-role-"));
    pkg = join(root, "pkg");
    sandboxDir = join(root, "sandbox");
    mkdirSync(join(pkg, "dist"), { recursive: true });
    mkdirSync(join(pkg, "evals"), { recursive: true });
    mkdirSync(sandboxDir, { recursive: true });
    writeFileSync(
      join(pkg, "nimbus.extension.json"),
      JSON.stringify({ id: "acme.roletest", version: "2.0.0", entry: "dist/index.js" }),
    );
    writeFileSync(join(pkg, "dist", "index.js"), "console.log(1);");
    const cases = [
      { name: "hi", tool: "echo", input: { text: "hi" }, expect: { rubric: "exact", value: "hi" } },
      { name: "no", tool: "echo", input: { text: "a" }, expect: { rubric: "exact", value: "b" } },
    ];
    writeFileSync(
      join(pkg, "evals", "basic.eval.json"),
      JSON.stringify({ format: 1, name: "basic", cases }),
    );
    writeFileSync(
      join(pkg, "evals", "other.eval.json"),
      JSON.stringify({ format: 1, name: "other", cases: [cases[0]] }),
    );
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  interface Seen {
    ids: string[];
    onToolError: unknown[];
    disconnects: number;
  }

  function newSeen(): Seen {
    return { ids: [], onToolError: [], disconnects: 0 };
  }

  /**
   * A fake MCP client per spawn whose `echo` replies with its input text, hidden the way
   * `@mastra/mcp` hides `content` on a reshaped reply (so the adapter's recovery runs too).
   */
  function loaders(seen: Seen, confine: string | null = null): EvalRunLoaders {
    return {
      mcp: async () => ({
        createClient: (id, servers) => {
          seen.ids.push(id);
          const [key] = Object.keys(servers);
          seen.onToolError.push(servers[key ?? ""]?.onToolError);
          return {
            listToolsWithErrors: async () => ({
              tools: {
                [`${key}_echo`]: {
                  execute: async (input: unknown) => ({
                    __c: [{ type: "text", text: (input as { text: string }).text }],
                  }),
                },
              },
              errors: {},
            }),
            disconnect: async () => {
              seen.disconnects += 1;
            },
          };
        },
        readContent: (o) => (o as { __c?: unknown }).__c,
      }),
      canConfine: async () => () => confine,
      sandboxDir: async () => sandboxDir,
      runtimeReadPaths: async () => [join(root, "runtime")],
    };
  }

  test("runs every suite through the injected client and returns the scored document", async () => {
    const seen = newSeen();
    const doc = await defaultEvalRun({ packageDir: pkg }, loaders(seen));
    if (!doc.ok) throw new Error(JSON.stringify(doc));
    expect(doc.extensionId).toBe("acme.roletest");
    expect(doc.version).toBe("2.0.0");
    expect(doc.report.cases).toBe(3);
    expect(doc.report.passed).toBe(2);
    expect(doc.report.results.map((r) => [r.suite, r.case, r.pass])).toEqual([
      ["evals/basic.eval.json", "hi", true],
      ["evals/basic.eval.json", "no", false],
      ["evals/other.eval.json", "hi", true],
    ]);
    expect(seen.ids).toHaveLength(1);
    expect(seen.onToolError).toEqual(["return"]);
    expect(seen.disconnects).toBe(1);
    const stageRoot = join(sandboxDir, EXTENSION_STAGE_DIR_NAME);
    expect(existsSync(stageRoot) ? readdirSync(stageRoot) : []).toEqual([]);
  });

  test("a suite file keeps only that suite", async () => {
    const doc = await defaultEvalRun(
      { packageDir: pkg, suiteFile: "evals/other.eval.json" },
      loaders(newSeen()),
    );
    if (!doc.ok) throw new Error(JSON.stringify(doc));
    expect(doc.report.results.map((r) => r.suite)).toEqual(["evals/other.eval.json"]);
  });

  test("a sandbox that cannot confine refuses before any client is made", async () => {
    const seen = newSeen();
    const run = defaultEvalRun({ packageDir: pkg }, loaders(seen, "no sandbox"));
    await expect(run).rejects.toMatchObject({ code: "ERR_EVAL_SANDBOX_UNAVAILABLE" });
    expect(seen.ids).toEqual([]);
  });
});

describe("the real role dependencies", () => {
  test("the stdout and stderr writers accept a write; run is defaultEvalRun", () => {
    expect(() => REAL_ROLE_DEPS.writeStdout("")).not.toThrow();
    expect(() => REAL_ROLE_DEPS.writeStderr("")).not.toThrow();
    expect(REAL_ROLE_DEPS.run).toBe(defaultEvalRun);
  });

  test("exitAfterFlush exits only once the stdout flush callback runs", () => {
    const exits: number[] = [];
    let flush: (() => void) | undefined;
    exitAfterFlush(
      7,
      {
        write: (_s, cb) => {
          flush = cb;
          return true;
        },
      },
      (c) => {
        exits.push(c);
      },
    );
    expect(exits).toEqual([]);
    flush?.();
    expect(exits).toEqual([7]);
  });

  test("the real loaders resolve without spawning anything", async () => {
    const mcp = await REAL_EVAL_LOADERS.mcp();
    const client = mcp.createClient(`nimbus-eval-role-test-${crypto.randomUUID()}`, {});
    await client.disconnect();
    expect(mcp.readContent({})).toBeUndefined();
    const canConfine = await REAL_EVAL_LOADERS.canConfine();
    const verdict = canConfine({
      id: "eval.role-test",
      permissions: { network: [], filesystem: { read: [], write: [] } },
    });
    expect(verdict === null || typeof verdict === "string").toBe(true);
    expect(typeof (await REAL_EVAL_LOADERS.sandboxDir())).toBe("string");
    expect((await REAL_EVAL_LOADERS.runtimeReadPaths()).length).toBeGreaterThan(0);
  });
});
