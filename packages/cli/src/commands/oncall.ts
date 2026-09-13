import { toPlainText, toSlackMrkdwn } from "../format/slack-markdown.ts";
import { IPCClient } from "../ipc-client/index.ts";
import { awaitAgentBrief, type PendingBrief } from "../lib/agent-brief-render.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { parseDurationToMs } from "../lib/parse-duration.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { flagValue } from "./_agent-brief-cli.ts";

/**
 * Local structural stand-in for the gateway's `OncallBrief` (`agents/_lib/oncall-types.ts`).
 * The CLI cannot import gateway source (IPC-only rule) — the same situation `standup.ts`'s
 * `StandupBriefLike` and `changelog.ts`'s `ChangelogBriefLike` document. Only the fields needed
 * to confirm the shape are checked; `--json` prints the object verbatim, whatever extra fields
 * it carries.
 *
 * `incident` is checked as a non-null object rather than by its own fields: it is the one part of
 * this brief that is never absent — the gateway REFUSES rather than emitting a brief without one
 * — so its presence is what distinguishes an oncall brief from anything else on the wire.
 */
export type OncallBriefLike = {
  kind: "oncall";
  incident: Record<string, unknown>;
  messages: unknown[];
  priorIncidents: unknown[];
  gaps: unknown[];
};

export function isOncallBriefLike(v: unknown): v is OncallBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as Record<string, unknown>;
  const incident = b["incident"];
  return (
    b["kind"] === "oncall" &&
    incident !== null &&
    typeof incident === "object" &&
    !Array.isArray(incident) &&
    Array.isArray(b["messages"]) &&
    Array.isArray(b["priorIncidents"]) &&
    Array.isArray(b["gaps"])
  );
}

export type OncallFormat = "markdown" | "slack" | "plain";

const ONCALL_FORMATS: ReadonlySet<string> = new Set<OncallFormat>(["markdown", "slack", "plain"]);

function isOncallFormat(v: string): v is OncallFormat {
  return ONCALL_FORMATS.has(v);
}

export type OncallCliArgs = {
  sinceMs: number;
  incidentId?: string;
  service?: string;
  format: OncallFormat;
  json: boolean;
};

const DEFAULT_SINCE = "24h";

const USAGE =
  "Usage: nimbus oncall [--incident <item-id>] [--service <name>] [--since <duration>]\n" +
  "                     [--format markdown|slack|plain] [--json]\n" +
  "  --incident   brief this incident by its index item id (ids: nimbus query --type incident)\n" +
  "  --service    pick the newest active incident on this configured service instead\n" +
  "  --since      CHAT lookback only, e.g. 24h, 3d (default: 24h; max 90d). The deployment,\n" +
  "               change and prior-incident lanes anchor on when the incident opened and are\n" +
  "               not affected by this\n" +
  "  --format     markdown (default) | slack | plain — a text transform over the\n" +
  "               brief's Markdown, never a re-render from findings\n" +
  "  --json       print structured findings instead of the brief\n" +
  "\n" +
  "With neither --incident nor --service, briefs the newest active incident assigned to YOU,\n" +
  "resolved from `git config user.email`, then your OS username. Pin it with `[user] mePersonId`\n" +
  "in nimbus.toml. Refuses rather than printing an empty brief when nothing is assigned —\n" +
  "an empty on-call brief reads as `you are clear`, which is the one wrong answer that looks right.";

export function parseOncallArgs(args: string[]): OncallCliArgs {
  let since = DEFAULT_SINCE;
  let format: OncallFormat = "markdown";
  let json = false;
  let incidentId: string | undefined;
  let service: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--since") {
      since = flagValue(args, i, "--since");
      i += 1;
    } else if (a === "--incident") {
      incidentId = flagValue(args, i, "--incident");
      i += 1;
    } else if (a === "--service") {
      service = flagValue(args, i, "--service");
      i += 1;
    } else if (a === "--format") {
      const raw = flagValue(args, i, "--format");
      if (!isOncallFormat(raw)) {
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

  // Rejected HERE as well as in the gateway, deliberately. The gateway's check is the real one —
  // it guards every transport — but a CLI that forwarded a contradictory pair would make the user
  // wait for a round trip to learn about a typo they can see on their own command line.
  if (incidentId !== undefined && service !== undefined) {
    throw new Error(
      `--incident and --service are mutually exclusive — an explicit incident already ` +
        `determines its service\n${USAGE}`,
    );
  }

  return {
    sinceMs: parseDurationToMs(since),
    ...(incidentId === undefined ? {} : { incidentId }),
    ...(service === undefined ? {} : { service }),
    format,
    json,
  };
}

export type OncallFetchParams = { sinceMs: number; incidentId?: string; service?: string };
export type OncallFetchResult = { brief: string; findings: OncallBriefLike };

/**
 * The real `agents.oncall` round trip: gateway-state check (exit 1 if not running), connect,
 * subscribe to `oncall.briefReady`/`oncall.briefError`, call, await, disconnect. Shaped
 * identically to `standup.ts`'s `fetchStandupBrief` — reusing the already-tested
 * `awaitAgentBrief` router rather than reinventing notification plumbing.
 *
 * All three gateway refusals (`ERR_ONCALL_NO_ACTIVE_INCIDENT`,
 * `ERR_ONCALL_INCIDENT_NOT_FOUND`, `ERR_ONCALL_IDENTITY_UNRESOLVED`) arrive as JSON-RPC errors
 * whose messages name their own remediation, printed verbatim below. None is an empty brief:
 * every section anchors on a selected incident, so a brief without one would be six headings over
 * nothing — which during an incident reads as "nothing is wrong".
 */
export async function fetchOncallBrief(params: OncallFetchParams): Promise<OncallFetchResult> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }

  const client = new IPCClient(state.socketPath);
  let pending: PendingBrief<OncallBriefLike> | undefined;
  try {
    await client.connect();
    registerInteractiveCliIpcHandlers(client);
    pending = awaitAgentBrief(client, "oncall", isOncallBriefLike);
    const { sessionId } = await client.call<{ sessionId: string }>("agents.oncall", params);
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

/** Testability seam mirroring `StandupCommandDeps`/`ChangelogCommandDeps` — no `mock.module`. */
export type OncallCommandDeps = {
  fetchBrief: typeof fetchOncallBrief;
};

const defaultOncallDeps: OncallCommandDeps = { fetchBrief: fetchOncallBrief };

/**
 * `nimbus oncall` never emits ANSI: `markdown`/`slack`/`plain` are all colorless text transforms
 * over the brief's own Markdown, and `--json` is JSON. There is nothing for NO_COLOR to strip.
 */
export async function runOncallCommand(
  args: string[],
  deps: OncallCommandDeps = defaultOncallDeps,
): Promise<void> {
  const parsed = parseOncallArgs(args);

  const { brief, findings } = await deps.fetchBrief({
    sinceMs: parsed.sinceMs,
    ...(parsed.incidentId === undefined ? {} : { incidentId: parsed.incidentId }),
    ...(parsed.service === undefined ? {} : { service: parsed.service }),
  });

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
