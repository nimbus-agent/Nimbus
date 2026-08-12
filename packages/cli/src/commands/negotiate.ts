import { parseDurationToMs } from "../lib/parse-duration.ts";
import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type NegotiateCliArgs = {
  since: string | undefined;
  person: string | undefined;
  json: boolean;
};

const USAGE =
  "Usage: nimbus negotiate [--since <duration>] [--person <id>] [--json]\n" +
  "  --since    window to summarise, e.g. 90d (default 90d, max 365d)\n" +
  "  --person   brief a different person by id (defaults to you)";

/**
 * `nimbus negotiate` hard-rejects an unrecognised flag rather than ignoring it, matching
 * `nimbus owners`/`nimbus pre-mortem`. Silently dropping a misspelled `--persn` would return
 * the local user's own brief in response to a question about someone else — a wrong answer
 * that looks like a right one.
 */
export function parseNegotiateArgs(args: string[]): NegotiateCliArgs {
  let since: string | undefined;
  let person: string | undefined;
  let json = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") {
      json = true;
    } else if (a === "--since") {
      since = flagValue(args, i, "--since");
      i++;
    } else if (a === "--person") {
      person = flagValue(args, i, "--person");
      i++;
    } else if (a.startsWith("--")) {
      throw new Error(`Unrecognised flag: ${a}\n${USAGE}`);
    } else {
      throw new Error(`Unexpected argument: ${a}\n${USAGE}`);
    }
  }

  return { since, person, json };
}

/**
 * Local structural stand-in for the gateway's `NegotiateBrief`
 * (`agents/_lib/negotiate-types.ts`). The CLI cannot import gateway source (IPC-only rule) and
 * `@nimbus-dev/sdk` has no negotiate types yet — the same situation `owners.ts`'s
 * `OwnershipBriefLike` / `pre-mortem.ts`'s `PremortemBriefLike` document. Only the fields this
 * command actually reads are checked.
 */
type NegotiateBriefLike = { kind: "negotiate"; gaps: unknown[] };

function isNegotiateBriefLike(x: unknown): x is NegotiateBriefLike {
  if (x === null || typeof x !== "object") return false;
  const b = x as { kind?: unknown; gaps?: unknown };
  return b.kind === "negotiate" && Array.isArray(b.gaps);
}

/** Testability seam mirroring `OwnersCommandDeps`/`PreMortemCommandDeps` — no `mock.module`. */
export type NegotiateCommandDeps = {
  runAgentBriefCli: typeof runAgentBriefCli;
};

const defaultNegotiateDeps: NegotiateCommandDeps = { runAgentBriefCli };

export async function runNegotiateCommand(
  args: string[],
  deps: NegotiateCommandDeps = defaultNegotiateDeps,
): Promise<void> {
  const parsed = parseNegotiateArgs(args);

  await deps.runAgentBriefCli<NegotiateBriefLike>({
    kind: "negotiate",
    guard: isNegotiateBriefLike,
    json: parsed.json,
    params: {
      ...(parsed.since === undefined ? {} : { sinceMs: parseDurationToMs(parsed.since) }),
      ...(parsed.person === undefined ? {} : { personId: parsed.person }),
    },
  });
}
