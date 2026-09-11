import { toPlainText, toSlackMrkdwn } from "../format/slack-markdown.ts";
import { IPCClient } from "../ipc-client/index.ts";
import { awaitAgentBrief, type PendingBrief } from "../lib/agent-brief-render.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { parseDurationToMs } from "../lib/parse-duration.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { flagValue } from "./_agent-brief-cli.ts";

/**
 * Local structural stand-in for the gateway's `ChangelogBrief`
 * (`agents/_lib/changelog-types.ts`). The CLI cannot import gateway source (IPC-only rule) —
 * the same situation `decisions.ts`'s `DecisionsBriefLike` documents. Only the fields this
 * command actually needs to confirm the shape are checked; `--json` prints the object verbatim,
 * whatever extra fields it carries.
 */
export type ChangelogBriefLike = {
  kind: "changelog";
  mergedPrs: unknown[];
  deployments: unknown[];
  incidentsOpened: unknown[];
  incidentsResolved: unknown[];
  gaps: unknown[];
};

export function isChangelogBriefLike(v: unknown): v is ChangelogBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    b["kind"] === "changelog" &&
    Array.isArray(b["mergedPrs"]) &&
    Array.isArray(b["deployments"]) &&
    Array.isArray(b["incidentsOpened"]) &&
    Array.isArray(b["incidentsResolved"]) &&
    Array.isArray(b["gaps"])
  );
}

export type ChangelogFormat = "markdown" | "slack" | "plain";

const CHANGELOG_FORMATS: ReadonlySet<string> = new Set<ChangelogFormat>([
  "markdown",
  "slack",
  "plain",
]);

function isChangelogFormat(v: string): v is ChangelogFormat {
  return CHANGELOG_FORMATS.has(v);
}

export type ChangelogCliArgs = {
  sinceMs: number;
  service: string | undefined;
  format: ChangelogFormat;
  json: boolean;
};

const DEFAULT_SINCE = "7d";

const USAGE =
  "Usage: nimbus changelog [--service <name>] [--since <duration>] " +
  "[--format markdown|slack|plain] [--json]\n" +
  "  --service    a [ci.service.<id>] service id to scope the window to\n" +
  "  --since      lookback duration, e.g. 7d, 24h (default: 7d; max 90d — the gateway\n" +
  "               refuses a longer window)\n" +
  "  --format     markdown (default) | slack | plain — a text transform over the\n" +
  "               brief's Markdown, never a re-render from findings\n" +
  "  --json       print structured findings instead of the brief";

export function parseChangelogArgs(args: string[]): ChangelogCliArgs {
  let since = DEFAULT_SINCE;
  let service: string | undefined;
  let format: ChangelogFormat = "markdown";
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--since") {
      since = flagValue(args, i, "--since");
      i += 1;
    } else if (a === "--service") {
      service = flagValue(args, i, "--service");
      i += 1;
    } else if (a === "--format") {
      const raw = flagValue(args, i, "--format");
      if (!isChangelogFormat(raw)) {
        throw new Error(`--format must be one of markdown, slack, plain (got: ${raw})\n${USAGE}`);
      }
      format = raw;
      i += 1;
    } else if (a === "--help" || a === "-h") {
      throw new Error(USAGE);
    } else if (typeof a === "string" && a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    } else {
      throw new Error(`Unexpected argument: ${String(a)}\n${USAGE}`);
    }
  }

  return { sinceMs: parseDurationToMs(since), service, format, json };
}

export type ChangelogFetchParams = { sinceMs: number; service?: string };
export type ChangelogFetchResult = { brief: string; findings: ChangelogBriefLike };

/**
 * The real `agents.changelog` round trip: gateway-state check (exit 1 if not running), connect,
 * subscribe to `changelog.briefReady`/`changelog.briefError`, call, await, disconnect. Shaped
 * identically to `lib/agent-cli-dispatcher.ts`'s `runAgentCli` — reusing its already-tested
 * `awaitAgentBrief` router rather than reinventing notification plumbing — but returns the raw
 * `{ brief, findings }` instead of auto-rendering, since `runChangelogCommand` below still has to
 * pick a `--format` transform (or `--json`) over the result.
 */
export async function fetchChangelogBrief(
  params: ChangelogFetchParams,
): Promise<ChangelogFetchResult> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }

  const client = new IPCClient(state.socketPath);
  let pending: PendingBrief<ChangelogBriefLike> | undefined;
  try {
    await client.connect();
    registerInteractiveCliIpcHandlers(client);
    pending = awaitAgentBrief(client, "changelog", isChangelogBriefLike);
    const { sessionId } = await client.call<{ sessionId: string }>("agents.changelog", params);
    pending.bindSession(sessionId);
    return await pending.result;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return process.exit(2);
  } finally {
    pending?.cancel();
    await client.disconnect();
  }
}

/** Testability seam mirroring `DecisionsCommandDeps`/`OwnersCommandDeps` — no `mock.module`. */
export type ChangelogCommandDeps = {
  fetchBrief: typeof fetchChangelogBrief;
};

const defaultChangelogDeps: ChangelogCommandDeps = { fetchBrief: fetchChangelogBrief };

/**
 * `nimbus changelog` never emits ANSI: `markdown`/`slack`/`plain` are all colorless text
 * transforms over the brief's own Markdown, and `--json` is JSON. There is nothing for NO_COLOR
 * to strip — the same bytes reach stdout whether or not the terminal supports color, which is
 * what "respecting NO_COLOR" comes down to for a command that never colors its output.
 */
export async function runChangelogCommand(
  args: string[],
  deps: ChangelogCommandDeps = defaultChangelogDeps,
): Promise<void> {
  const parsed = parseChangelogArgs(args);

  const params: ChangelogFetchParams = { sinceMs: parsed.sinceMs };
  if (parsed.service !== undefined) params.service = parsed.service;

  const { brief, findings } = await deps.fetchBrief(params);

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    return;
  }

  // These transforms operate on the Markdown the brief already rendered — synthesis may have
  // rewritten it into prose, and re-deriving output from `findings` here would silently discard
  // that prose. See `format/slack-markdown.ts`.
  const rendered =
    parsed.format === "slack"
      ? toSlackMrkdwn(brief)
      : parsed.format === "plain"
        ? toPlainText(brief)
        : brief;
  process.stdout.write(`${rendered}\n`);
}
