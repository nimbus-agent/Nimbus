import type { IPCClient } from "../ipc-client/index.ts";
import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type PreMortemCliArgs = {
  epicRef: string;
  services: string[];
  json: boolean;
  refresh: boolean;
  repropose: boolean;
};

const USAGE =
  "Usage: nimbus pre-mortem <epic-ref> [--service <name>]... [--json] [--refresh] [--repropose]\n" +
  "  <epic-ref>   a Jira epic key, e.g. PROJ-120 or jira:PROJ-120\n" +
  "  --service    repeatable; overrides the derived affected-service set\n" +
  "  --refresh    run the pre-mortem theme pass before building the brief\n" +
  "  --repropose  re-create a previously-deleted watcher proposal for this epic";

/**
 * `nimbus pre-mortem` hard-rejects an unrecognised flag rather than ignoring it, matching
 * `nimbus owners`/`nimbus glossary`. Silently dropping a misspelled `--srevice` would return a
 * brief scoped to the DERIVED services instead of the ones the caller actually meant to pin —
 * a wrong answer that looks like a right one.
 */
export function parsePreMortemArgs(args: string[]): PreMortemCliArgs {
  let epicRef: string | undefined;
  const services: string[] = [];
  let json = false;
  let refresh = false;
  let repropose = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") {
      json = true;
    } else if (a === "--refresh") {
      refresh = true;
    } else if (a === "--repropose") {
      repropose = true;
    } else if (a === "--service") {
      // Repeatable: an epic may span several services, and a single-valued flag would force
      // the brand-new-epic case (no PR-derivable affected services yet) into an artificially
      // narrow cohort.
      services.push(flagValue(args, i, "--service"));
      i++;
    } else if (a.startsWith("--")) {
      throw new Error(`Unrecognised flag: ${a}\n${USAGE}`);
    } else if (epicRef === undefined) {
      epicRef = a;
    } else {
      throw new Error(`Unexpected argument: ${a}\n${USAGE}`);
    }
  }

  if (epicRef === undefined || epicRef.length === 0) {
    throw new Error(`<epic-ref> is required\n${USAGE}`);
  }

  return { epicRef, services, json, refresh, repropose };
}

type PremortemBriefLike = { kind: "premortem"; gaps: unknown[] };

function isPremortemBriefLike(x: unknown): x is PremortemBriefLike {
  if (x === null || typeof x !== "object") return false;
  const b = x as { kind?: unknown; gaps?: unknown };
  return b.kind === "premortem" && Array.isArray(b.gaps);
}

/** Testability seam mirroring `OwnersCommandDeps`/`DecisionsCommandDeps` — no `mock.module`. */
export type PreMortemCommandDeps = {
  runAgentBriefCli: typeof runAgentBriefCli;
};

const defaultPreMortemDeps: PreMortemCommandDeps = { runAgentBriefCli };

/**
 * `premortem.refresh` (unlike `ownership.refresh`/`decisions.refresh`/`glossary.refresh`) is NOT
 * job-based: `ipc/premortem-rpc.ts`'s `handleRefresh` awaits `premortemRefresher.runNow()` and
 * returns the `PremortemPassResult` directly as the RPC response — there is no `{ jobId }`, no
 * `premortem.passDone`/`passError` notification to wait on. So this is a bare awaited call, not
 * `owners.ts`'s notification-based `awaitPass`. A disabled pass ("ERR_PREMORTEM_DISABLED") or a
 * concurrent pass ("ERR_PREMORTEM_PASS_RUNNING") surfaces as a normal RPC rejection, which
 * `runAgentBriefCli`'s `beforeCall` propagates up to the CLI's standard "print message, exit 2"
 * path unchanged.
 */
async function runPremortemRefresh(client: IPCClient): Promise<void> {
  await client.call("premortem.refresh", {});
}

export async function runPreMortemCommand(
  args: string[],
  deps: PreMortemCommandDeps = defaultPreMortemDeps,
): Promise<void> {
  const parsed = parsePreMortemArgs(args);

  await deps.runAgentBriefCli<PremortemBriefLike>({
    kind: "premortem",
    guard: isPremortemBriefLike,
    json: parsed.json,
    params: {
      epicRef: parsed.epicRef,
      ...(parsed.services.length > 0 ? { services: parsed.services } : {}),
      ...(parsed.repropose ? { repropose: true } : {}),
    },
    ...(parsed.refresh ? { beforeCall: runPremortemRefresh } : {}),
  });
}
