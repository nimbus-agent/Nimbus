import type { BriefTextFormat } from "../format/slack-markdown.ts";
import { fetchAgentBrief } from "../lib/agent-cli-dispatcher.ts";
import { parseDurationToMs } from "../lib/parse-duration.ts";
import { scanBriefCommandFlags, writeBriefOutput } from "./_agent-brief-cli.ts";

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

export type StandupFormat = BriefTextFormat;

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
  const { since, format, json } = scanBriefCommandFlags(args, {
    usage: USAGE,
    defaultSince: DEFAULT_SINCE,
    // None, deliberately: a `--person` (like any other flag not named here) is refused as an
    // unknown flag — there is no way to aim this brief at someone else (see USAGE).
    valueFlags: [],
  });
  return { sinceMs: parseDurationToMs(since), format, json };
}

export type StandupFetchParams = { sinceMs: number };
export type StandupFetchResult = { brief: string; findings: StandupBriefLike };

/**
 * The real `agents.standup` round trip — `lib/agent-cli-dispatcher.ts`'s `fetchAgentBrief` (exit 1
 * if no gateway is running, exit 2 on any later failure, a failed connect included), returning the
 * raw `{ brief, findings }` because `runStandupCommand` below still has to pick a `--format`
 * transform (or `--json`).
 *
 * **No `personId` is sent, and that is the contract rather than an omission.** The gateway
 * resolves the owner from local state; `agents.standup` accepts no person parameter, so there is
 * nothing a caller of this function could pass to point the brief at someone else.
 *
 * An unresolvable identity comes back as a JSON-RPC error whose message names the remediation
 * (`ERR_STANDUP_IDENTITY_UNRESOLVED`), printed verbatim to stderr. It is NOT an empty brief: every
 * lane keys on the resolved person, so an empty standup would assert the author did nothing —
 * and this output is meant to be pasted into a channel.
 */
export function fetchStandupBrief(params: StandupFetchParams): Promise<StandupFetchResult> {
  return fetchAgentBrief("standup", params, isStandupBriefLike);
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
  writeBriefOutput(brief, findings, parsed);
}
