import { jsonRpcErrorCode } from "@nimbus-dev/client";
import { parseDurationToMs } from "../lib/parse-duration.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/**
 * `disabled`/`notFound` mirror the JSON-RPC codes `fleet-rpc.ts` throws for the same two refusals
 * (`-32000` "not running", `-32602` "no such job") — distinct exit codes so a wrapper script can
 * tell "the fleet isn't on" apart from "you mistyped the job name" without parsing stderr text.
 * `deferred` and `failed` mirror `FleetRunSummary.outcome`; `completed`/`yielded` both exit 0 — a
 * yielded run is a host-activity boundary stopping the run early, not a failure of the run itself.
 */
export const FLEET_EXIT_CODES = {
  ok: 0,
  usage: 1,
  disabled: 2,
  notFound: 3,
  deferred: 4,
  failed: 5,
} as const;

const USAGE = `Usage: nimbus fleet <status|list|briefs|show|run|digest> [options]

  status                        report [fleet] config and a live host-activity probe
  list                          list every configured job and its last-run state
  briefs [--limit N] [--job ID] list synthesised briefs, most recent first
  show <id>                     print one brief's full markdown body
  run <job> [--force]           run one configured job right now, bypassing its schedule — naming
                                 the job skips both its interval and any failure backoff
  digest [--since <duration>]   what moved since the window began (default 24h)

  --json                        machine-readable output (every subcommand)
  --force (run only)            run now even if the host is on battery or in use. That is ALL it
                                 does: it does NOT bypass the schedule (naming the job does), nor
                                 [fleet] enabled, org policy, agent eligibility, or the remote call
                                 budget — those are refused the same way with or without --force.
`;

export interface FleetStatusArgs {
  readonly sub: "status";
  readonly json: boolean;
}
export interface FleetListArgs {
  readonly sub: "list";
  readonly json: boolean;
}
export interface FleetBriefsArgs {
  readonly sub: "briefs";
  readonly limit?: number;
  readonly job?: string;
  readonly json: boolean;
}
export interface FleetShowArgs {
  readonly sub: "show";
  readonly id: string;
  readonly json: boolean;
}
export interface FleetRunArgs {
  readonly sub: "run";
  readonly job: string;
  readonly force: boolean;
  readonly json: boolean;
}
export interface FleetDigestArgs {
  readonly sub: "digest";
  readonly windowMs: number;
  readonly json: boolean;
}

export type ParsedFleetArgs =
  | FleetStatusArgs
  | FleetListArgs
  | FleetBriefsArgs
  | FleetShowArgs
  | FleetRunArgs
  | FleetDigestArgs;

/** Returns the flag's value, or `undefined` when absent or when the "value" is itself a flag. */
function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return undefined;
  return v;
}

/**
 * Parse `nimbus fleet …` argv into a command, or `undefined` for anything unrecognised — an
 * unknown subcommand, `run` with no job name, or `briefs --limit` with a non-positive value.
 * `undefined` rather than a thrown usage error keeps the caller's control flow a single check
 * (print USAGE, exit 1) instead of a try/catch, since none of these failures need a distinct
 * message beyond "here is how the command works".
 */
function parseBriefsArgs(rest: readonly string[], json: boolean): ParsedFleetArgs | undefined {
  const limitRaw = flagValue(rest, "--limit");
  const job = flagValue(rest, "--job");
  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const n = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    limit = n;
  }
  return {
    sub: "briefs",
    ...(limit === undefined ? {} : { limit }),
    ...(job === undefined ? {} : { job }),
    json,
  };
}

/** `--since` is optional; absent means the 24h default the digest has always used. */
function parseDigestArgs(rest: readonly string[], json: boolean): ParsedFleetArgs | undefined {
  const i = rest.indexOf("--since");
  if (i === -1) return { sub: "digest", windowMs: 86_400_000, json };
  const raw = rest[i + 1];
  if (raw === undefined) return undefined;
  let windowMs: number;
  try {
    windowMs = parseDurationToMs(raw);
  } catch {
    // Returning undefined routes to the existing print-USAGE-and-exit-1 path rather than
    // inventing a second failure vocabulary for this one subcommand.
    return undefined;
  }
  if (!Number.isInteger(windowMs) || windowMs <= 0) return undefined;
  return { sub: "digest", windowMs, json };
}

export function parseFleetArgs(argv: readonly string[]): ParsedFleetArgs | undefined {
  const [sub, ...rest] = argv;
  const json = rest.includes("--json");
  // A leading `--` means the positional argument is missing and a flag was read as one.
  const positional = rest[0]?.startsWith("--") === true ? undefined : rest[0];
  switch (sub) {
    case "status":
      return { sub: "status", json };
    case "list":
      return { sub: "list", json };
    case "briefs":
      return parseBriefsArgs(rest, json);
    case "show":
      return positional === undefined ? undefined : { sub: "show", id: positional, json };
    case "run":
      return positional === undefined
        ? undefined
        : { sub: "run", job: positional, force: rest.includes("--force"), json };
    case "digest":
      return parseDigestArgs(rest, json);
    default:
      return undefined;
  }
}

/**
 * The slice of the IPC client this command uses. Narrow so a test can supply one.
 *
 * `call` returns `Promise<unknown>` rather than a generic `Promise<T>` — matching
 * `ExecClient`/`ComputerClient` — so a mock's inferred return type does not have to satisfy an
 * arbitrary caller-chosen `T`; each call site below casts to the shape it expects.
 */
export interface FleetIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}

interface FleetJobStateShape {
  readonly lastAttemptAt: number | null;
  readonly lastSuccessAt: number | null;
  readonly consecutiveFailures: number;
  readonly backoffUntil: number | null;
  readonly lastError: string | null;
}

interface FleetStatusResultShape {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly allowRemote: boolean;
  readonly remoteCallBudget: number;
  readonly minIdleSeconds: number;
  readonly requireAcPower: boolean;
  readonly retentionDays: number;
  readonly jobsConfigured: number;
  readonly probe: {
    readonly power: string;
    readonly idleMs: number | null;
    readonly source: string;
  };
}

interface FleetJobListEntryShape {
  readonly name: string;
  readonly agent: string;
  readonly intervalSeconds: number;
  readonly state: FleetJobStateShape | null;
}

interface FleetBriefSummaryShape {
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly agentMethod: string;
  readonly briefMarkdown: string | null;
  readonly findingsJson: string;
  readonly synthesisJson: string | null;
  readonly createdAt: number;
}

interface FleetRunSummaryShape {
  readonly runId: string | null;
  readonly outcome: "completed" | "yielded" | "deferred" | "failed";
  readonly jobsAttempted: number;
  readonly jobsCompleted: number;
  readonly jobsUnattempted: number;
  readonly jobsSkippedNotDue: number;
}

interface FleetDigestResultShape {
  readonly windowMs: number;
  readonly generatedAt: number;
  readonly markdown: string;
  readonly jobs: readonly unknown[];
  readonly notCompared: {
    readonly firstObservation: readonly unknown[];
    readonly notSummarizable: readonly unknown[];
    readonly noBriefInWindow: readonly unknown[];
    readonly agentChanged: readonly unknown[];
  };
}

/** Where rendered output goes. Injected so rendering is testable without a live process. */
export interface OutcomeSink {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

const defaultSink: OutcomeSink = {
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
};

async function runStatus(c: FleetIpc, json: boolean, sink: OutcomeSink): Promise<number> {
  const r = (await c.call("fleet.status", {})) as FleetStatusResultShape;
  if (json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return FLEET_EXIT_CODES.ok;
  }
  sink.out(
    `${[
      `fleet: ${r.enabled ? "enabled" : "disabled"} (${r.running ? "running" : "not running"})`,
      `  jobs configured:    ${r.jobsConfigured}`,
      `  requires AC power:  ${r.requireAcPower}`,
      `  min idle seconds:   ${r.minIdleSeconds}`,
      `  allow remote:       ${r.allowRemote} (budget ${r.remoteCallBudget})`,
      `  retention days:     ${r.retentionDays}`,
      `  host power:         ${r.probe.power}`,
      `  host idle ms:       ${r.probe.idleMs ?? "unknown"}`,
    ].join("\n")}\n`,
  );
  return FLEET_EXIT_CODES.ok;
}

async function runList(c: FleetIpc, json: boolean, sink: OutcomeSink): Promise<number> {
  const r = (await c.call("fleet.list", {})) as { jobs: readonly FleetJobListEntryShape[] };
  if (json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return FLEET_EXIT_CODES.ok;
  }
  if (r.jobs.length === 0) {
    sink.out("no fleet jobs configured\n");
    return FLEET_EXIT_CODES.ok;
  }
  for (const j of r.jobs) {
    const last =
      j.state?.lastSuccessAt != null ? new Date(j.state.lastSuccessAt).toISOString() : "never";
    const failures = j.state?.consecutiveFailures ?? 0;
    sink.out(
      `${j.name}  agent=${j.agent}  interval=${j.intervalSeconds}s  last success=${last}  consecutive failures=${failures}\n`,
    );
  }
  return FLEET_EXIT_CODES.ok;
}

async function runBriefs(c: FleetIpc, a: FleetBriefsArgs, sink: OutcomeSink): Promise<number> {
  const params: Record<string, unknown> = {};
  if (a.limit !== undefined) params["limit"] = a.limit;
  if (a.job !== undefined) params["jobId"] = a.job;
  const r = (await c.call("fleet.briefs", params)) as {
    briefs: readonly FleetBriefSummaryShape[];
  };
  if (a.json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return FLEET_EXIT_CODES.ok;
  }
  if (r.briefs.length === 0) {
    sink.out("no fleet briefs\n");
    return FLEET_EXIT_CODES.ok;
  }
  for (const b of r.briefs) {
    sink.out(`${b.id}  ${b.jobId}  ${b.agentMethod}  ${new Date(b.createdAt).toISOString()}\n`);
  }
  return FLEET_EXIT_CODES.ok;
}

async function runShow(c: FleetIpc, a: FleetShowArgs, sink: OutcomeSink): Promise<number> {
  const r = (await c.call("fleet.show", { id: a.id })) as {
    brief: FleetBriefSummaryShape | null;
  };
  if (a.json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return r.brief === null ? FLEET_EXIT_CODES.notFound : FLEET_EXIT_CODES.ok;
  }
  if (r.brief === null) {
    sink.err(`nimbus: no such brief, or it has expired: ${a.id}\n`);
    return FLEET_EXIT_CODES.notFound;
  }
  sink.out(`${r.brief.briefMarkdown ?? "(no markdown body)"}\n`);
  return FLEET_EXIT_CODES.ok;
}

/**
 * `runId === null` distinguishes an IN-FLIGHT refusal (another run is already going — the
 * scheduler's re-entrancy guard) from a POWER/IDLE refusal (this run opened its own `fleet_run`
 * row, admission then said no): `FleetScheduler.runOnce` only omits the row on the former path.
 * Without this the two read identically as "deferred", and a user who ran `nimbus fleet run` has
 * no way to tell "the machine is busy" from "something else is already running" — one says try
 * again in a minute, the other says wait for that run to finish.
 */
function describeDeferred(runId: string | null): string {
  return runId === null
    ? "deferred: a fleet run is already in flight — wait for it to finish and try again"
    : "deferred: the host is on battery or in use — try again later, or pass --force";
}

async function runRun(c: FleetIpc, a: FleetRunArgs, sink: OutcomeSink): Promise<number> {
  const summary = (await c.call("fleet.runNow", {
    job: a.job,
    force: a.force,
  })) as FleetRunSummaryShape;

  if (a.json) {
    sink.out(`${JSON.stringify(summary)}\n`);
  } else if (summary.outcome === "deferred") {
    sink.out(`${describeDeferred(summary.runId)}\n`);
  } else {
    sink.out(
      `${summary.outcome}: attempted ${summary.jobsAttempted}, completed ${summary.jobsCompleted}, ` +
        `skipped(not due) ${summary.jobsSkippedNotDue}, unattempted ${summary.jobsUnattempted}\n`,
    );
  }

  switch (summary.outcome) {
    case "completed":
    case "yielded":
      return FLEET_EXIT_CODES.ok;
    case "deferred":
      return FLEET_EXIT_CODES.deferred;
    case "failed":
      return FLEET_EXIT_CODES.failed;
  }
}

async function runDigest(
  c: FleetIpc,
  cmd: Extract<ParsedFleetArgs, { sub: "digest" }>,
  sink: OutcomeSink,
): Promise<number> {
  const r = (await c.call("fleet.digest", { windowMs: cmd.windowMs })) as FleetDigestResultShape;
  // `JSON.stringify(r)` with no indent, matching all four existing --json paths in this file.
  sink.out(cmd.json ? `${JSON.stringify(r)}\n` : `${r.markdown}\n`);
  // ok even when nothing was compared: a quiet night and a broken fleet must not look the same to
  // a script that checks the exit status.
  return FLEET_EXIT_CODES.ok;
}

/**
 * Translate a thrown gateway RPC error into an exit code. ONE definition, used for every
 * subcommand via `runFleetCommand`'s single catch — not just `run`: `fleet.show`/`fleet.briefs`
 * throw the same `-32000` ("fleet: store not available") that `fleet.runNow` throws when no
 * scheduler is wired, and `fleet.show`/`fleet.runNow` both throw `-32602` for a bad/unresolvable
 * param (an unknown job name, a malformed id). Duplicating this per subcommand is exactly how the
 * two drifted before: `run` translated both codes and every other subcommand fell through to
 * `runFleet`'s outer catch, which always reports `disabled` — so a `fleet.show -32602` looked
 * identical to a `fleet.show -32000`, when only the latter is really "the fleet is disabled".
 */
function exitCodeForRpcError(e: unknown): number {
  return jsonRpcErrorCode(e) === -32602 ? FLEET_EXIT_CODES.notFound : FLEET_EXIT_CODES.disabled;
}

/** Execute a parsed fleet subcommand over an injected client (test entry point + runtime path). */
export async function runFleetCommand(
  client: FleetIpc,
  cmd: ParsedFleetArgs,
  sink: OutcomeSink = defaultSink,
): Promise<number> {
  try {
    switch (cmd.sub) {
      case "status":
        return await runStatus(client, cmd.json, sink);
      case "list":
        return await runList(client, cmd.json, sink);
      case "briefs":
        return await runBriefs(client, cmd, sink);
      case "show":
        return await runShow(client, cmd, sink);
      case "run":
        return await runRun(client, cmd, sink);
      case "digest":
        return await runDigest(client, cmd, sink);
    }
  } catch (e) {
    sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return exitCodeForRpcError(e);
  }
}

/**
 * Seams `runFleet` needs from the outside world, injected so the orchestration is testable
 * without a live Gateway. The defaults are the real thing; production callers pass nothing.
 */
export interface RunFleetDeps {
  readonly runWithClient: <T>(fn: (c: FleetIpc) => Promise<T>, timeoutMs?: number) => Promise<T>;
  readonly sink: OutcomeSink;
}

const defaultDeps: RunFleetDeps = {
  runWithClient: (fn, timeoutMs) =>
    withGatewayIpc(fn as never, undefined, {
      ...(timeoutMs === undefined ? {} : { requestTimeoutMs: timeoutMs }),
    }) as never,
  sink: defaultSink,
};

export async function runFleet(args: string[], deps: RunFleetDeps = defaultDeps): Promise<number> {
  const parsed = parseFleetArgs(args);
  if (parsed === undefined) {
    deps.sink.err(USAGE);
    return FLEET_EXIT_CODES.usage;
  }
  // `run` awaits the WHOLE overnight job (a cold catchup plus synthesis routinely takes minutes,
  // per `FleetScheduler`'s own doc comment), so it needs the batch budget rather than the 30s
  // default the other four read-only subcommands are fine with.
  const timeoutMs = parsed.sub === "run" ? BATCH_RPC_TIMEOUT_MS : undefined;
  try {
    return await deps.runWithClient((c) => runFleetCommand(c, parsed, deps.sink), timeoutMs);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    return FLEET_EXIT_CODES.disabled;
  }
}
