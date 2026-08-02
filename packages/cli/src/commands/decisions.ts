import type { IPCClient } from "../ipc-client/index.ts";
import { parseDurationToMs } from "../lib/parse-duration.ts";
import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type DecisionsCliArgs = {
  sinceMs: number;
  service?: string;
  minConfidence?: number;
  explain: boolean;
  json: boolean;
  refresh: boolean;
  rebuild: boolean;
  yes: boolean;
};

/**
 * Local structural stand-in for the gateway's `DecisionsBrief`
 * (`agents/_lib/decisions-types.ts`). The CLI cannot import gateway source
 * (IPC-only rule) and `@nimbus-dev/sdk` has no decisions types yet — exactly
 * the situation `commands/glossary.ts`'s `GlossaryBriefLike` / `isGlossaryBriefLike`
 * documents. Only the fields this command actually reads are checked.
 */
export type DecisionsBriefLike = {
  kind: "decisions";
  entries: unknown[];
  gaps: unknown[];
};

export function isDecisionsBriefLike(v: unknown): v is DecisionsBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as { kind?: unknown; entries?: unknown; gaps?: unknown };
  return b.kind === "decisions" && Array.isArray(b.entries) && Array.isArray(b.gaps);
}

const DEFAULT_SINCE = "90d";

const USAGE =
  "Usage: nimbus decisions [--since <duration>] [--service <name>] [--min-confidence <0..1>]\n" +
  "                        [--explain] [--json] [--refresh | --rebuild [--yes]]";

function parseMinConfidence(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new Error(`--min-confidence must be a number between 0 and 1\n${USAGE}`);
  }
  return n;
}

export function parseDecisionsArgs(args: string[]): DecisionsCliArgs {
  let since = DEFAULT_SINCE;
  let service: string | undefined;
  let minConfidence: number | undefined;
  let explain = false;
  let json = false;
  let refresh = false;
  let rebuild = false;
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--since") {
      since = flagValue(args, i, "--since");
      i += 1;
    } else if (a === "--service") {
      service = flagValue(args, i, "--service");
      i += 1;
    } else if (a === "--min-confidence") {
      minConfidence = parseMinConfidence(flagValue(args, i, "--min-confidence"));
      i += 1;
    } else if (a === "--explain") {
      explain = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--refresh") {
      refresh = true;
    } else if (a === "--rebuild") {
      rebuild = true;
    } else if (a === "--yes") {
      yes = true;
    } else if (a === "--help" || a === "-h") {
      throw new Error(USAGE);
    } else if (typeof a === "string" && a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    } else {
      throw new Error(`Unexpected argument: ${String(a)}\n${USAGE}`);
    }
  }

  if (refresh && rebuild) {
    throw new Error(`--refresh and --rebuild cannot be combined\n${USAGE}`);
  }

  return {
    sinceMs: parseDurationToMs(since),
    ...(service === undefined ? {} : { service }),
    ...(minConfidence === undefined ? {} : { minConfidence }),
    explain,
    json,
    refresh,
    rebuild,
    yes,
  };
}

/**
 * Structural stand-in for the gateway's `DecisionPassSummary`
 * (`decisions/decision-extract.ts`) — the CLI cannot import gateway source.
 *
 * `noModel` counts rows extracted via the verbatim-snippet fallback because no
 * local model answered — distinct from `extracted`, which counts every row
 * extracted this pass (model- or snippet-sourced alike). Surfacing it beside
 * `extracted`/`upgraded` is load-bearing, not cosmetic: without it a user with
 * no local model installed sees `extracted: 12`, concludes the LLM ran, and
 * never learns every decision is a verbatim snippet.
 */
export type DecisionsPassSummaryLike = {
  scanned: number;
  discovered: number;
  extracted: number;
  vetoed: number;
  upgraded: number;
  failed: number;
  noModel: number;
};

export function renderPassOutcome(s: DecisionsPassSummaryLike): string {
  return (
    `Pass complete: ${String(s.extracted)} extracted, ${String(s.upgraded)} upgraded, ` +
    `${String(s.noModel)} no model.`
  );
}

/**
 * Mirrors `glossary.ts`'s `awaitPass`. Unlike glossary's `runNow`, decisions'
 * `DecisionRunOptions` carries no `onProgress` hook (see `ipc/decisions-rpc.ts`),
 * so `decisions.passProgress` never fires — there is nothing to relay, and this
 * helper does not listen for it.
 */
function awaitPass(client: IPCClient, method: string): Promise<DecisionsPassSummaryLike> {
  return new Promise((resolve, reject) => {
    const onDone = (n: unknown): void => {
      settleResolve(n as DecisionsPassSummaryLike);
    };
    const onError = (n: unknown): void => {
      settleReject(new Error((n as { message: string }).message));
    };
    // Same rationale as glossary's `awaitPass`: a pass legitimately runs
    // minutes with no timeout, so a gateway that dies mid-pass must be
    // detected explicitly rather than hanging forever.
    const onClose = (err: Error): void => {
      settleReject(new Error(`gateway connection closed during the pass: ${err.message}`));
    };

    const teardown = (): void => {
      client.offNotification("decisions.passDone", onDone);
      client.offNotification("decisions.passError", onError);
      client.offClose(onClose);
    };
    function settleResolve(v: DecisionsPassSummaryLike): void {
      teardown();
      resolve(v);
    }
    function settleReject(e: Error): void {
      teardown();
      reject(e);
    }

    client.onNotification("decisions.passDone", onDone);
    client.onNotification("decisions.passError", onError);
    client.onClose(onClose);
    client.call<{ jobId: string }>(method, {}).catch((err: unknown) => {
      settleReject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Testability seam mirroring `GlossaryCommandDeps`: every real caller
 * (`registry.ts`) is unaffected, and tests can drive `runDecisionsCommand`
 * end-to-end with a fake `runAgentBriefCli` and no `mock.module`.
 */
export type DecisionsCommandDeps = {
  runAgentBriefCli: typeof runAgentBriefCli;
};

const defaultDecisionsDeps: DecisionsCommandDeps = { runAgentBriefCli };

export async function runDecisionsCommand(
  args: string[],
  deps: DecisionsCommandDeps = defaultDecisionsDeps,
): Promise<void> {
  const parsed = parseDecisionsArgs(args);

  if (parsed.rebuild && !parsed.yes) {
    process.stderr.write(
      "nimbus decisions --rebuild deletes ALL indexed decisions and clears every veto,\n" +
        "then re-mines from scratch. Vetoes are permanent judgements the pass will not\n" +
        "remember — a candidate you previously rejected will be re-extracted and may\n" +
        "reappear. This cannot be undone. Re-run with --yes to confirm.\n",
    );
    process.exit(2);
  }

  const runsPass = parsed.refresh || parsed.rebuild;
  const passMethod = parsed.rebuild ? "decisions.rebuild" : "decisions.refresh";

  await deps.runAgentBriefCli<DecisionsBriefLike>({
    kind: "decisions",
    guard: isDecisionsBriefLike,
    json: parsed.json,
    params: {
      sinceMs: parsed.sinceMs,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
      ...(parsed.minConfidence === undefined ? {} : { minConfidence: parsed.minConfidence }),
      explain: parsed.explain,
    },
    ...(runsPass
      ? {
          beforeCall: async (client: IPCClient) => {
            const summary = await awaitPass(client, passMethod);
            // stderr, not stdout: `--json` promises stdout carries JSON only,
            // and this human-readable summary must not land on the same
            // stream as the machine-readable findings that follow it.
            process.stderr.write(`${renderPassOutcome(summary)}\n`);
          },
        }
      : {}),
  });
}
