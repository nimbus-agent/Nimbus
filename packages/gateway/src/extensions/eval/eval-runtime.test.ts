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
import type { EvalCase, EvalRecordInputs, EvalSuite } from "@nimbus-dev/registry-format";

import { extensionServerKey } from "../../connectors/lazy-mesh/server-key.ts";
import type { ServerSpec } from "../../connectors/lazy-mesh/slot.ts";
import { EXTENSION_STAGE_DIR_NAME } from "../../platform/sandbox/sandbox-cwd.ts";
import { SANDBOX_CWD_ENV, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import {
  EVAL_CASE_TIMEOUT_MS,
  EVAL_DISCONNECT_TIMEOUT_MS,
  EVAL_RUN_TIMEOUT_MS,
  type EvalBaselineDeps,
  type EvalListingClient,
  type EvalMcpClient,
  type EvalRuntimeDeps,
  runEvalBaselineSession,
  runEvalRecordSession,
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

// ── The baseline door ──────────────────────────────────────────────────────────────────────────

const GOOD_DEF = { name: "echo", inputSchema: { type: "object", properties: {} } };

interface ListScript {
  definitions?: Record<string, Record<string, unknown>> | "keyed";
  errors?: Record<string, unknown>;
  throws?: string;
  hangs?: boolean;
  disconnect?: () => Promise<void>;
}

function listingFactory(scripts: ListScript[]): {
  createClient: EvalBaselineDeps["createClient"];
  created: Created[];
} {
  const created: Created[] = [];
  const createClient = (id: string, servers: Record<string, ServerSpec>): EvalListingClient => {
    const script = scripts[created.length] ?? scripts.at(-1) ?? {};
    const rec: Created = { id, servers, disconnects: 0 };
    created.push(rec);
    const [serverKey] = Object.keys(servers);
    return {
      listToolDefinitionsWithErrors: async () => {
        if (script.throws !== undefined) throw new Error(script.throws);
        if (script.hangs === true) await new Promise(() => {});
        const definitions =
          script.definitions === undefined || script.definitions === "keyed"
            ? { [String(serverKey)]: { echo: GOOD_DEF } }
            : script.definitions;
        return { definitions, errors: script.errors ?? {} };
      },
      disconnect: async () => {
        rec.disconnects += 1;
        await script.disconnect?.();
      },
    };
  };
  return { createClient, created };
}

function baselineDeps(
  createClient: EvalBaselineDeps["createClient"],
  extra: Partial<EvalBaselineDeps> = {},
): EvalBaselineDeps {
  return {
    sandboxDir,
    runtimeReadPaths: [join(root, "runtime")],
    canConfine: () => null,
    createClient,
    ...extra,
  };
}

describe("runEvalBaselineSession", () => {
  test("a package with no suites is baselined: listed and valid", async () => {
    const { createClient, created } = listingFactory([{}]);
    const src = { ...source([]), suites: [] };
    const baseline = await runEvalBaselineSession(src, baselineDeps(createClient));
    expect(baseline).toEqual({ scorer: 1, passed: true, tools: 1 });
    expect(created).toHaveLength(1);
    expect(stageEntries()).toEqual([]);
  });

  test("a sandbox that cannot confine refuses before anything is staged or built", async () => {
    const { createClient, created } = listingFactory([{}]);
    const code = await codeOf(
      runEvalBaselineSession(source([]), baselineDeps(createClient, { canConfine: () => "nope" })),
    );
    expect(code).toBe("ERR_EVAL_SANDBOX_UNAVAILABLE");
    expect(created).toHaveLength(0);
    expect(existsSync(join(sandboxDir, EXTENSION_STAGE_DIR_NAME))).toBe(false);
  });

  test("an errors entry on both attempts is no-listing, from two different stages", async () => {
    const { createClient, created } = listingFactory([{ errors: { k: "boom" } }]);
    const baseline = await runEvalBaselineSession(source([]), baselineDeps(createClient));
    expect(baseline).toEqual({ scorer: 1, passed: false, tools: 0, failure: "no-listing" });
    expect(created).toHaveLength(2);
    const cwds = created.map((c) => Object.values(c.servers)[0]?.env[SANDBOX_CWD_ENV]);
    expect(cwds[0]).not.toBe(cwds[1]);
    expect(created.map((c) => c.disconnects)).toEqual([1, 1]);
    expect(stageEntries()).toEqual([]);
  });

  /** The thrown error of a baseline session that must not resolve. */
  async function faultOf(p: Promise<unknown>): Promise<EvalRunError> {
    const err = await p.then(
      (b) => {
        throw new Error(`expected a throw, got ${JSON.stringify(b)}`);
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EvalRunError);
    return err as EvalRunError;
  }

  test("a listing call that rejects is a thrown fault at once, carrying none of its text", async () => {
    const { createClient, created } = listingFactory([{ throws: "forged" }]);
    const err = await faultOf(runEvalBaselineSession(source([]), baselineDeps(createClient)));
    expect(err.code).toBe("ERR_EVAL_START_FAILED");
    expect(err.message).not.toContain("forged");
    expect(created).toHaveLength(1);
    expect(created.map((c) => c.disconnects)).toEqual([1]);
    expect(stageEntries()).toEqual([]);
  });

  test("a failed listing then a good one is passed", async () => {
    const { createClient, created } = listingFactory([{ errors: { k: "first" } }, {}]);
    const baseline = await runEvalBaselineSession(source([]), baselineDeps(createClient));
    expect(baseline).toEqual({ scorer: 1, passed: true, tools: 1 });
    expect(created).toHaveLength(2);
  });

  test("a listing that never settles is listing-timeout after two attempts", async () => {
    const { createClient, created } = listingFactory([{ hangs: true }]);
    const baseline = await runEvalBaselineSession(
      source([]),
      baselineDeps(createClient, { attemptTimeoutMs: 5, disconnectTimeoutMs: 20 }),
    );
    expect(baseline).toEqual({ scorer: 1, passed: false, tools: 0, failure: "listing-timeout" });
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.disconnects)).toEqual([1, 1]);
    expect(stageEntries()).toEqual([]);
  });

  test("invalid-tool is not retried", async () => {
    const src = source([]);
    const key = extensionServerKey(src.serviceId);
    const bad = { [key]: { x: { name: "x", inputSchema: { type: "array" } } } };
    const { createClient, created } = listingFactory([{ definitions: bad }]);
    const baseline = await runEvalBaselineSession(src, baselineDeps(createClient));
    expect(baseline).toEqual({ scorer: 1, passed: false, tools: 1, failure: "invalid-tool" });
    expect(created).toHaveLength(1);
  });

  test("a listing with no error and no entry for the server is a thrown fault at once", async () => {
    const { createClient, created } = listingFactory([
      { definitions: { other: { echo: GOOD_DEF } } },
    ]);
    const err = await faultOf(runEvalBaselineSession(source([]), baselineDeps(createClient)));
    expect(err.code).toBe("ERR_EVAL_START_FAILED");
    expect(created).toHaveLength(1);
    expect(stageEntries()).toEqual([]);
  });

  test("attempt 1 is disconnected and its stage removed before attempt 2's client is built", async () => {
    const events: string[] = [];
    let n = 0;
    const createClient: EvalBaselineDeps["createClient"] = () => {
      const attempt = ++n;
      events.push(`create${attempt} stages=${stageEntries().length}`);
      return {
        listToolDefinitionsWithErrors: async () => ({
          definitions: {},
          errors: { server: "no" },
        }),
        disconnect: async () => {
          events.push(`disconnect${attempt}`);
        },
      };
    };
    await runEvalBaselineSession(source([]), baselineDeps(createClient));
    expect(events).toEqual(["create1 stages=1", "disconnect1", "create2 stages=1", "disconnect2"]);
    expect(stageEntries()).toEqual([]);
  });

  test("a createClient that throws is a thrown fault at once, without its text", async () => {
    let calls = 0;
    const err = await faultOf(
      runEvalBaselineSession(
        source([]),
        baselineDeps(() => {
          calls += 1;
          throw new Error("forged client text");
        }),
      ),
    );
    expect(err.code).toBe("ERR_EVAL_START_FAILED");
    expect(err.message).not.toContain("forged");
    expect(calls).toBe(1);
    expect(stageEntries()).toEqual([]);
  });

  test("a staging failure is a thrown EvalRunError, never a failed baseline", async () => {
    const src = source([]);
    rmSync(join(pkg, "dist", "index.js")); // gone after load: the stage copy fails for real
    const { createClient, created } = listingFactory([{}]);
    const err = await runEvalBaselineSession(src, baselineDeps(createClient)).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EvalRunError);
    expect((err as EvalRunError).code).toBe("ERR_EVAL_PACKAGE_INVALID");
    expect(created).toHaveLength(0);
    expect(stageEntries()).toEqual([]);
  });

  test("a disconnect that never settles does not hang the run, and no stage is left", async () => {
    const { createClient } = listingFactory([{ disconnect: () => new Promise(() => {}) }]);
    const baseline = await runEvalBaselineSession(
      source([]),
      baselineDeps(createClient, { disconnectTimeoutMs: 10 }),
    );
    expect(baseline.passed).toBe(true);
    expect(stageEntries()).toEqual([]);
  });
});

describe("runEvalRecordSession", () => {
  const inputs = (...names: string[]): EvalRecordInputs => ({
    name: "rec",
    cases: names.map((n) => ({ name: n, tool: "echo", input: { say: n } })),
  });

  test("two passes, each from a fresh stage: 2 stages made, both gone, inputs in order", async () => {
    const order: string[] = [];
    const rec: ToolImpl = async (input) => {
      order.push(String((input as { say?: unknown }).say));
      return text(String((input as { say?: unknown }).say));
    };
    const { createClient, created } = fakeFactory([{ tools: { echo: rec } }]);
    const out = await runEvalRecordSession(
      source([exactCase("a", "echo", "x")]),
      inputs("a", "b"),
      deps(createClient),
    );
    expect(order).toEqual(["a", "b", "a", "b"]);
    expect(out.first).toHaveLength(2);
    expect(out.second).toHaveLength(2);
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.disconnects)).toEqual([1, 1]);
    expect(stageEntries()).toEqual([]);
  });

  test("a timeout in pass 1 respawns from a fresh stage", async () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const flaky: ToolImpl = (input, ctx) => {
      n += 1;
      return n === 1 ? hanging(signals)(input, ctx) : echo(input, ctx);
    };
    const { createClient, created } = fakeFactory([{ tools: { echo: flaky } }]);
    const out = await runEvalRecordSession(
      source([exactCase("a", "echo", "x")]),
      inputs("a", "b"),
      deps(createClient, { caseTimeoutMs: 20 }),
    );
    expect(out.first[0]).toEqual({ kind: "failed", reason: "timeout" });
    expect(out.first[1]?.kind).toBe("reply");
    expect(created).toHaveLength(3);
    expect(stageEntries()).toEqual([]);
  });

  test("canConfine refusing throws before any stage or spawn", async () => {
    const { createClient, created } = fakeFactory([{ tools: { echo } }]);
    const code = await codeOf(
      runEvalRecordSession(
        source([exactCase("a", "echo", "x")]),
        inputs("a"),
        deps(createClient, { canConfine: () => "no sandbox here" }),
      ),
    );
    expect(code).toBe("ERR_EVAL_SANDBOX_UNAVAILABLE");
    expect(created).toHaveLength(0);
    expect(existsSync(join(sandboxDir, EXTENSION_STAGE_DIR_NAME))).toBe(false);
  });

  test("ONE deadline covers both passes: time spent in pass 1 is gone in pass 2", async () => {
    let clock = 0;
    let calls = 0;
    const slow: ToolImpl = async (input) => {
      calls += 1;
      clock += 1_200; // pass 1 alone spends more than the whole budget
      return echo(input);
    };
    const { createClient } = fakeFactory([{ tools: { echo: slow } }]);
    const code = await codeOf(
      runEvalRecordSession(
        source([exactCase("a", "echo", "x")]),
        inputs("a"),
        deps(createClient, { runTimeoutMs: 1_000, now: () => clock }),
      ),
    );
    expect(code).toBe("ERR_EVAL_RUN_TIMEOUT");
    expect(calls).toBe(1);
    expect(stageEntries()).toEqual([]);
  });

  test("a crash reply in pass 1 respawns and both passes complete", async () => {
    let n = 0;
    const crashy: ToolImpl = async (input) => {
      n += 1;
      if (n === 1) throw new Error("boom");
      return echo(input);
    };
    const { createClient, created } = fakeFactory([{ tools: { echo: crashy } }]);
    const out = await runEvalRecordSession(
      source([exactCase("a", "echo", "x")]),
      inputs("a", "b"),
      deps(createClient),
    );
    expect(out.first[0]).toEqual({ kind: "failed", reason: "crash" });
    expect(out.first[1]?.kind).toBe("reply");
    expect(out.second.map((r) => r.kind)).toEqual(["reply", "reply"]);
    expect(created).toHaveLength(3);
    expect(stageEntries()).toEqual([]);
  });

  test("a start failure on a pass-2 respawn propagates; no stage is left and every client is disconnected", async () => {
    const { createClient, created } = fakeFactory([{ tools: { echo } }, { listThrows: true }]);
    const code = await codeOf(
      runEvalRecordSession(source([exactCase("a", "echo", "x")]), inputs("a"), deps(createClient)),
    );
    expect(code).toBe("ERR_EVAL_START_FAILED");
    expect(created).toHaveLength(2);
    expect(created.map((c) => c.disconnects)).toEqual([1, 1]);
    expect(stageEntries()).toEqual([]);
  });

  test("a zero-input run calls nothing: two empty passes, no client made", async () => {
    const { createClient, created } = fakeFactory([{ tools: { echo } }]);
    const out = await runEvalRecordSession(
      source([exactCase("a", "echo", "x")]),
      { name: "rec", cases: [] },
      deps(createClient),
    );
    expect(out).toEqual({ first: [], second: [] });
    expect(created).toHaveLength(0);
    expect(stageEntries()).toEqual([]);
  });
});
