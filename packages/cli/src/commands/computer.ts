import { createInterface } from "node:readline/promises";
import { confirm, isCancel } from "@clack/prompts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/**
 * Distinct exit codes for the outcomes a wrapper script needs to tell apart, mirroring `exec.ts`'s
 * `EXEC_EXIT_CODES` reasoning — kept in a DIFFERENT numeric band (this command has its own process,
 * so no collision is possible, but a shared band would still read as "the same kind of thing" to a
 * human comparing the two references).
 *
 * `deniedByOwner` covers BOTH shapes of "the owner said no": `OpenSessionResult.status === "denied"`
 * (the envelope itself was refused) and a `RunActionOutput.outcome === "denied_by_owner"` (a single
 * actuating action was refused) — the caller-visible fact is identical either way: a human looked at
 * an exact request and declined it.
 *
 * `refused` is the fail-closed default for everything this command did not run at all (a bad
 * argument, a session refused before consent, a transport failure) and for any action outcome that
 * is not one of the four named here — never 0, because exiting 0 on something unrecognised reads as
 * "it worked".
 */
export const CU_EXIT_CODES = {
  deniedByOwner: 110,
  refusedOutOfEnvelope: 111,
  terminatedBudget: 112,
  terminatedWallClock: 113,
  refused: 127,
} as const;

/**
 * Map a `RunActionOutput.outcome` (a `CuOutcome` string, but received over IPC as `unknown` in
 * practice) to a process exit code. Pure and total, so it is testable without a gateway.
 *
 * Only the four outcomes the brief calls out get a dedicated code; every other outcome — including
 * ones this file has never heard of — is `refused`, fail-closed. `"actuated"` is the sole success.
 */
export function cuOutcomeExitCode(outcome: string): number {
  switch (outcome) {
    case "actuated":
      return 0;
    case "denied_by_owner":
      return CU_EXIT_CODES.deniedByOwner;
    case "refused_out_of_envelope":
      return CU_EXIT_CODES.refusedOutOfEnvelope;
    case "terminated_budget":
      return CU_EXIT_CODES.terminatedBudget;
    case "terminated_wall_clock":
      return CU_EXIT_CODES.terminatedWallClock;
    default:
      // refused_before_consent / failed_after_approval / terminated_target_lost /
      // terminated_policy / anything this command has never heard of: fail-closed.
      return CU_EXIT_CODES.refused;
  }
}

/** A live session is also terminated server-side by these three outcomes — further actions on the
 * same session would hit `ERR_CU_NO_SESSION`, so the drive loop stops here rather than retrying. */
function endsSession(outcome: string): boolean {
  return (
    outcome === "terminated_budget" ||
    outcome === "terminated_wall_clock" ||
    outcome === "terminated_policy"
  );
}

/**
 * Canonicalise one owner-supplied origin, or REFUSE it — CLIENT-side, before any IPC call.
 *
 * The gateway's own `normalizeOrigin` (`computer-use/cu-request-policy.ts`) enforces the exact same
 * rules and refuses anything this function would refuse; this is a DELIBERATE duplication, not a
 * shortcut, because `cli` reaches the gateway over IPC only (no source imports — architectural
 * non-negotiable). Resolving here rather than letting the round trip fail matters for the same
 * reason `exec.ts` resolves filesystem grant paths CLI-side: the gateway's working directory and
 * context are not the caller's, and a caller-relative value would be meaningless by the time it
 * crosses the IPC boundary. A missing `--origin`/`--script-origin` value never reaches here — the
 * arg parser rejects that first.
 *
 * REFUSE-RATHER-THAN-REDUCE, matching the gateway exactly: a path/query/fragment is refused rather
 * than silently widened to the bare origin (that GRANTS MORE than the caller typed), embedded
 * userinfo is refused rather than dropped (the leading label is a look-alike for the real host), and
 * a trailing dot on the hostname is refused (a live request's origin can never carry one, so a
 * stored origin with one would be permanently, silently inert).
 */
export function resolveOrigin(flag: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${flag} must be an absolute http(s) origin, got: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${flag} must use http or https, got: ${raw}`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${flag} must not carry userinfo (user:pass@host), got: ${raw}`);
  }
  if (url.hostname.endsWith(".")) {
    throw new Error(`${flag} must not carry a trailing dot on the hostname, got: ${raw}`);
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error(
      `${flag} must be a bare origin (scheme://host[:port]) with no path, query or fragment — ` +
        `the gateway refuses a scoped value rather than widening it to the whole origin. Got: ${raw}`,
    );
  }
  return url.origin;
}

export interface ParsedComputerBrowserArgs {
  readonly navigateOrigins: string[];
  readonly scriptOrigins: string[];
  readonly maxActions?: number;
  readonly maxWallClockMs?: number;
}

const BROWSER_USAGE =
  "Usage: nimbus computer browser --origin <origin> [--origin <origin>]... " +
  "[--script-origin <origin>]... [--max-actions <n>] [--timeout <seconds>]";

/**
 * Parse `nimbus computer browser` argv, resolving every origin to its canonical form (see
 * {@link resolveOrigin}) before it is ever sent.
 *
 * A MISSING `--origin` REFUSES rather than defaulting to an empty allowlist: an empty
 * `navigateOrigins` would open a session in which every navigation is later refused with a
 * confusing message about an origin the caller never had a chance to see coming.
 */
export function parseComputerBrowserArgs(args: readonly string[]): ParsedComputerBrowserArgs {
  const navigateOrigins: string[] = [];
  const scriptOrigins: string[] = [];
  let maxActions: number | undefined;
  let maxWallClockMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${flag} requires a value\n${BROWSER_USAGE}`);
      return v;
    };
    switch (flag) {
      case "--origin":
        navigateOrigins.push(resolveOrigin("--origin", next()));
        break;
      case "--script-origin":
        scriptOrigins.push(resolveOrigin("--script-origin", next()));
        break;
      case "--max-actions": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--max-actions must be a positive integer\n${BROWSER_USAGE}`);
        }
        maxActions = n;
        break;
      }
      case "--timeout": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--timeout must be a positive integer (seconds)\n${BROWSER_USAGE}`);
        }
        maxWallClockMs = n * 1000;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${flag}\n${BROWSER_USAGE}`);
    }
  }

  if (navigateOrigins.length === 0) {
    throw new Error(`--origin is required (at least one)\n${BROWSER_USAGE}`);
  }

  return {
    navigateOrigins,
    scriptOrigins,
    ...(maxActions === undefined ? {} : { maxActions }),
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
  };
}

const list = (v: readonly string[]): string => (v.length === 0 ? "none" : v.join(", "));

export interface EnvelopePromptInput {
  readonly sessionId: string;
  readonly lane: string;
  readonly navigateOrigins: readonly string[];
  readonly scriptOrigins: readonly string[];
  readonly maxActions: number;
  readonly maxWallClockMs: number;
}

/**
 * Render the SESSION-ENVELOPE prompt (`computer.envelopeRequest`) — one of the two prompt kinds
 * this command answers.
 *
 * Every field here is something the OWNER is choosing to grant up front, for the life of the whole
 * session: the lane, and the FULL origin lists — never elided, never summarised as "3 origins",
 * because the owner must see exactly what is approved, not a count of it. There is deliberately no
 * mention of "the model" anywhere in this render: an envelope is granted before any model utterance
 * exists to describe, and conflating the two prompt kinds' vocabulary is exactly the flattening this
 * design depends on not happening. See {@link formatActionPrompt} for the other kind.
 */
export function formatEnvelopePrompt(p: EnvelopePromptInput): string {
  return [
    "=== Open a computer-use session? ===",
    `  session:        ${p.sessionId}`,
    `  lane:           ${p.lane}`,
    `  navigate to:    ${list(p.navigateOrigins)}`,
    `  scripts reach:  ${list(p.scriptOrigins)}`,
    `  max actions:    ${p.maxActions}`,
    `  time limit:     ${p.maxWallClockMs} ms`,
  ].join("\n");
}

export interface ActionPromptInput {
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: string;
  readonly observedTarget: string;
  readonly classification: string;
  readonly why: string;
  readonly actionsUsed: number;
  readonly maxActions: number;
  readonly modelDescription: string | null;
}

/**
 * Render the PER-ACTION prompt (`computer.actionRequest`) — the second prompt kind, and visibly a
 * different thing from {@link formatEnvelopePrompt}: a different heading marker (`---` rather than
 * `===`), a different vocabulary ("approve this action" rather than "open a session"), and —
 * load-bearing — two clearly separated lines that must never be allowed to blur into one:
 *
 *   - "gateway observed" is a FACT the gateway computed from the live DOM, independent of anything
 *     the model said;
 *   - "model said" is a CLAIM the model made about its own intent, explicitly labelled UNTRUSTED.
 *
 * The whole design rests on the human reading those as two different kinds of information. Do not
 * "simplify" this by merging them onto one line or dropping the label — that is the exact failure
 * this render exists to prevent.
 */
export function formatActionPrompt(p: ActionPromptInput): string {
  return [
    "--- Approve this browser action? ---",
    `  action:            ${p.kind}  (#${p.seq}, ${p.actionsUsed}/${p.maxActions} actions used)`,
    `  gateway observed:  ${p.observedTarget}  [${p.classification}: ${p.why}]`,
    `  model said (UNTRUSTED — a claim, not a fact): ${p.modelDescription ?? "(none)"}`,
  ].join("\n");
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) && v.every((e) => typeof e === "string") ? [...(v as string[])] : [];

/** What a `computer.envelopeRequest` broadcast carries. Every field is validated before use. */
type EnvelopeBroadcast = Partial<EnvelopePromptInput> & { requestId?: string };

/**
 * Answer one `computer.envelopeRequest` broadcast.
 *
 * Mirrors `exec.ts`'s `handleApprovalBroadcast`: every field, including nested arrays, is validated
 * before `formatEnvelopePrompt` ever sees it, so a malformed broadcast renders a safe fallback and
 * still reaches `respond` — never throws first and leaves the gate to time out a request the owner
 * never saw. A broadcast with no usable `requestId` is ignored rather than answered, since replying
 * to an unknown id could at best do nothing and at worst answer a different prompt.
 */
export async function handleEnvelopeBroadcast(
  params: unknown,
  ask: (message: string) => Promise<unknown>,
  respond: (requestId: string, approved: boolean) => Promise<unknown>,
): Promise<void> {
  const p = (params ?? {}) as EnvelopeBroadcast;
  if (typeof p.requestId !== "string" || p.requestId === "") return;

  const answer = await ask(
    formatEnvelopePrompt({
      sessionId: typeof p.sessionId === "string" ? p.sessionId : "unknown",
      lane: typeof p.lane === "string" ? p.lane : "unknown",
      navigateOrigins: strs(p.navigateOrigins),
      scriptOrigins: strs(p.scriptOrigins),
      maxActions: typeof p.maxActions === "number" ? p.maxActions : 0,
      maxWallClockMs: typeof p.maxWallClockMs === "number" ? p.maxWallClockMs : 0,
    }),
  );
  await respond(p.requestId, !isCancel(answer) && answer === true);
}

/** What a `computer.actionRequest` broadcast carries. Every field is validated before use. */
type ActionBroadcast = Partial<ActionPromptInput> & { requestId?: string };

/**
 * Answer one `computer.actionRequest` broadcast. Same validate-before-render, ignore-unknown-id
 * shape as {@link handleEnvelopeBroadcast} — see that function's doc comment.
 */
export async function handleActionBroadcast(
  params: unknown,
  ask: (message: string) => Promise<unknown>,
  respond: (requestId: string, approved: boolean) => Promise<unknown>,
): Promise<void> {
  const p = (params ?? {}) as ActionBroadcast;
  if (typeof p.requestId !== "string" || p.requestId === "") return;

  const answer = await ask(
    formatActionPrompt({
      sessionId: typeof p.sessionId === "string" ? p.sessionId : "unknown",
      seq: typeof p.seq === "number" ? p.seq : 0,
      kind: typeof p.kind === "string" ? p.kind : "unknown",
      observedTarget: typeof p.observedTarget === "string" ? p.observedTarget : "unknown",
      classification: typeof p.classification === "string" ? p.classification : "unknown",
      why: typeof p.why === "string" ? p.why : "unknown",
      actionsUsed: typeof p.actionsUsed === "number" ? p.actionsUsed : 0,
      maxActions: typeof p.maxActions === "number" ? p.maxActions : 0,
      modelDescription: typeof p.modelDescription === "string" ? p.modelDescription : null,
    }),
  );
  await respond(p.requestId, !isCancel(answer) && answer === true);
}

/** One action the local operator typed at the `action>` prompt. */
export type ActionCommandAction =
  | { readonly kind: "click"; readonly selector: string }
  | { readonly kind: "type"; readonly selector: string; readonly text: string }
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "read" }
  | { readonly kind: "screenshot" }
  | { readonly kind: "download" };

export type ParsedActionCommand =
  | { readonly kind: "exit" }
  | { readonly kind: "empty" }
  | { readonly kind: "unrecognized"; readonly raw: string }
  | { readonly kind: "action"; readonly action: ActionCommandAction };

/**
 * Parse one line the local operator typed while driving an open session.
 *
 * Unrecognised input is reported (`unrecognized`), never silently dropped — matching `exec.ts`'s
 * "an omission here is a loud error there" doctrine: a typo the operator does not see would look
 * like an action that simply did nothing.
 */
export function parseActionCommand(line: string): ParsedActionCommand {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "empty" };
  if (trimmed === "exit" || trimmed === "quit") return { kind: "exit" };

  const parts = trimmed.split(/\s+/);
  const verb = parts[0];
  const rest = parts.slice(1);
  switch (verb) {
    case "click": {
      const selector = rest.join(" ");
      if (selector === "") return { kind: "unrecognized", raw: line };
      return { kind: "action", action: { kind: "click", selector } };
    }
    case "type": {
      const selector = rest[0];
      const text = rest.slice(1).join(" ");
      if (selector === undefined || text === "") return { kind: "unrecognized", raw: line };
      return { kind: "action", action: { kind: "type", selector, text } };
    }
    case "navigate": {
      const url = rest.join(" ");
      if (url === "") return { kind: "unrecognized", raw: line };
      return { kind: "action", action: { kind: "navigate", url } };
    }
    case "read":
      return { kind: "action", action: { kind: "read" } };
    case "screenshot":
      return { kind: "action", action: { kind: "screenshot" } };
    case "download":
      return { kind: "action", action: { kind: "download" } };
    default:
      return { kind: "unrecognized", raw: line };
  }
}

/** The shape of one `computer.act` reply this command reads. */
export interface ComputerActionOutcomeShape {
  readonly outcome: string;
  readonly result?: string | null;
}

/** Where rendered output goes. Injected so rendering is testable without a live process. */
export interface OutcomeSink {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

/** Render one action outcome — "the action log" the brief asks this command to stream. */
export function renderActionResult(
  seq: number,
  out: ComputerActionOutcomeShape,
  sink: OutcomeSink,
): void {
  const resultPart = out.result !== undefined && out.result !== null ? ` — ${out.result}` : "";
  sink.out(`[#${seq}] ${out.outcome}${resultPart}\n`);
}

/**
 * Actionable, honest messages per `refused` code.
 *
 * `ERR_CU_NO_BROWSER` is the ONLY outcome a real user can reach today: the browser driver is
 * deferred (re-planned against raw CDP after `playwright-core` failed a `bun build --compile`
 * gate — invariant I35), so `platform/assemble.ts` wires `resolveBrowserPath: () => null` and the
 * gate refuses every session before consent. There is no local fix for that — no Chromium install,
 * no config change — so the message says so plainly rather than suggesting a remedy that does not
 * exist. Every other code here has an actual remedy, and says what it is.
 */
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  ERR_CU_NO_BROWSER:
    "nimbus: computer-use has no browser driver in this build. The browser lane is not yet " +
    "implemented (its driver is deferred, pending a raw-CDP rewrite) — there is no local fix for " +
    "this: no browser install or configuration change will make this succeed yet.",
  ERR_CU_DISABLED:
    "nimbus: computer-use is disabled. Set [computer_use] enabled = true in nimbus.toml to use " +
    "this command.",
  ERR_CU_POLICY_DISABLED: "nimbus: computer-use is disabled by organization policy.",
  ERR_CU_LANE_NOT_ALLOWED:
    'nimbus: the browser lane is not allowed. Add "browser" to [computer_use] allowed_lanes in ' +
    "nimbus.toml.",
  ERR_CU_SANDBOX_DEGRADED:
    "nimbus: refusing to open an unconfined session — this machine's sandbox cannot confine the " +
    "browser lane's policy right now.",
  ERR_CU_BAD_ORIGIN:
    "nimbus: the gateway rejected an origin this command believed it had already normalised — " +
    "please report this as a bug.",
  ERR_CU_BAD_BOUNDS: "nimbus: the requested action count or time limit was invalid.",
  ERR_CU_LAUNCH_FAILED:
    "nimbus: the browser failed to launch after the owner approved the session.",
};

function describeRefusal(code: string): string {
  return REFUSAL_MESSAGES[code] ?? `nimbus: refused (${code})`;
}

/** The slice of the IPC client this command uses. Narrow so a test can supply one. */
export interface ComputerClient {
  onNotification(method: string, handler: (params: unknown) => unknown): void;
  call(method: string, params: unknown): Promise<unknown>;
}

/**
 * Seams this command needs from the outside world. Injected, matching `exec.ts`'s `RunExecDeps`,
 * so the orchestration is testable without a live Gateway or a live terminal.
 */
export interface RunComputerDeps {
  readonly runWithClient: <T>(fn: (c: ComputerClient) => Promise<T>) => Promise<T>;
  readonly ask: (message: string) => Promise<unknown>;
  readonly sink: OutcomeSink;
  readonly setExitCode: (code: number) => void;
  /** Reads one line of operator input while a session is open; resolves `null` at EOF. */
  readonly readLine: () => Promise<string | null>;
}

function defaultReadLine(): () => Promise<string | null> {
  let rl: ReturnType<typeof createInterface> | undefined;
  return async () => {
    rl ??= createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question("action> ");
    } catch {
      return null;
    }
  };
}

const defaultDeps: RunComputerDeps = {
  runWithClient: (fn) =>
    withGatewayIpc(fn as never, undefined, {
      // The call can block on the owner answering an envelope/action prompt, and a driven session
      // can run for a long time — the interactive budget, not the 30s default.
      requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS,
    }) as never,
  ask: (message) => confirm({ message }),
  sink: {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
  },
  setExitCode: (c) => {
    process.exitCode = c;
  },
  readLine: defaultReadLine(),
};

interface OpenSessionResultShape {
  readonly status: string;
  readonly sessionId?: string;
  readonly code?: string;
}

/**
 * Drive an already-open session interactively: read one action command at a time from the
 * operator, call `computer.act`, and render the outcome — "the action log" the brief asks this
 * command to stream. Ends on operator `exit`/`quit`, on EOF, or when the session itself terminates
 * (`terminated_budget`/`terminated_wall_clock`/`terminated_policy` — a further action on the same
 * session would only hit `ERR_CU_NO_SESSION`).
 *
 * Returns the exit code for the LAST outcome observed (0 if the operator exited cleanly having
 * triggered nothing but successful actions, or having typed no actions at all).
 */
async function driveSession(
  c: ComputerClient,
  sessionId: string,
  deps: RunComputerDeps,
): Promise<number> {
  let seq = 0;
  let lastOutcome = "actuated";
  for (;;) {
    const line = await deps.readLine();
    if (line === null) break;
    const cmd = parseActionCommand(line);
    if (cmd.kind === "empty") continue;
    if (cmd.kind === "exit") break;
    if (cmd.kind === "unrecognized") {
      deps.sink.err(`nimbus: unrecognised action: ${cmd.raw}\n`);
      continue;
    }
    seq += 1;
    let out: ComputerActionOutcomeShape;
    try {
      out = (await c.call("computer.act", {
        sessionId,
        ...cmd.action,
      })) as ComputerActionOutcomeShape;
    } catch (e) {
      deps.sink.err(`nimbus: action failed: ${e instanceof Error ? e.message : String(e)}\n`);
      break;
    }
    renderActionResult(seq, out, deps.sink);
    lastOutcome = out.outcome;
    if (endsSession(out.outcome)) break;
  }
  return cuOutcomeExitCode(lastOutcome);
}

async function runComputerBrowser(args: string[], deps: RunComputerDeps): Promise<void> {
  let parsed: ParsedComputerBrowserArgs;
  try {
    parsed = parseComputerBrowserArgs(args);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(CU_EXIT_CODES.refused);
    return;
  }

  try {
    let exitCode = 0;
    await deps.runWithClient(async (c) => {
      // Registered BEFORE the call, matching `exec.ts`: a broadcast can share a socket chunk with
      // the RPC response. Both prompt kinds are registered up front — the envelope prompt fires
      // (if at all) during `sessionOpen`; the action prompt fires for every `actuating` action for
      // the life of the session, including ones this same terminal issues below.
      c.onNotification("computer.envelopeRequest", (params: unknown) =>
        handleEnvelopeBroadcast(params, deps.ask, (requestId, approved) =>
          c.call("computer.approvalRespond", { requestId, approved }),
        ),
      );
      c.onNotification("computer.actionRequest", (params: unknown) =>
        handleActionBroadcast(params, deps.ask, (requestId, approved) =>
          c.call("computer.approvalRespond", { requestId, approved }),
        ),
      );

      const openResult = (await c.call("computer.sessionOpen", {
        lane: "browser",
        navigateOrigins: parsed.navigateOrigins,
        scriptOrigins: parsed.scriptOrigins,
        ...(parsed.maxActions === undefined ? {} : { maxActions: parsed.maxActions }),
        ...(parsed.maxWallClockMs === undefined ? {} : { maxWallClockMs: parsed.maxWallClockMs }),
      })) as OpenSessionResultShape;

      if (openResult.status === "denied") {
        deps.sink.err("nimbus: session denied by owner\n");
        exitCode = CU_EXIT_CODES.deniedByOwner;
        return;
      }
      if (openResult.status === "refused") {
        deps.sink.err(`${describeRefusal(openResult.code ?? "unknown")}\n`);
        exitCode = CU_EXIT_CODES.refused;
        return;
      }
      if (openResult.status !== "open" || openResult.sessionId === undefined) {
        deps.sink.err(`nimbus: unrecognised computer.sessionOpen reply: ${openResult.status}\n`);
        exitCode = CU_EXIT_CODES.refused;
        return;
      }

      deps.sink.out(`Session opened: ${openResult.sessionId}\n`);
      exitCode = await driveSession(c, openResult.sessionId, deps);
    });
    deps.setExitCode(exitCode);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(CU_EXIT_CODES.refused);
  }
}

interface ComputerSessionStatusEntry {
  readonly sessionId: string;
  readonly lane: string;
  readonly closedAt: number | null;
  readonly closeReason: string | null;
  readonly actionsUsed: number;
  readonly open: boolean;
}

async function runComputerSessions(deps: RunComputerDeps): Promise<void> {
  try {
    const { sessions } = (await deps.runWithClient((c) =>
      c.call("computer.sessionStatus", {}),
    )) as { sessions: ComputerSessionStatusEntry[] };
    for (const s of sessions) {
      const reason = s.closeReason !== null ? `  (${s.closeReason})` : "";
      deps.sink.out(
        `${s.sessionId}  ${s.lane}  ${s.open ? "open" : "closed"}  actions=${s.actionsUsed}${reason}\n`,
      );
    }
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(CU_EXIT_CODES.refused);
  }
}

async function runComputerClose(rest: string[], deps: RunComputerDeps): Promise<void> {
  const sessionId = rest[0];
  if (sessionId === undefined) {
    deps.sink.err("Usage: nimbus computer close <session-id>\n");
    deps.setExitCode(CU_EXIT_CODES.refused);
    return;
  }
  try {
    const out = (await deps.runWithClient((c) =>
      c.call("computer.sessionClose", { sessionId }),
    )) as { status: string };
    deps.sink.out(`${out.status}\n`);
    if (out.status !== "closed") deps.setExitCode(CU_EXIT_CODES.refused);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(CU_EXIT_CODES.refused);
  }
}

const COMPUTER_USAGE = "Usage: nimbus computer <browser|sessions|close> ...";

/**
 * `nimbus computer` — the terminal surface through which the LOCAL owner opens a computer-use
 * session and answers its consent prompts (I35). See `computer.ts`'s module doc comments for the
 * per-subcommand behaviour and {@link REFUSAL_MESSAGES} for why `browser` almost always ends in
 * `ERR_CU_NO_BROWSER` today.
 */
export async function runComputer(
  args: string[],
  deps: RunComputerDeps = defaultDeps,
): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "browser":
      await runComputerBrowser(rest, deps);
      return;
    case "sessions":
      await runComputerSessions(deps);
      return;
    case "close":
      await runComputerClose(rest, deps);
      return;
    default:
      deps.sink.err(`${COMPUTER_USAGE}\n`);
      deps.setExitCode(CU_EXIT_CODES.refused);
      return;
  }
}
