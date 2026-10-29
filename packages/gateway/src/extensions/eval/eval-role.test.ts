import { describe, expect, test } from "bun:test";
import type { EvalReport } from "@nimbus-dev/registry-format";

import {
  adaptEvalClient,
  defaultEvalRun,
  type EvalRoleDeps,
  type EvalRoleDocument,
  evalServerDefs,
  normaliseEvalReply,
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

  test("a missing suite file is forwarded and refused", async () => {
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
