import {
  type BriefTextFormat,
  formatBriefText,
  isBriefTextFormat,
} from "../format/slack-markdown.ts";
import type { IPCClient } from "../ipc-client/index.ts";
import { briefTextFor, resolveBriefTimeoutMs } from "../lib/agent-brief-render.ts";
import { agentBriefClientOrExit } from "../lib/agent-cli-dispatcher.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { disconnectQuietly } from "../lib/disconnect-quietly.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";

/** Shared notification-wait bound, resolved from the single definition in
 * `lib/agent-brief-render.ts` (honours NIMBUS_BRIEF_TIMEOUT_MS). Exported so
 * sibling read paths outside `runAgentBriefCli` (e.g. `glossary`'s `--rebuild`
 * preview read) fail closed with the same discipline instead of hanging.
 * A function, not a const: the value is read per call, so an override applies
 * without a rebuild and a stale module-load snapshot cannot pin it. */
export const briefTimeoutMs = resolveBriefTimeoutMs;

/** Reads the value following a `--flag`, rejecting empty / another-flag values. Shared by agent CLIs. */
export function flagValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (typeof v !== "string" || v.trim().length === 0 || v.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return v.trim();
}

/**
 * The flags every pasteable-brief command (`changelog`, `standup`, `oncall`) shares, exactly as
 * typed. `since` stays a string: each command converts it itself — only `oncall` also bounds it
 * locally (`changelog` and `standup` leave the 90d bound to the gateway) — and `oncall` must
 * refuse an `--incident`/`--service` pair BEFORE it reports a bad duration.
 */
export type BriefCommandFlags<V extends string> = {
  since: string;
  format: BriefTextFormat;
  json: boolean;
  /** The command's own value flags, keyed by flag name (`"--service"`); absent when not given. */
  values: Partial<Record<V, string>>;
};

export type BriefCommandFlagSpec<V extends string> = {
  /** Appended to every refusal, and thrown on its own for `--help` / `-h`. */
  usage: string;
  /** `--since` when the flag is not given. */
  defaultSince: string;
  /** The command's own value flags, each consuming the next argument (`flagValue`). */
  valueFlags: readonly V[];
};

/** `--format`'s value — refused, with the usage text, unless it names a known format. */
function parseBriefFormat(raw: string, usage: string): BriefTextFormat {
  if (!isBriefTextFormat(raw)) {
    throw new Error(`--format must be one of markdown, slack, plain (got: ${raw})\n${usage}`);
  }
  return raw;
}

/** Whether `a` is one of the command's own value flags — the narrowing `values[a]` needs. */
function isValueFlag<V extends string>(valueFlags: readonly V[], a: string | undefined): a is V {
  const declared: readonly (string | undefined)[] = valueFlags;
  return declared.includes(a);
}

/**
 * Walk a pasteable-brief command's argv once: `--json`, `--since <duration>`,
 * `--format markdown|slack|plain`, `--help`/`-h`, and the command's own value flags. An unknown
 * `--flag` or a positional argument is REFUSED with the usage text rather than ignored: silently
 * dropping `--sicne 7d` would print a one-day brief to a user who believes they asked for a week.
 */
export function scanBriefCommandFlags<V extends string = never>(
  args: string[],
  spec: BriefCommandFlagSpec<V>,
): BriefCommandFlags<V> {
  let since = spec.defaultSince;
  let format: BriefTextFormat = "markdown";
  let json = false;
  const values: Partial<Record<V, string>> = {};

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--since") {
      since = flagValue(args, i, "--since");
      i += 1;
    } else if (a === "--format") {
      format = parseBriefFormat(flagValue(args, i, "--format"), spec.usage);
      i += 1;
    } else if (a === "--help" || a === "-h") {
      throw new Error(spec.usage);
    } else if (isValueFlag(spec.valueFlags, a)) {
      values[a] = flagValue(args, i, a);
      i += 1;
    } else if (a?.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}\n${spec.usage}`);
    } else {
      throw new Error(`Unexpected argument: ${String(a)}\n${spec.usage}`);
    }
  }

  return { since, format, json, values };
}

/**
 * A pasteable-brief command's output: `--json` prints the structured findings verbatim; otherwise
 * the brief's own Markdown goes through the `--format` transform. Never ANSI — `markdown`/`slack`/
 * `plain` are all colorless text, so there is nothing for NO_COLOR to strip.
 */
export function writeBriefOutput(
  brief: string,
  findings: unknown,
  opts: { json: boolean; format: BriefTextFormat },
): void {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    return;
  }
  // These transforms operate on the Markdown the brief already rendered — synthesis may have
  // rewritten it into prose, and re-deriving output from `findings` here would silently discard
  // that prose. See `format/slack-markdown.ts`.
  process.stdout.write(`${formatBriefText(brief, opts.format)}\n`);
}

/**
 * Shared driver for the cross-colleague agent CLI commands (ghost / conflicts / huddle).
 * Each command is a thin parse + a single `runAgentBriefCli` call: this helper owns the
 * gateway-state read, the IPC connect, the `<kind>.briefReady`/`<kind>.briefError`
 * notification wait, the json/markdown render, and the exit codes (1 = no gateway,
 * 2 = agent error / malformed payload). Behavior is identical across kinds.
 */
export type AgentBriefCliSpec<TFindings> = {
  /** Agent kind; drives the `agents.<kind>` IPC method + `<kind>.brief*` notifications. */
  kind: string;
  /** Runtime guard validating the `findings` payload of `<kind>.briefReady`. */
  guard: (x: unknown) => x is TFindings;
  /** Whether to print structured JSON findings (`true`) or the Markdown brief (`false`). */
  json: boolean;
  /** Params forwarded verbatim to the `agents.<kind>` IPC call. */
  params: Record<string, unknown>;
  /** Notification wait timeout (ms). Defaults to 30 s; raise for human-gated agents (preflight). */
  timeoutMs?: number;
  /** Invoked with the typed findings before output — lets a command set its own exit code. */
  onResult?: (findings: TFindings) => void;
  /**
   * Runs after connect, BEFORE the brief-notification timer is armed. Used by
   * `glossary --refresh` to drive a pass that can take minutes; arming the 30 s
   * brief timeout first would kill it.
   */
  beforeCall?: (client: IPCClient) => Promise<void>;
};

function awaitBrief<TFindings>(
  client: IPCClient,
  spec: AgentBriefCliSpec<TFindings>,
  onTimer: (t: ReturnType<typeof setTimeout>) => void,
): Promise<{ brief: string; findings: TFindings }> {
  const timeoutMs = spec.timeoutMs ?? briefTimeoutMs();
  return new Promise<{ brief: string; findings: TFindings }>((resolve, reject) => {
    onTimer(
      setTimeout(
        () => reject(new Error(`Agent timed out after ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      ),
    );
    client.onNotification(`${spec.kind}.briefReady`, (params: unknown) => {
      if (params === null || typeof params !== "object") {
        reject(new Error(`Malformed ${spec.kind}.briefReady payload`));
        return;
      }
      const p = params as { sessionId?: string; brief?: string; findings?: unknown };
      if (typeof p.brief !== "string" || !spec.guard(p.findings)) {
        reject(new Error(`Malformed ${spec.kind}.briefReady payload`));
        return;
      }
      resolve({ brief: p.brief, findings: p.findings });
    });
    client.onNotification(`${spec.kind}.briefError`, (params: unknown) => {
      if (params === null || typeof params !== "object") {
        reject(new Error("Agent failed"));
        return;
      }
      const p = params as { error?: string };
      reject(new Error(p.error ?? "Agent failed"));
    });
  });
}

export async function runAgentBriefCli<TFindings>(
  spec: AgentBriefCliSpec<TFindings>,
): Promise<void> {
  const { client, demo } = await agentBriefClientOrExit();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect();
    registerInteractiveCliIpcHandlers(client);
    if (spec.beforeCall !== undefined) await spec.beforeCall(client);
    const briefPromise = awaitBrief(client, spec, (t) => {
      timeout = t;
    });
    // Watch it FROM CREATION. Between this line and the `await` below, nothing was attached to
    // `briefPromise`, so a `briefError` arriving in that window was an unhandled rejection at
    // that instant — and Bun printed a code frame plus a ten-frame stack from the compiled
    // binary before the outer `catch` wrote the clean message. Observed on `nimbus pre-mortem
    // "S2"`: an unresolvable Jira key is the gateway's fastest possible rejection, needing no
    // work, so it lands squarely in the gap. `why` / `janitor` / `impact` never showed it only
    // because they render a brief with gap notes instead of rejecting.
    //
    // The no-op catch silences the RUNTIME, not the error: the rejection is still delivered to
    // the real `await` below, and the `catch` there still writes the message and exits 2.
    briefPromise.catch(() => {});
    await client.call<{ sessionId: string }>(`agents.${spec.kind}`, spec.params);
    const { brief, findings } = await briefPromise;
    spec.onResult?.(findings);
    if (spec.json) {
      process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    } else {
      process.stdout.write(`${briefTextFor(brief, { demo })}\n`);
    }
  } catch (err) {
    // `spec.beforeCall`/`spec.onResult` are caller-supplied extension points (see decisions.ts,
    // glossary.ts, owners.ts, preflight.ts) — none throws CliExit today, but re-labelling one that
    // did would silently swallow its code and print a stray message, exactly as runAgentCli's catch
    // would have done for renderAgentBrief's empty-index CliExit(1).
    if (err instanceof CliExit) throw err;
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    throw new CliExit(2);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    // IPCClient.disconnect() is safe even when connect() was never called (null socket guards).
    await disconnectQuietly(client);
  }
}
