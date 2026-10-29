import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase, EvalSuite } from "@nimbus-dev/registry-format";

import type { ServerSpec } from "../../connectors/lazy-mesh/slot.ts";
import { EXTENSION_STAGE_DIR_NAME } from "../../platform/sandbox/sandbox-cwd.ts";
import { SANDBOX_CWD_ENV, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import {
  EVAL_CASE_TIMEOUT_MS,
  EVAL_DISCONNECT_TIMEOUT_MS,
  EVAL_RUN_TIMEOUT_MS,
  type EvalMcpClient,
  type EvalRuntimeDeps,
  runEvalSession,
} from "./eval-runtime.ts";
import {
  EVAL_STAGE_STALE_MS,
  type EvalPackageSource,
  EvalRunError,
  evalFilesDigest,
} from "./eval-source.ts";

const SERVICE_ID = "ext_acme_x";

type ToolImpl = (input: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<unknown>;

/** What the Nth client the fake factory builds does. */
interface ClientScript {
  tools?: Record<string, ToolImpl | "no-execute">;
  errors?: Record<string, unknown>;
  listThrows?: boolean;
  listHangs?: boolean;
  onList?: () => void;
  disconnect?: () => Promise<void>;
}

interface Created {
  id: string;
  servers: Record<string, ServerSpec>;
  disconnects: number;
}

function fakeFactory(scripts: ClientScript[]): {
  createClient: EvalRuntimeDeps["createClient"];
  created: Created[];
} {
  const created: Created[] = [];
  const createClient = (id: string, servers: Record<string, ServerSpec>): EvalMcpClient => {
    const script = scripts[created.length] ?? scripts.at(-1) ?? {};
    const rec: Created = { id, servers, disconnects: 0 };
    created.push(rec);
    const [serverKey] = Object.keys(servers);
    return {
      listToolsWithErrors: async () => {
        script.onList?.();
        if (script.listThrows === true) throw new Error("spawn failed");
        if (script.listHangs === true) await new Promise(() => {});
        const tools: Record<string, { execute?: ToolImpl }> = {};
        for (const [name, impl] of Object.entries(script.tools ?? {})) {
          tools[`${serverKey}_${name}`] = impl === "no-execute" ? {} : { execute: impl };
        }
        return { tools, errors: script.errors ?? {} };
      },
      disconnect: async () => {
        rec.disconnects += 1;
        await script.disconnect?.();
      },
    };
  };
  return { createClient, created };
}

const text = (t: string, isError?: boolean): unknown => ({
  content: [{ type: "text", text: t }],
  ...(isError === undefined ? {} : { isError }),
});

const echo: ToolImpl = async (input) => text(String((input as { say?: unknown }).say));

/** Never settles on its own; rejects when aborted (as a real client does). Records the signal. */
function hanging(signals: AbortSignal[]): ToolImpl {
  return (_input, ctx) =>
    new Promise((_resolve, reject) => {
      const signal = ctx?.abortSignal;
      if (signal !== undefined) {
        signals.push(signal);
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }
    });
}

function exactCase(name: string, tool: string, say: string, error = false): EvalCase {
  return { name, tool, input: { say }, expect: { rubric: "exact", value: say, error } };
}

let root: string;
let pkg: string;
let sandboxDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nimbus-eval-runtime-"));
  pkg = join(root, "pkg");
  sandboxDir = join(root, "sandbox");
  mkdirSync(join(pkg, "dist"), { recursive: true });
  mkdirSync(sandboxDir, { recursive: true });
  writeFileSync(join(pkg, "dist", "index.js"), "console.log(1);");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function source(cases: EvalCase[], suiteName = "basic"): EvalPackageSource {
  const files = ["dist/index.js"];
  const suite: EvalSuite = { file: `evals/${suiteName}.eval.json`, name: suiteName, cases };
  return {
    dir: pkg,
    extensionId: "acme.x",
    version: "1.2.3",
    serviceId: SERVICE_ID,
    entryRel: "dist/index.js",
    files,
    filesDigest: evalFilesDigest(pkg, files),
    suites: [suite],
  };
}

function deps(
  createClient: EvalRuntimeDeps["createClient"],
  extra: Partial<EvalRuntimeDeps> = {},
): EvalRuntimeDeps {
  return {
    sandboxDir,
    runtimeReadPaths: [join(root, "runtime")],
    canConfine: () => null,
    createClient,
    ...extra,
  };
}

function stageEntries(): string[] {
  const dir = join(sandboxDir, EXTENSION_STAGE_DIR_NAME);
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    return e instanceof EvalRunError ? e.code : `not an EvalRunError: ${String(e)}`;
  }
}

describe("eval runtime constants", () => {
  test("deadlines are the spec's values", () => {
    expect(EVAL_CASE_TIMEOUT_MS).toBe(30_000);
    expect(EVAL_RUN_TIMEOUT_MS).toBe(600_000);
    expect(EVAL_DISCONNECT_TIMEOUT_MS).toBe(2_000);
  });
});

describe("runEvalSession", () => {
  test("every case passes ⇒ score 100; one client; stage gone; client disconnected", async () => {
    const { createClient, created } = fakeFactory([{ tools: { echo } }]);
    const report = await runEvalSession(
      source([exactCase("a", "echo", "hi"), exactCase("b", "echo", "there")]),
      deps(createClient),
    );
    expect(report.score).toBe(100);
    expect(report.cases).toBe(2);
    expect(report.results.map((r) => [r.suite, r.case, r.pass, r.reason])).toEqual([
      ["evals/basic.eval.json", "a", true, null],
      ["evals/basic.eval.json", "b", true, null],
    ]);
    expect(created).toHaveLength(1);
    expect(created[0]?.id.startsWith(`nimbus-eval-${SERVICE_ID}-`)).toBe(true);
    expect(created[0]?.disconnects).toBe(1);
    expect(stageEntries()).toEqual([]);
  });

  test("the spec handed to createClient is keyed by the server key and has no network", async () => {
    const { createClient, created } = fakeFactory([{ tools: { echo } }]);
    await runEvalSession(source([exactCase("a", "echo", "hi")]), deps(createClient));
    const servers = created[0]?.servers ?? {};
    expect(Object.keys(servers)).toEqual([SERVICE_ID]);
    const policy = JSON.parse(servers[SERVICE_ID]?.env[SANDBOX_POLICY_ENV] ?? "null") as {
      id: string;
      permissions: { network: unknown[]; filesystem: { write: unknown[] } };
    };
    expect(policy.id).toBe(`eval.${SERVICE_ID}`);
    expect(policy.permissions.network).toEqual([]);
    expect(policy.permissions.filesystem.write).toEqual([]);
  });

  test("an isError reply is judged against expect.error", async () => {
    const failing: ToolImpl = async () => text("boom", true);
    const { createClient } = fakeFactory([{ tools: { failing, echo } }]);
    const report = await runEvalSession(
      source([
        {
          name: "wants-error",
          tool: "failing",
          input: {},
          expect: { rubric: "exact", value: "boom", error: true },
        },
        exactCase("no-error-wanted", "failing", "boom"),
      ]),
      deps(createClient),
    );
    expect(report.results.map((r) => [r.case, r.pass, r.reason])).toEqual([
      ["wants-error", true, null],
      ["no-error-wanted", false, "tool returned an error"],
    ]);
    expect(report.score).toBe(50);
  });

  test("an unlisted tool or a tool without execute ⇒ unknown-tool, no respawn", async () => {
    const { createClient, created } = fakeFactory([{ tools: { echo, bare: "no-execute" } }]);
    const report = await runEvalSession(
      source([
        exactCase("missing", "nope", "x"),
        exactCase("bare", "bare", "x"),
        exactCase("inherited", "toString", "x"),
        exactCase("ok", "echo", "x"),
      ]),
      deps(createClient),
    );
    expect(report.results.map((r) => r.reason)).toEqual([
      "unknown-tool",
      "unknown-tool",
      "unknown-tool",
      null,
    ]);
    expect(created).toHaveLength(1);
  });

  test("a reply that is not an MCP result ⇒ bad-reply, no respawn", async () => {
    const weird: ToolImpl = async () => "just a string";
    const { createClient, created } = fakeFactory([{ tools: { weird, echo } }]);
    const report = await runEvalSession(
      source([exactCase("weird", "weird", "x"), exactCase("ok", "echo", "y")]),
      deps(createClient),
    );
    expect(report.results.map((r) => r.reason)).toEqual(["bad-reply", null]);
    expect(created).toHaveLength(1);
  });

  test("a hung tool ⇒ timeout, aborted signal, client disconnected, respawn, next case passes", async () => {
    const signals: AbortSignal[] = [];
    const { createClient, created } = fakeFactory([
      { tools: { slow: hanging(signals), echo } },
      { tools: { echo } },
    ]);
    const report = await runEvalSession(
      source([exactCase("slow", "slow", "x"), exactCase("after", "echo", "y")]),
      deps(createClient, { caseTimeoutMs: 20 }),
    );
    expect(report.results.map((r) => [r.case, r.pass, r.reason])).toEqual([
      ["slow", false, "timeout"],
      ["after", true, null],
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(created).toHaveLength(2);
    expect(created[0]?.disconnects).toBe(1);
    expect(created[1]?.disconnects).toBe(1);
    expect(stageEntries()).toEqual([]);
  });

  test("a hung tool on the LAST case is not followed by a respawn", async () => {
    const { createClient, created } = fakeFactory([{ tools: { slow: hanging([]) } }]);
    const report = await runEvalSession(
      source([exactCase("slow", "slow", "x")]),
      deps(createClient, { caseTimeoutMs: 10 }),
    );
    expect(report.results[0]?.reason).toBe("timeout");
    expect(created).toHaveLength(1);
    expect(stageEntries()).toEqual([]);
  });

  test("a disconnect that never resolves does not block the run", async () => {
    const { createClient, created } = fakeFactory([
      { tools: { slow: hanging([]) }, disconnect: () => new Promise(() => {}) },
      { tools: { echo }, disconnect: async () => Promise.reject(new Error("already gone")) },
    ]);
    const report = await runEvalSession(
      source([exactCase("slow", "slow", "x"), exactCase("after", "echo", "y")]),
      deps(createClient, { caseTimeoutMs: 10, disconnectTimeoutMs: 10 }),
    );
    expect(report.results.map((r) => r.reason)).toEqual(["timeout", null]);
    expect(created).toHaveLength(2);
  });

  test("a throwing tool ⇒ crash and respawn; a synchronous throw counts the same", async () => {
    const throwsAsync: ToolImpl = async () => {
      throw new Error("transport closed");
    };
    const throwsSync: ToolImpl = () => {
      throw new Error("sync");
    };
    const { createClient, created } = fakeFactory([
      { tools: { throwsAsync, echo } },
      { tools: { throwsSync, echo } },
      { tools: { echo } },
    ]);
    const report = await runEvalSession(
      source([
        exactCase("a", "throwsAsync", "x"),
        exactCase("b", "throwsSync", "x"),
        exactCase("c", "echo", "z"),
      ]),
      deps(createClient),
    );
    expect(report.results.map((r) => r.reason)).toEqual(["crash", "crash", null]);
    expect(created).toHaveLength(3);
    expect(created.every((c) => c.disconnects === 1)).toBe(true);
    expect(stageEntries()).toEqual([]);
  });

  test("a respawn whose listing errors ⇒ ERR_EVAL_START_FAILED; every stage removed", async () => {
    const { createClient, created } = fakeFactory([
      { tools: { slow: hanging([]) } },
      { errors: { [SERVICE_ID]: new Error("exited") } },
    ]);
    const code = await codeOf(
      runEvalSession(
        source([exactCase("slow", "slow", "x"), exactCase("after", "echo", "y")]),
        deps(createClient, { caseTimeoutMs: 10 }),
      ),
    );
    expect(code).toBe("ERR_EVAL_START_FAILED");
    expect(created).toHaveLength(2);
    expect(created[1]?.disconnects).toBe(1);
    expect(stageEntries()).toEqual([]);
  });

  test("the first listing errors or throws ⇒ ERR_EVAL_START_FAILED, no case executed", async () => {
    let called = 0;
    const counted: ToolImpl = async () => {
      called += 1;
      return text("x");
    };
    for (const script of [
      { tools: { counted }, errors: { [SERVICE_ID]: "boom" } },
      { tools: { counted }, listThrows: true },
    ]) {
      const { createClient, created } = fakeFactory([script]);
      const code = await codeOf(
        runEvalSession(source([exactCase("a", "counted", "x")]), deps(createClient)),
      );
      expect(code).toBe("ERR_EVAL_START_FAILED");
      expect(created[0]?.disconnects).toBe(1);
    }
    expect(called).toBe(0);
    expect(stageEntries()).toEqual([]);
  });

  test("createClient throwing ⇒ ERR_EVAL_START_FAILED and the stage is removed", async () => {
    const code = await codeOf(
      runEvalSession(
        source([exactCase("a", "echo", "x")]),
        deps(() => {
          throw new Error("bad server config");
        }),
      ),
    );
    expect(code).toBe("ERR_EVAL_START_FAILED");
    expect(stageEntries()).toEqual([]);
  });

  test("canConfine refuses ⇒ ERR_EVAL_SANDBOX_UNAVAILABLE; nothing staged or spawned", async () => {
    const { createClient, created } = fakeFactory([{ tools: { echo } }]);
    let policyId = "";
    const code = await codeOf(
      runEvalSession(
        source([exactCase("a", "echo", "x")]),
        deps(createClient, {
          canConfine: (p) => {
            policyId = p.id;
            return p.permissions.network.length === 0 ? "no sandbox here" : null;
          },
        }),
      ),
    );
    expect(code).toBe("ERR_EVAL_SANDBOX_UNAVAILABLE");
    expect(policyId).toBe(`eval.${SERVICE_ID}`);
    expect(created).toHaveLength(0);
    expect(existsSync(join(sandboxDir, EXTENSION_STAGE_DIR_NAME))).toBe(false);
  });

  test("no time left before a case ⇒ ERR_EVAL_RUN_TIMEOUT; that case is never executed", async () => {
    let clock = 0;
    let called = 0;
    const counted: ToolImpl = async () => {
      called += 1;
      return text("x");
    };
    const { createClient, created } = fakeFactory([
      {
        tools: { counted },
        onList: () => {
          clock = 1_000;
        },
      },
    ]);
    const code = await codeOf(
      runEvalSession(
        source([exactCase("a", "counted", "x")]),
        deps(createClient, { runTimeoutMs: 1_000, now: () => clock }),
      ),
    );
    expect(code).toBe("ERR_EVAL_RUN_TIMEOUT");
    expect(called).toBe(0);
    expect(created[0]?.disconnects).toBe(1);
    expect(stageEntries()).toEqual([]);
  });

  test("the per-case deadline is clipped to the remaining run time", async () => {
    let clock = 0;
    const signals: AbortSignal[] = [];
    const slow = hanging(signals);
    const { createClient } = fakeFactory([
      {
        // 10 ms of run left when the case starts: its 60 s deadline must not apply.
        onList: () => {
          clock = 990;
        },
        tools: {
          slow: (input, ctx) => {
            clock = 1_000; // the run is out of time once this case ends
            return slow(input, ctx);
          },
        },
      },
    ]);
    const started = Date.now();
    const code = await codeOf(
      runEvalSession(
        source([exactCase("slow", "slow", "x"), exactCase("next", "slow", "y")]),
        deps(createClient, { caseTimeoutMs: 60_000, runTimeoutMs: 1_000, now: () => clock }),
      ),
    );
    expect(code).toBe("ERR_EVAL_RUN_TIMEOUT");
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(stageEntries()).toEqual([]);
  });

  test("a LAST case cut short by the run deadline ⇒ ERR_EVAL_RUN_TIMEOUT, not a score", async () => {
    const signals: AbortSignal[] = [];
    const { createClient, created } = fakeFactory([{ tools: { slow: hanging(signals) } }]);
    const code = await codeOf(
      runEvalSession(
        source([exactCase("slow", "slow", "x")]),
        deps(createClient, { caseTimeoutMs: 60_000, runTimeoutMs: 30 }),
      ),
    );
    expect(code).toBe("ERR_EVAL_RUN_TIMEOUT");
    expect(signals[0]?.aborted).toBe(true);
    expect(created[0]?.disconnects).toBe(1);
    expect(stageEntries()).toEqual([]);
  });

  test("the binding limit is decided BEFORE the call: a run-bound cut is a run timeout", async () => {
    // The fake clock never moves during the call, so a check made AFTER the timer fires would still
    // see 10 ms left and score the cut as the extension's case timeout.
    let clock = 0;
    const { createClient } = fakeFactory([
      {
        tools: { slow: hanging([]) },
        onList: () => {
          clock = 990; // 10 ms of run left; the 60 s case timeout cannot be the binding limit
        },
      },
    ]);
    const code = await codeOf(
      runEvalSession(
        source([exactCase("slow", "slow", "x")]),
        deps(createClient, { caseTimeoutMs: 60_000, runTimeoutMs: 1_000, now: () => clock }),
      ),
    );
    expect(code).toBe("ERR_EVAL_RUN_TIMEOUT");
    expect(stageEntries()).toEqual([]);
  });

  test("a stage the kill could not remove (a child still held it) is removed when the run closes", async () => {
    const throwsAsync: ToolImpl = async () => {
      throw new Error("transport closed");
    };
    const base = fakeFactory([{ tools: { throwsAsync } }, { tools: { echo } }]);
    let firstStage = "";
    const createClient: EvalRuntimeDeps["createClient"] = (id, servers) => {
      const cwd = Object.values(servers)[0]?.env[SANDBOX_CWD_ENV] ?? "";
      if (base.created.length === 0) firstStage = cwd;
      // The respawn comes after the kill tried to remove the first stage: put it back, as a
      // removal that failed on a file the dead child still held leaves it.
      else mkdirSync(join(firstStage, "held"), { recursive: true });
      return base.createClient(id, servers);
    };
    const report = await runEvalSession(
      source([exactCase("a", "throwsAsync", "x"), exactCase("b", "echo", "y")]),
      deps(createClient),
    );
    expect(report.results.map((r) => r.reason)).toEqual(["crash", null]);
    expect(firstStage).not.toBe("");
    expect(base.created).toHaveLength(2);
    expect(existsSync(firstStage)).toBe(false);
    expect(stageEntries()).toEqual([]);
  });

  test("a case slower than the CASE timeout (run time left) is the extension's timeout", async () => {
    const { createClient } = fakeFactory([{ tools: { slow: hanging([]) } }]);
    const report = await runEvalSession(
      source([exactCase("slow", "slow", "x")]),
      deps(createClient, { caseTimeoutMs: 15, runTimeoutMs: 60_000 }),
    );
    expect(report.results.map((r) => [r.suite, r.case, r.reason])).toEqual([
      ["evals/basic.eval.json", "slow", "timeout"],
    ]);
    expect(report.score).toBe(0);
  });

  test("a listing that never answers is bounded by the run deadline", async () => {
    const { createClient, created } = fakeFactory([{ listHangs: true }]);
    const code = await codeOf(
      runEvalSession(
        source([exactCase("a", "echo", "x")]),
        deps(createClient, { runTimeoutMs: 20 }),
      ),
    );
    expect(code).toBe("ERR_EVAL_RUN_TIMEOUT");
    expect(created[0]?.disconnects).toBe(1);
    expect(stageEntries()).toEqual([]);
  });

  test("a run first sweeps eval stages an earlier run left over an hour ago", async () => {
    const stale = join(sandboxDir, EXTENSION_STAGE_DIR_NAME, "eval-left-behind");
    mkdirSync(stale, { recursive: true });
    const t = (Date.now() - EVAL_STAGE_STALE_MS - 60_000) / 1000;
    utimesSync(stale, t, t);
    const { createClient } = fakeFactory([{ tools: { echo } }]);
    await runEvalSession(source([exactCase("a", "echo", "hi")]), deps(createClient));
    expect(stageEntries()).toEqual([]);
  });

  test("a source with no cases ⇒ ERR_EVAL_NO_SUITES (never a score of 0)", async () => {
    const { createClient, created } = fakeFactory([{ tools: { echo } }]);
    const code = await codeOf(runEvalSession(source([]), deps(createClient)));
    expect(code).toBe("ERR_EVAL_NO_SUITES");
    expect(created).toHaveLength(0); // nothing staged or spawned for nothing
    expect(existsSync(join(sandboxDir, EXTENSION_STAGE_DIR_NAME))).toBe(false);
  });
});
