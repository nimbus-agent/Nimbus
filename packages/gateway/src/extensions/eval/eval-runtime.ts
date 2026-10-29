import { randomUUID } from "node:crypto";
import {
  type EvalCase,
  type EvalCaseOutcome,
  type EvalReply,
  type EvalReport,
  type EvalSuite,
  judgeCase,
  scoreEval,
} from "@nimbus-dev/registry-format";

// `server-key.ts`, not `extension-slot.ts`: the eval role's static graph must not reach
// `@mastra/mcp` or the health/DB modules the slot imports.
import { extensionServerKey } from "../../connectors/lazy-mesh/server-key.ts";
import type { ServerSpec } from "../../connectors/lazy-mesh/slot.ts";
import type { SandboxPolicy } from "../../platform/sandbox/sandbox-policy.ts";
import { replyFromMcpResult } from "./eval-reply.ts";
import {
  discardEvalStage,
  type EvalPackageSource,
  EvalRunError,
  messageOf,
  stageEvalPackage,
} from "./eval-source.ts";
import {
  buildExtensionEvalSpawnSpec,
  type EvalStagedPackage,
  evalSandboxPolicy,
} from "./eval-spawn-spec.ts";

export const EVAL_CASE_TIMEOUT_MS = 30_000;
export const EVAL_RUN_TIMEOUT_MS = 600_000;
/** Every `disconnect()` is raced against this, so a wedged child never blocks the run. */
export const EVAL_DISCONNECT_TIMEOUT_MS = 2_000;

type EvalToolExecute = (input: unknown, ctx?: { abortSignal?: AbortSignal }) => Promise<unknown>;
type EvalToolMap = Record<string, { execute?: EvalToolExecute }>;

/** The slice of `@mastra/mcp`'s `MCPClient` an eval drives (a fake in tests). */
export interface EvalMcpClient {
  listToolsWithErrors(): Promise<{ tools: EvalToolMap; errors: Record<string, unknown> }>;
  disconnect(): Promise<void>;
}

export interface EvalRuntimeDeps {
  readonly sandboxDir: string;
  readonly runtimeReadPaths: readonly string[];
  readonly canConfine: (p: SandboxPolicy) => string | null;
  readonly createClient: (id: string, servers: Record<string, ServerSpec>) => EvalMcpClient;
  readonly caseTimeoutMs?: number;
  readonly runTimeoutMs?: number;
  readonly disconnectTimeoutMs?: number;
  readonly now?: () => number;
}

/** The one live server of a run: its client, the stage it runs from, the tools it listed. */
interface EvalServer {
  readonly client: EvalMcpClient;
  readonly stage: EvalStagedPackage;
  tools: EvalToolMap;
}

/** A run's mutable state. `stages` holds EVERY stage made, so `finally` can remove each one. */
interface EvalRun {
  readonly src: EvalPackageSource;
  readonly deps: EvalRuntimeDeps;
  readonly serverKey: string;
  readonly now: () => number;
  readonly deadline: number;
  readonly caseTimeoutMs: number;
  readonly disconnectTimeoutMs: number;
  readonly stages: EvalStagedPackage[];
  server: EvalServer | undefined;
}

type Settled =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "timeout" };

/**
 * Settle `p` within `ms`. Never rejects, and `p`'s own rejection is always observed, so a call
 * that fails AFTER its deadline cannot surface as an unhandled rejection.
 */
function settleWithin(p: Promise<unknown>, ms: number, onTimeout?: () => void): Promise<Settled> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        onTimeout?.();
        resolve({ kind: "timeout" });
      },
      Math.max(0, ms),
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ kind: "value", value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ kind: "threw", error });
      },
    );
  });
}

function remainingMs(run: EvalRun): number {
  return run.deadline - run.now();
}

function runTimeout(run: EvalRun): EvalRunError {
  const ms = run.deps.runTimeoutMs ?? EVAL_RUN_TIMEOUT_MS;
  return new EvalRunError("ERR_EVAL_RUN_TIMEOUT", `the eval exceeded its ${String(ms)} ms budget`);
}

function startFailed(message: string): EvalRunError {
  return new EvalRunError("ERR_EVAL_START_FAILED", `the extension did not start: ${message}`);
}

// ── Phase 1: refuse before anything is staged ──────────────────────────────────────────────────

function assertSandboxAvailable(src: EvalPackageSource, deps: EvalRuntimeDeps): void {
  const reason = deps.canConfine(evalSandboxPolicy(src.serviceId, deps.runtimeReadPaths));
  if (reason !== null) {
    throw new EvalRunError("ERR_EVAL_SANDBOX_UNAVAILABLE", `cannot sandbox the eval: ${reason}`);
  }
}

function openRun(src: EvalPackageSource, deps: EvalRuntimeDeps): EvalRun {
  const now = deps.now ?? Date.now;
  return {
    src,
    deps,
    serverKey: extensionServerKey(src.serviceId),
    now,
    deadline: now() + (deps.runTimeoutMs ?? EVAL_RUN_TIMEOUT_MS),
    caseTimeoutMs: deps.caseTimeoutMs ?? EVAL_CASE_TIMEOUT_MS,
    disconnectTimeoutMs: deps.disconnectTimeoutMs ?? EVAL_DISCONNECT_TIMEOUT_MS,
    stages: [],
    server: undefined,
  };
}

function assertTimeLeft(run: EvalRun): void {
  if (remainingMs(run) <= 0) throw runTimeout(run);
}

// ── Phase 2: (re)spawn — stage, spec, client, listing ──────────────────────────────────────────

function connectClient(run: EvalRun, stage: EvalStagedPackage): EvalServer {
  const spec = buildExtensionEvalSpawnSpec(stage, { runtimeReadPaths: run.deps.runtimeReadPaths });
  try {
    const client = run.deps.createClient(`nimbus-eval-${run.src.serviceId}-${randomUUID()}`, {
      [run.serverKey]: spec,
    });
    return { client, stage, tools: {} };
  } catch (e) {
    throw startFailed(messageOf(e));
  }
}

/** The listing is bounded by the run deadline; any error entry or a throw is a start failure. */
async function listServerTools(run: EvalRun, client: EvalMcpClient): Promise<EvalToolMap> {
  const settled = await settleWithin(
    Promise.resolve().then(() => client.listToolsWithErrors()),
    remainingMs(run),
  );
  if (settled.kind === "timeout") throw runTimeout(run);
  if (settled.kind === "threw") throw startFailed(messageOf(settled.error));
  const listing = settled.value as Awaited<ReturnType<EvalMcpClient["listToolsWithErrors"]>>;
  const failed = Object.keys(listing.errors);
  if (failed.length > 0) throw startFailed(`listing tools failed for ${failed.join(", ")}`);
  return listing.tools;
}

async function spawnServer(run: EvalRun): Promise<EvalServer> {
  const stage = stageEvalPackage(run.src, run.deps.sandboxDir);
  run.stages.push(stage);
  const server = connectClient(run, stage);
  run.server = server; // set before listing, so a failed listing is still disconnected
  server.tools = await listServerTools(run, server.client);
  return server;
}

// ── Phase 3: one case — one tool call under its deadline ───────────────────────────────────────

function lookupTool(server: EvalServer, run: EvalRun, tool: string): EvalToolExecute | undefined {
  const key = `${run.serverKey}_${tool}`;
  return Object.hasOwn(server.tools, key) ? server.tools[key]?.execute : undefined;
}

/**
 * `min(caseTimeout, runDeadline - now)`; a timeout aborts the call. When the RUN deadline was the
 * binding limit the case is not the extension's failure: the whole run is a run timeout.
 */
async function callCaseTool(run: EvalRun, server: EvalServer, c: EvalCase): Promise<EvalReply> {
  const execute = lookupTool(server, run, c.tool);
  if (execute === undefined) return { kind: "failed", reason: "unknown-tool" };
  const budget = Math.min(run.caseTimeoutMs, remainingMs(run));
  const abort = new AbortController();
  // `.then` so a synchronous throw from `execute` is a rejection like any other.
  const call = Promise.resolve().then(() => execute(c.input, { abortSignal: abort.signal }));
  const settled = await settleWithin(call, budget, () => abort.abort());
  if (settled.kind === "timeout") {
    if (remainingMs(run) <= 0) throw runTimeout(run);
    return { kind: "failed", reason: "timeout" };
  }
  if (settled.kind === "threw") return { kind: "failed", reason: "crash" };
  return replyFromMcpResult(settled.value);
}

/** A disconnect raced against its own cap, errors swallowed: a wedged child never blocks. */
async function disconnectWithin(client: EvalMcpClient, ms: number): Promise<void> {
  await settleWithin(
    Promise.resolve().then(() => client.disconnect()),
    ms,
  );
}

/** Kill the live server and drop its stage; the next case respawns from a fresh stage. */
async function killServer(run: EvalRun): Promise<void> {
  const server = run.server;
  if (server === undefined) return;
  run.server = undefined;
  await disconnectWithin(server.client, run.disconnectTimeoutMs);
  discardEvalStage(server.stage);
  run.stages.splice(run.stages.indexOf(server.stage), 1); // discarded: never twice
}

async function runCase(run: EvalRun, suite: EvalSuite, c: EvalCase): Promise<EvalCaseOutcome> {
  const server = run.server ?? (await spawnServer(run));
  const reply = await callCaseTool(run, server, c);
  // The old channel may be desynchronised after a timeout or a dropped transport.
  if (reply.kind === "failed" && (reply.reason === "timeout" || reply.reason === "crash")) {
    await killServer(run);
  }
  const verdict = judgeCase(c, reply);
  return {
    suite: suite.file, // unique; a suite `name` is free text and may repeat
    case: c.name,
    rubric: c.expect.rubric,
    pass: verdict.pass,
    reason: verdict.reason,
  };
}

function countCases(src: EvalPackageSource): number {
  return src.suites.reduce((n, suite) => n + suite.cases.length, 0);
}

/** Nothing is staged or spawned for a source without a single case. */
function assertHasCases(src: EvalPackageSource): void {
  if (countCases(src) === 0) {
    throw new EvalRunError("ERR_EVAL_NO_SUITES", "the suites hold no cases");
  }
}

// ── Phase 4: score; cleanup ─────────────────────────────────────────────────────────────────────

function scoreOutcomes(outcomes: readonly EvalCaseOutcome[]): EvalReport {
  const report = scoreEval(outcomes);
  // Unreachable after `assertHasCases`; kept so a null report can never become a score.
  if (report === null) throw new EvalRunError("ERR_EVAL_INTERNAL", "no outcomes to score");
  return report;
}

async function closeRun(run: EvalRun): Promise<void> {
  await killServer(run);
  // Only stages no server owned remain (e.g. createClient threw after staging).
  for (const stage of run.stages) discardEvalStage(stage);
}

/**
 * Evaluate a verified package: refuse when the sandbox cannot confine it, spawn ONE sandboxed MCP
 * server (no network, no credentials) from a fresh stage, call one tool per case in suite/case
 * order under a per-case and a whole-run deadline, respawn from a fresh stage after a case that
 * timed out or crashed, and score deterministically. Throws `EvalRunError`; every client is
 * disconnected and every stage removed whatever happens.
 */
export async function runEvalSession(
  src: EvalPackageSource,
  deps: EvalRuntimeDeps,
): Promise<EvalReport> {
  assertHasCases(src);
  assertSandboxAvailable(src, deps);
  const run = openRun(src, deps);
  try {
    await spawnServer(run);
    const outcomes: EvalCaseOutcome[] = [];
    for (const suite of src.suites) {
      for (const c of suite.cases) {
        assertTimeLeft(run);
        outcomes.push(await runCase(run, suite, c));
      }
    }
    return scoreOutcomes(outcomes);
  } finally {
    await closeRun(run);
  }
}
