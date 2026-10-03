import type { BriefTextFormat } from "../format/slack-markdown.ts";
import { fetchAgentBrief } from "../lib/agent-cli-dispatcher.ts";
import { parseDurationToMs } from "../lib/parse-duration.ts";
import { scanBriefCommandFlags, writeBriefOutput } from "./_agent-brief-cli.ts";

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

export type ChangelogFormat = BriefTextFormat;

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
  const { since, format, json, values } = scanBriefCommandFlags(args, {
    usage: USAGE,
    defaultSince: DEFAULT_SINCE,
    valueFlags: ["--service"],
  });
  return { sinceMs: parseDurationToMs(since), service: values["--service"], format, json };
}

export type ChangelogFetchParams = { sinceMs: number; service?: string };
export type ChangelogFetchResult = { brief: string; findings: ChangelogBriefLike };

/**
 * The real `agents.changelog` round trip — `lib/agent-cli-dispatcher.ts`'s `fetchAgentBrief`, the
 * lifecycle `runAgentCli` also runs (exit 1 if no gateway, exit 2 on any failure once connected).
 * It returns the raw `{ brief, findings }` instead of auto-rendering, since `runChangelogCommand`
 * below still has to pick a `--format` transform (or `--json`) over the result.
 */
export function fetchChangelogBrief(params: ChangelogFetchParams): Promise<ChangelogFetchResult> {
  return fetchAgentBrief("changelog", params, isChangelogBriefLike);
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
 *
 * The transform is `writeBriefOutput`'s (`_agent-brief-cli.ts`), shared with `standup` and
 * `oncall`: it runs over `brief`, never `findings`, so a synthesized rewrite's prose survives it.
 */
export async function runChangelogCommand(
  args: string[],
  deps: ChangelogCommandDeps = defaultChangelogDeps,
): Promise<void> {
  const parsed = parseChangelogArgs(args);

  const params: ChangelogFetchParams = { sinceMs: parsed.sinceMs };
  if (parsed.service !== undefined) params.service = parsed.service;

  const { brief, findings } = await deps.fetchBrief(params);
  writeBriefOutput(brief, findings, parsed);
}
