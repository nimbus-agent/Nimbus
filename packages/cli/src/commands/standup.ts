import { toPlainText, toSlackMrkdwn } from "../format/slack-markdown.ts";
import { IPCClient } from "../ipc-client/index.ts";
import { awaitAgentBrief, type PendingBrief } from "../lib/agent-brief-render.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { parseDurationToMs } from "../lib/parse-duration.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { flagValue } from "./_agent-brief-cli.ts";

/**
 * Local structural stand-in for the gateway's `StandupBrief`
 * (`agents/_lib/standup-types.ts`). The CLI cannot import gateway source (IPC-only rule) — the
 * same situation `decisions.ts`'s `DecisionsBriefLike` and `changelog.ts`'s
 * `ChangelogBriefLike` document. Only the fields needed to confirm the shape are checked;
 * `--json` prints the object verbatim, whatever extra fields it carries.
 */
export type StandupBriefLike = {
  kind: "standup";
  prsActive: unknown[];
  prsMerged: unknown[];
  reviews: unknown[];
  ticketsOpened: unknown[];
  incidents: unknown[];
  messages: unknown[];
  gaps: unknown[];
};

export function isStandupBriefLike(v: unknown): v is StandupBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  return (
    b["kind"] === "standup" &&
    Array.isArray(b["prsActive"]) &&
    Array.isArray(b["prsMerged"]) &&
    Array.isArray(b["reviews"]) &&
    Array.isArray(b["ticketsOpened"]) &&
    Array.isArray(b["incidents"]) &&
    Array.isArray(b["messages"]) &&
    Array.isArray(b["gaps"])
  );
}

export type StandupFormat = "markdown" | "slack" | "plain";

const STANDUP_FORMATS: ReadonlySet<string> = new Set<StandupFormat>(["markdown", "slack", "plain"]);

function isStandupFormat(v: string): v is StandupFormat {
  return STANDUP_FORMATS.has(v);
}

export type StandupCliArgs = {
  sinceMs: number;
  format: StandupFormat;
  json: boolean;
};

const DEFAULT_SINCE = "24h";

const USAGE =
  "Usage: nimbus standup [--since <duration>] [--format markdown|slack|plain] [--json]\n" +
  "  --since      lookback duration, e.g. 24h, 3d (default: 24h; max 90d — the gateway\n" +
  "               refuses a longer window)\n" +
  "  --format     markdown (default) | slack | plain — a text transform over the\n" +
  "               brief's Markdown, never a re-render from findings\n" +
  "  --json       print structured findings instead of the brief\n" +
  "\n" +
  "Reports YOUR activity only, resolved from `git config user.email`, then your OS\n" +
  "username. Pin it with `[user] mePersonId` in nimbus.toml (ids: nimbus people list).\n" +
  "There is no flag to report on someone else.";

export function parseStandupArgs(args: string[]): StandupCliArgs {
  let since = DEFAULT_SINCE;
  let format: StandupFormat = "markdown";
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--since") {
      since = flagValue(args, i, "--since");
      i += 1;
    } else if (a === "--format") {
      const raw = flagValue(args, i, "--format");
      if (!isStandupFormat(raw)) {
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

  return { sinceMs: parseDurationToMs(since), format, json };
}

export type StandupFetchParams = { sinceMs: number };
export type StandupFetchResult = { brief: string; findings: StandupBriefLike };

/**
 * The real `agents.standup` round trip: gateway-state check (exit 1 if not running), connect,
 * subscribe to `standup.briefReady`/`standup.briefError`, call, await, disconnect. Shaped
 * identically to `changelog.ts`'s `fetchChangelogBrief` — reusing the already-tested
 * `awaitAgentBrief` router rather than reinventing notification plumbing — and returning the raw
 * `{ brief, findings }` because `runStandupCommand` below still has to pick a `--format`
 * transform (or `--json`).
 *
 * **No `personId` is sent, and that is the contract rather than an omission.** The gateway
 * resolves the owner from local state; `agents.standup` accepts no person parameter, so there is
 * nothing a caller of this function could pass to point the brief at someone else.
 *
 * An unresolvable identity comes back as a JSON-RPC error whose message names the remediation
 * (`ERR_STANDUP_IDENTITY_UNRESOLVED`), printed verbatim below. It is NOT an empty brief: every
 * lane keys on the resolved person, so an empty standup would assert the author did nothing —
 * and this output is meant to be pasted into a channel.
 */
export async function fetchStandupBrief(params: StandupFetchParams): Promise<StandupFetchResult> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }

  const client = new IPCClient(state.socketPath);
  let pending: PendingBrief<StandupBriefLike> | undefined;
  try {
    await client.connect();
    registerInteractiveCliIpcHandlers(client);
    pending = awaitAgentBrief(client, "standup", isStandupBriefLike);
    const { sessionId } = await client.call<{ sessionId: string }>("agents.standup", params);
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

/** Testability seam mirroring `ChangelogCommandDeps`/`OwnersCommandDeps` — no `mock.module`. */
export type StandupCommandDeps = {
  fetchBrief: typeof fetchStandupBrief;
};

const defaultStandupDeps: StandupCommandDeps = { fetchBrief: fetchStandupBrief };

/**
 * `nimbus standup` never emits ANSI: `markdown`/`slack`/`plain` are all colorless text transforms
 * over the brief's own Markdown, and `--json` is JSON. There is nothing for NO_COLOR to strip —
 * the same bytes reach stdout whether or not the terminal supports color, which is what
 * "respecting NO_COLOR" comes down to for a command that never colors its output.
 */
export async function runStandupCommand(
  args: string[],
  deps: StandupCommandDeps = defaultStandupDeps,
): Promise<void> {
  const parsed = parseStandupArgs(args);

  const { brief, findings } = await deps.fetchBrief({ sinceMs: parsed.sinceMs });

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
