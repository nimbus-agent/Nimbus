import { resolve } from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/**
 * Distinct exit codes for the outcomes a wrapper script needs to tell apart, mirroring `exec.ts`'s
 * `EXEC_EXIT_CODES` reasoning.
 *
 * `refused` DELIBERATELY shares the value `127` with `EXEC_EXIT_CODES.refused` — that is not a
 * numbering collision to avoid, it is the same meaning reused: "this command did not run the thing
 * it was asked to run at all" (a bad argument, a session refused before consent, a transport
 * failure). The two commands are different processes, so nothing is ambiguous in practice; sharing
 * the value is a small, deliberate consistency, not an oversight.
 *
 * `deniedByOwner` covers `OpenSessionResult.status === "denied"` — the owner declined the session
 * envelope itself. This command no longer drives individual actions (see `runComputerBrowser`'s doc
 * comment for why), so a per-action `denied_by_owner`/`refused_out_of_envelope` outcome is not
 * something this file can ever observe directly; only the envelope-level denial is reachable here.
 *
 * `terminatedBudget`/`terminatedWallClock` are reachable via `computer.sessionStatus.closeReason`
 * while this command WATCHES an open session that something else is actuating — that something
 * being `cu-tools.ts`'s model-callable browser tools, which drive `runAction` in-process inside
 * the gateway, never over this RPC.
 */
export const CU_EXIT_CODES = {
  deniedByOwner: 110,
  terminatedBudget: 112,
  terminatedWallClock: 113,
  refused: 127,
  /**
   * `128 + SIGINT(2)`, the POSIX convention a shell reports for a Ctrl-C'd child. Deliberately the
   * conventional number rather than another value in this file's 11x block: a wrapper script asking
   * "was this interrupted?" already knows to test for 130, and inventing a Nimbus-specific code for
   * a signal every other program reports the same way would be a gratuitous difference.
   */
  interrupted: 130,
} as const;

/**
 * Map a `RunActionOutput.outcome` / `cu_session.close_reason` value (a `CuOutcome` string, but
 * received over IPC as `unknown` in practice) to a process exit code. Pure and total, so it is
 * testable without a gateway.
 *
 * Only the outcomes this command can actually observe get a dedicated code; every other value —
 * including ones this file has never heard of — is `refused`, fail-closed. `"actuated"` is the sole
 * success value distinct from a clean session close (see {@link exitCodeForCloseReason}).
 */
export function cuOutcomeExitCode(outcome: string): number {
  switch (outcome) {
    case "actuated":
      return 0;
    case "denied_by_owner":
      return CU_EXIT_CODES.deniedByOwner;
    case "terminated_budget":
      return CU_EXIT_CODES.terminatedBudget;
    case "terminated_wall_clock":
      return CU_EXIT_CODES.terminatedWallClock;
    default:
      // refused_before_consent / refused_out_of_envelope / failed_after_approval /
      // terminated_target_lost / terminated_policy / anything this command has never heard of:
      // fail-closed.
      return CU_EXIT_CODES.refused;
  }
}

/**
 * Map a closed session's `closeReason` to an exit code. A `null` reason or the owner's own
 * explicit `nimbus computer close` (`"owner"`) is a CLEAN shutdown, not a failure, so both map to
 * 0 — `cuOutcomeExitCode` would wrongly fail-close on `"owner"`, since that string is not one of
 * the outcomes it recognises.
 */
function exitCodeForCloseReason(closeReason: string | null): number {
  if (closeReason === null || closeReason === "owner") return 0;
  return cuOutcomeExitCode(closeReason);
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

/**
 * Render a millisecond duration as a human-scaled string (e.g. `90000` -> `"1m 30s"`). Used
 * ALONGSIDE the raw millisecond figure in {@link formatEnvelopePrompt}, never instead of it — full
 * disclosure means showing the exact value the gateway will enforce, and this is purely a
 * readability aid for a prompt a human must read and act on, often under time pressure.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

export interface BrowserEnvelopePromptInput {
  readonly lane: "browser";
  readonly sessionId: string;
  readonly navigateOrigins: readonly string[];
  readonly scriptOrigins: readonly string[];
  readonly maxActions: number;
  readonly maxWallClockMs: number;
}

export interface TerminalEnvelopePromptInput {
  readonly lane: "terminal";
  readonly sessionId: string;
  readonly shellId: string;
  readonly cwd: string;
  readonly maxActions: number;
  readonly maxWallClockMs: number;
}

/**
 * A UNION on `lane`, not one shape with per-lane optional fields.
 *
 * The two lanes grant completely different things — origin lists versus a shell in a directory —
 * and an optional-field shape would compile while rendering a prompt describing a grant that is not
 * the one being requested. On this surface that is not a cosmetic bug: the prompt IS the boundary.
 */
export type EnvelopePromptInput = BrowserEnvelopePromptInput | TerminalEnvelopePromptInput;

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
  const bounds = [
    `  max actions:    ${p.maxActions}`,
    `  time limit:     ${p.maxWallClockMs} ms (${formatDuration(p.maxWallClockMs)})`,
  ];
  if (p.lane === "terminal") {
    return [
      "=== Open a computer-use session? ===",
      `  session:        ${p.sessionId}`,
      "  lane:           terminal",
      `  shell:          ${p.shellId}`,
      `  directory:      ${p.cwd}`,
      // Stated because it bounds the blast radius and because a reader would otherwise
      // assume the opposite: a shell that can reach the network is a different grant
      // entirely, and the owner must know which one they are giving.
      "  network:        NONE (including localhost)",
      "  every command:  shown to you in full and approved individually before it runs",
      ...bounds,
    ].join("\n");
  }
  return [
    "=== Open a computer-use session? ===",
    `  session:        ${p.sessionId}`,
    "  lane:           browser",
    `  navigate to:    ${list(p.navigateOrigins)}`,
    `  scripts reach:  ${list(p.scriptOrigins)}`,
    ...bounds,
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
    "--- Approve this computer-use action? ---",
    `  action:            ${p.kind}  (#${p.seq}, ${p.actionsUsed}/${p.maxActions} actions used)`,
    `  gateway observed:  ${p.observedTarget}  [${p.classification}: ${p.why}]`,
    `  model said (UNTRUSTED — a claim, not a fact): ${p.modelDescription ?? "(none)"}`,
  ].join("\n");
}

const strs = (v: unknown): string[] =>
  Array.isArray(v) && v.every((e) => typeof e === "string") ? [...(v as string[])] : [];

/** What a `computer.envelopeRequest` broadcast carries. Every field is validated before use. */
/**
 * What a `computer.envelopeRequest` broadcast carries, as WIRE shape rather than as the prompt
 * type: `lane` is a bare `string` here because the value arrives from the socket and has not been
 * narrowed yet, and every field is validated before the renderer sees it.
 */
type EnvelopeBroadcast = {
  requestId?: string;
  sessionId?: string;
  lane?: string;
  navigateOrigins?: unknown;
  scriptOrigins?: unknown;
  shellId?: string;
  cwd?: string;
  maxActions?: number;
  maxWallClockMs?: number;
};

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
  const sessionId = typeof p.sessionId === "string" ? p.sessionId : "unknown";
  const maxActions = typeof p.maxActions === "number" ? p.maxActions : 0;
  const maxWallClockMs = typeof p.maxWallClockMs === "number" ? p.maxWallClockMs : 0;

  // An UNRECOGNISED lane is DENIED without asking, and that is the important branch. Falling back
  // to the browser render — the obvious alternative — would show the owner a prompt describing a
  // grant that is not the one being requested: "navigate to: none", no shell, no directory, while
  // the gateway holds something else entirely. Asking a human to approve a thing this command
  // cannot describe is worse than refusing it, and a refusal is recoverable while a mistaken
  // approval is not.
  //
  // It still RESPONDS rather than returning silently: leaving the gate to time out would deny by
  // TTL after the owner had been shown nothing at all — the same outcome, reached slower and with
  // no explanation on screen.
  if (p.lane !== "browser" && p.lane !== "terminal") {
    await respond(p.requestId, false);
    return;
  }

  const prompt: EnvelopePromptInput =
    p.lane === "terminal"
      ? {
          lane: "terminal",
          sessionId,
          shellId: typeof p.shellId === "string" ? p.shellId : "unknown",
          cwd: typeof p.cwd === "string" ? p.cwd : "unknown",
          maxActions,
          maxWallClockMs,
        }
      : {
          lane: "browser",
          sessionId,
          navigateOrigins: strs(p.navigateOrigins),
          scriptOrigins: strs(p.scriptOrigins),
          maxActions,
          maxWallClockMs,
        };
  const answer = await ask(formatEnvelopePrompt(prompt));
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

/** Where rendered output goes. Injected so rendering is testable without a live process. */
export interface OutcomeSink {
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}

/**
 * Actionable, honest messages per `refused` code.
 *
 * Every code here has a real remedy and names it. That is worth stating because it was NOT true
 * before the raw-CDP driver landed: `ERR_CU_NO_BROWSER` used to be unfixable — the driver did not
 * exist, so no browser install or config change could make a session succeed, and this map said so
 * rather than suggesting a remedy that was not available. It now means what it says.
 *
 * The ORDER a real user meets these matters more than any single message: with the shipped defaults
 * (`enabled = false`, `allowed_lanes = []`) they hit `ERR_CU_DISABLED` first, then
 * `ERR_CU_LANE_NOT_ALLOWED`, then — only past both — a launch-policy or browser-presence refusal.
 *
 * `ERR_CU_SANDBOX_DEGRADED` was REMOVED rather than left in place: the browser lane no longer
 * asserts `SandboxRunner.canConfine` (it does not spawn through the PAL — see invariant I35), so
 * the gate cannot emit that code, and a message for an unreachable code is documentation drift.
 * A later lane that does spawn through the PAL should add it back with its own wording.
 */
const REFUSAL_MESSAGES: Readonly<Record<string, string>> = {
  ERR_CU_NO_BROWSER:
    "nimbus: no Chrome, Chromium or Edge was found. Install a Chromium-family browser, or set " +
    "NIMBUS_CHROMIUM_PATH to an absolute path to one (it must exist; a relative path is refused).",
  ERR_CU_UNSAFE_LAUNCH:
    "nimbus: refusing to launch an under-confined browser. Most often [computer_use] " +
    "browser_profile_dir is empty or relative — it must be an absolute path, because Chromium " +
    "with no --user-data-dir runs against your real browser profile.",
  ERR_CU_DISABLED:
    "nimbus: computer-use is disabled. Set [computer_use] enabled = true in nimbus.toml to use " +
    "this command.",
  ERR_CU_POLICY_DISABLED: "nimbus: computer-use is disabled by organization policy.",
  ERR_CU_LANE_NOT_ALLOWED:
    'nimbus: the browser lane is not allowed. Add "browser" to [computer_use] allowed_lanes in ' +
    "nimbus.toml.",
  ERR_CU_BAD_ORIGIN:
    "nimbus: the gateway rejected an origin this command believed it had already normalised — " +
    "please report this as a bug.",
  ERR_CU_BAD_BOUNDS: "nimbus: the requested action count or time limit was invalid.",
  ERR_CU_LAUNCH_FAILED:
    "nimbus: the browser failed to launch after the owner approved the session.",
  ERR_CU_NO_SHELL:
    "nimbus: no usable shell was found for the terminal lane. On Windows that means cmd.exe was " +
    String.raw`not found under %SystemRoot%\System32; elsewhere, /usr/bin/sh or /bin/sh.`,
  ERR_CU_UNKNOWN_SHELL:
    "nimbus: --shell named an id this build does not register. Supported ids: sh (POSIX), cmd " +
    "(Windows). Omit --shell to use the platform default.",
  // Restored with this lane. It was DELETED when the browser lane dropped its placeholder
  // `canConfine` assertion, with a note saying a later lane that does spawn through the PAL should
  // add it back with its own wording. This is that lane, and this is that wording.
  ERR_CU_SANDBOX_DEGRADED:
    "nimbus: refusing to open a terminal session that cannot be confined. On Linux install " +
    "bubblewrap (bwrap); on Windows ensure nimbus-sandbox-helper.exe sits beside the nimbus " +
    "binary. The terminal lane spawns a real shell and will not do so unsandboxed.",
  ERR_CU_TERMINAL_NETWORK_UNSUPPORTED:
    "nimbus: the terminal lane has no network access, by design — it cannot be granted.",
  ERR_CU_TERMINAL_RELATIVE_CWD:
    "nimbus: --cwd must be an absolute path (the gateway refuses to resolve a relative one " +
    "against its own working directory, which is not yours).",
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
 * so the orchestration is testable without a live Gateway.
 */
export interface RunComputerDeps {
  readonly runWithClient: <T>(fn: (c: ComputerClient) => Promise<T>) => Promise<T>;
  readonly ask: (message: string) => Promise<unknown>;
  readonly sink: OutcomeSink;
  readonly setExitCode: (code: number) => void;
  /** Paces the session-status poll loop that watches an open session for its close. */
  readonly sleep: (ms: number) => Promise<void>;
  /**
   * Register an interrupt handler; returns an unregister function.
   *
   * Injected rather than calling `process.on` inline for the usual reason — a test cannot raise a
   * real SIGINT portably (Windows has no `kill -INT` to a specific process from `bun test`) — and
   * for one specific to this file: leaving a real listener attached after a test would change how
   * the TEST RUNNER responds to Ctrl-C.
   */
  readonly onSignal: (handler: () => void) => () => void;
}

const defaultDeps: RunComputerDeps = {
  runWithClient: (fn) =>
    withGatewayIpc(fn as never, undefined, {
      // The call can block on the owner answering an envelope/action prompt, and this command then
      // watches the session for as long as it stays open — the interactive budget, not the 30s
      // default.
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
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onSignal: (handler) => {
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    };
  },
};

interface OpenSessionResultShape {
  readonly status: string;
  readonly sessionId?: string;
  readonly code?: string;
}

interface ComputerSessionStatusEntry {
  readonly sessionId: string;
  readonly lane: string;
  readonly closedAt: number | null;
  readonly closeReason: string | null;
  readonly actionsUsed: number;
  readonly open: boolean;
}

/** How often to re-poll `computer.sessionStatus` while watching an open session. */
const SESSION_POLL_MS = 2000;

/**
 * Sentinel resolved by {@link AbortSignalish.whenAborted}. A unique object rather than a boolean or
 * `undefined`, so `Promise.race` can tell "the abort won" from a legitimate result of the same
 * shape — a status call that resolved to `undefined` must not read as an interrupt.
 */
const ABORTED = Symbol("nimbus.computer.aborted");

/**
 * A minimal cancellation handle. Not `AbortController`: the watch loop races PROMISES (an RPC and a
 * sleep), so what it needs is a promise that settles on abort, and a synchronous predicate for the
 * top-of-loop check. Kept local and tiny so the loop stays readable.
 */
interface AbortSignalish {
  aborted(): boolean;
  whenAborted(): Promise<typeof ABORTED>;
}

const NEVER_ABORTS: AbortSignalish = {
  aborted: () => false,
  whenAborted: () => new Promise<typeof ABORTED>(() => {}),
};

/** An {@link AbortSignalish} plus the `abort()` that trips it. */
function makeAbort(): AbortSignalish & { abort: () => void } {
  let flag = false;
  let trip: (() => void) | undefined;
  const promise = new Promise<typeof ABORTED>((resolve) => {
    trip = () => resolve(ABORTED);
  });
  return {
    aborted: () => flag,
    whenAborted: () => promise,
    abort: () => {
      flag = true;
      trip?.();
    },
  };
}

/**
 * Watch an already-open session until it closes, printing the action count as it changes and the
 * final close reason — "the action log" the brief asks this command to stream.
 *
 * This is a PASSIVE LISTENER, not a driver, and that is the design rather than a gap.
 * `computer.act` has no production caller from THIS command: what actuates a session is
 * `cu-tools.ts`'s `buildComputerUseTools`, driving `runAction` in-process from inside the gateway
 * and only while a session is live — never over this RPC. This command's only job is to keep both
 * consent-broker handlers registered, close the session cleanly on an interrupt, and show a human
 * what happened, per spec § 9: "opens a session and streams the action log; the owner answers
 * prompts inline" — a listen-and-approve terminal, not a command shell.
 *
 * An earlier version of this file let the LOCAL OPERATOR type actions here directly. That was
 * removed: it never populated `modelDescription`, so every actuating prompt an operator drove
 * themselves rendered `model said (UNTRUSTED — a claim, not a fact): (none)` — every single time —
 * teaching the operator that line is routinely empty and skippable, which destroys exactly the
 * vigilance the fact/claim split exists to build on the one surface this whole design leans on a
 * human reading carefully. It also put "approve a command I just typed" muscle memory directly
 * beside "approve what a model just proposed," in the same terminal — the fatigue failure this
 * design exists to prevent, introduced by the tooling meant to expose it.
 */
async function watchSessionUntilClosed(
  c: ComputerClient,
  sessionId: string,
  deps: RunComputerDeps,
  abort: AbortSignalish = NEVER_ABORTS,
): Promise<number> {
  let lastActionsUsed = -1;
  for (;;) {
    if (abort.aborted()) return CU_EXIT_CODES.interrupted;
    // RACED against the abort, not merely checked before it. A flag consulted only at the top of
    // the loop leaves the command sitting through whatever is already in flight: a second Ctrl-C
    // arriving while this status request (or the sleep below) is pending printed its recovery
    // guidance and then waited anyway — the exact opposite of what a second interrupt means. The
    // gateway may be wedged, in which case the request never settles at all.
    const status = await Promise.race([
      c.call("computer.sessionStatus", { sessionId }),
      abort.whenAborted(),
    ]);
    if (status === ABORTED) return CU_EXIT_CODES.interrupted;
    const { sessions } = status as { sessions: ComputerSessionStatusEntry[] };
    const entry = sessions[0];
    if (entry === undefined) {
      deps.sink.err(`nimbus: session ${sessionId} is no longer known to the gateway\n`);
      return CU_EXIT_CODES.refused;
    }
    if (entry.actionsUsed !== lastActionsUsed) {
      deps.sink.out(`actions used: ${entry.actionsUsed}\n`);
      lastActionsUsed = entry.actionsUsed;
    }
    if (!entry.open) {
      deps.sink.out(
        entry.closeReason === null
          ? "Session closed.\n"
          : `Session closed (${entry.closeReason}).\n`,
      );
      return exitCodeForCloseReason(entry.closeReason);
    }
    // The sleep is raced too: most of this loop's life is spent here, so it is where a second
    // interrupt is most likely to land.
    if ((await Promise.race([deps.sleep(SESSION_POLL_MS), abort.whenAborted()])) === ABORTED) {
      return CU_EXIT_CODES.interrupted;
    }
  }
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
      // the life of the session, driven by whatever else is acting on it.
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

      const sessionId = openResult.sessionId;
      deps.sink.out(`Session opened: ${sessionId}\n`);

      // Ctrl-C used to leave the session OPEN SERVER-SIDE: this process exited, and the gateway
      // kept a live headless browser inside an approved envelope with nothing left watching it —
      // until its wall-clock ceiling expired, which for the default `[computer_use]` bounds is five
      // minutes of an unobserved browser holding whatever the page had loaded. Worse, the owner had
      // no signal that it was still there: `nimbus computer sessions` would show it open and the
      // only way to end it was to know the id and run `nimbus computer close`.
      //
      // The session belongs to the GATEWAY, not to this process, so the fix is to ask the gateway
      // to close it, not to exit harder. A second interrupt stops waiting — if the first close is
      // not landing, blocking the user's terminal on it is the wrong trade, and the message names
      // the recovery command rather than leaving them to find it.
      let interrupted = false;
      const forced = makeAbort();
      const unregisterSignals = deps.onSignal(() => {
        if (interrupted) {
          forced.abort();
          deps.sink.err(
            `nimbus: giving up on a clean close — the session may still be open. Run: nimbus computer close ${sessionId}\n`,
          );
          return;
        }
        interrupted = true;
        deps.sink.err("\nnimbus: interrupted — closing the computer-use session...\n");
        void Promise.resolve(c.call("computer.sessionClose", { sessionId })).catch(() => {
          // The watch loop reports what actually happened to the session; a failed close attempt
          // must not raise here, where nothing can await it.
        });
      });

      try {
        exitCode = await watchSessionUntilClosed(c, sessionId, deps, forced);
      } finally {
        unregisterSignals();
      }
      // A clean close driven by our own interrupt still exits 130: the session ended tidily, but
      // the COMMAND was interrupted, and that is what a caller is asking about.
      if (interrupted) exitCode = CU_EXIT_CODES.interrupted;
    });
    deps.setExitCode(exitCode);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(CU_EXIT_CODES.refused);
  }
}

export interface ParsedComputerTerminalArgs {
  readonly cwd: string;
  readonly shellId?: string;
  readonly maxActions?: number;
  readonly maxWallClockMs?: number;
}

const TERMINAL_USAGE =
  "Usage: nimbus computer terminal --cwd <dir> [--shell <id>] [--max-actions <n>] [--timeout <seconds>]";

/**
 * Parse `nimbus computer terminal` argv.
 *
 * `--cwd` is REQUIRED and resolved CLIENT-side, for the reason `exec.ts` resolves its filesystem
 * grant paths here: the gateway's working directory is not the caller's, so a relative value would
 * be meaningless by the time it crossed IPC — and the gateway refuses a relative path outright
 * rather than resolving it against something the caller never saw.
 */
export function parseComputerTerminalArgs(args: readonly string[]): ParsedComputerTerminalArgs {
  let cwd: string | undefined;
  let shellId: string | undefined;
  let maxActions: number | undefined;
  let maxWallClockMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${flag} requires a value\n${TERMINAL_USAGE}`);
      return v;
    };
    switch (flag) {
      case "--cwd":
        cwd = resolve(next());
        break;
      case "--shell":
        shellId = next();
        break;
      case "--max-actions": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--max-actions must be a positive integer\n${TERMINAL_USAGE}`);
        }
        maxActions = n;
        break;
      }
      case "--timeout": {
        const n = Number.parseInt(next(), 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error(`--timeout must be a positive integer (seconds)\n${TERMINAL_USAGE}`);
        }
        maxWallClockMs = n * 1000;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${flag}\n${TERMINAL_USAGE}`);
    }
  }

  if (cwd === undefined) throw new Error(`--cwd is required\n${TERMINAL_USAGE}`);
  return {
    cwd,
    ...(shellId === undefined ? {} : { shellId }),
    ...(maxActions === undefined ? {} : { maxActions }),
    ...(maxWallClockMs === undefined ? {} : { maxWallClockMs }),
  };
}

/**
 * `nimbus computer terminal` — opens a sandboxed shell session and watches it.
 *
 * A PASSIVE LISTENER, exactly like `runComputerBrowser`, and for the same recorded reason: letting
 * the local operator type commands here would render `model said (UNTRUSTED — a claim, not a fact):
 * (none)` on every prompt, teaching the owner that the line is routinely empty and skippable —
 * which destroys the vigilance the fact/claim split exists to build, on the one surface this whole
 * design leans on a human reading carefully.
 */
async function runComputerTerminal(args: string[], deps: RunComputerDeps): Promise<void> {
  let parsed: ParsedComputerTerminalArgs;
  try {
    parsed = parseComputerTerminalArgs(args);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(CU_EXIT_CODES.refused);
    return;
  }

  try {
    let exitCode = 0;
    await deps.runWithClient(async (c) => {
      // Registered BEFORE the call: a broadcast can share a socket chunk with the RPC response.
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
        lane: "terminal",
        cwd: parsed.cwd,
        ...(parsed.shellId === undefined ? {} : { shellId: parsed.shellId }),
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

      const sessionId = openResult.sessionId;
      deps.sink.out(`Session opened: ${sessionId}\n`);

      // Ctrl-C asks the GATEWAY to close the session rather than just exiting: the session belongs
      // to the gateway, and a shell left running inside an approved envelope with nothing watching
      // it is exactly what the browser lane's own interrupt handling exists to prevent.
      let interrupted = false;
      const forced = makeAbort();
      const unregisterSignals = deps.onSignal(() => {
        if (interrupted) {
          forced.abort();
          deps.sink.err(
            `nimbus: giving up on a clean close — the session may still be open. Run: nimbus computer close ${sessionId}\n`,
          );
          return;
        }
        interrupted = true;
        deps.sink.err("\nnimbus: interrupted — closing the computer-use session...\n");
        void Promise.resolve(c.call("computer.sessionClose", { sessionId })).catch(() => {
          // The watch loop reports what actually happened; a failed close must not raise here,
          // where nothing can await it.
        });
      });

      try {
        exitCode = await watchSessionUntilClosed(c, sessionId, deps, forced);
      } finally {
        unregisterSignals();
      }
      if (interrupted) exitCode = CU_EXIT_CODES.interrupted;
    });
    deps.setExitCode(exitCode);
  } catch (e) {
    deps.sink.err(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.setExitCode(CU_EXIT_CODES.refused);
  }
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

const COMPUTER_USAGE = "Usage: nimbus computer <browser|terminal|sessions|close> ...";

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
    case "terminal":
      await runComputerTerminal(rest, deps);
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
