import type { IPCClient } from "../ipc-client/index.ts";
import { GatewayNotRunningError, withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { flagValue, runAgentBriefCli, TIMEOUT_MS } from "./_agent-brief-cli.ts";

export type GlossaryCliArgs = {
  term?: string;
  limit?: number;
  json: boolean;
  refresh: boolean;
  rebuild: boolean;
  yes: boolean;
};

/**
 * Local structural stand-in for the gateway's `GlossaryBrief`
 * (`agents/_lib/glossary-types.ts`). The CLI cannot import gateway source
 * (IPC-only rule) and `@nimbus-dev/sdk` has no glossary types yet — a future
 * SDK promotion replaces this, exactly as it did for `why`.
 */
export type GlossaryBriefLike = {
  kind: "glossary";
  mode: string;
  entries: unknown[];
  gaps: unknown[];
};

export function isGlossaryBriefLike(v: unknown): v is GlossaryBriefLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as { kind?: unknown; mode?: unknown; entries?: unknown; gaps?: unknown };
  return (
    b.kind === "glossary" &&
    typeof b.mode === "string" &&
    Array.isArray(b.entries) &&
    Array.isArray(b.gaps)
  );
}

const USAGE =
  "Usage: nimbus glossary [<term>] [--limit <n>] [--json] [--refresh | --rebuild [--yes]]";

function parseLimit(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error("--limit must be a positive integer");
  return n;
}

export function parseGlossaryArgs(args: string[]): GlossaryCliArgs {
  const positional: string[] = [];
  let limit: number | undefined;
  let json = false;
  let refresh = false;
  let rebuild = false;
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--limit") {
      limit = parseLimit(flagValue(args, i, "--limit"));
      i += 1;
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
    } else if (typeof a === "string") {
      positional.push(a);
    }
  }

  if (refresh && rebuild) {
    throw new Error(`--refresh and --rebuild cannot be combined\n${USAGE}`);
  }

  const term = positional.join(" ").trim();
  return {
    ...(term === "" ? {} : { term }),
    ...(limit === undefined ? {} : { limit }),
    json,
    refresh,
    rebuild,
    yes,
  };
}

/**
 * Structural stand-in for the gateway's `GlossaryPassSummary`
 * (`glossary/glossary-extract.ts`) — the CLI cannot import gateway source.
 */
export type GlossaryPassSummaryLike = {
  consolidated: number;
  upgraded: number;
  upgradesVetoed: number;
  vetoedTerms: string[];
  retried: number;
  llmConfigured: boolean;
  llmProduced: boolean;
};

const REBUILD_SAMPLE = 10;

/**
 * One in-place progress line. `\r` returns to column 0 and `\x1b[K` clears to
 * end of line, so a shorter line never leaves stale characters from a longer
 * one. Pure and exported so the escape sequence is testable without a TTY.
 */
export function progressLine(done: number, total: number): string {
  return `\r\x1b[K  consolidating ${String(done)}/${String(total)}`;
}

/**
 * Post-pass lines.
 *
 * The warning fires only on `llmConfigured && !llmProduced && retried > 0`:
 * "no model configured" is a choice, and a model that never answered but also
 * never had anything deferred to it (`retried === 0`) has nothing to warn
 * about either. `consolidated + upgraded > 0` is NOT a substitute for
 * `retried > 0` — when `llmConfigured` is true, `consolidateTerm` labels
 * every `defined` outcome `source: "llm"` and sets `llmProduced`, so
 * `llmConfigured && !llmProduced` already implies `consolidated + upgraded
 * === 0`; gating on that sum made the warning unreachable. A model configured
 * but unreachable (e.g. Ollama stopped) instead defers every term it touches
 * to a `retry`, which is exactly what `retried` counts.
 */
export function renderPassOutcome(s: GlossaryPassSummaryLike): string[] {
  const lines = [`Pass complete: ${String(s.consolidated)} new, ${String(s.upgraded)} upgraded.`];
  if (s.llmConfigured && !s.llmProduced && s.retried > 0) {
    lines.push(
      `Warning: no local LLM provider answered — ${String(s.retried)} term(s) were deferred to ` +
        "a later pass. Is Ollama running?",
    );
  }
  if (s.upgradesVetoed > 0) {
    const overflow = s.upgradesVetoed - s.vetoedTerms.length;
    const named =
      overflow > 0
        ? `${s.vetoedTerms.join(", ")}, and ${String(overflow)} more`
        : s.vetoedTerms.join(", ");
    lines.push(
      `Vetoed ${String(s.upgradesVetoed)} previously snippet-defined term(s): ` +
        `${named} (no longer in the glossary).`,
    );
  }
  return lines;
}

/**
 * A count says how much is lost; the sample says WHAT. Sorted by score
 * upstream, so these are the terms most likely to be recognised.
 */
export function renderRebuildPreview(
  counts: { total: number; pending: number },
  sample: readonly string[],
): string {
  const lines = [
    `${String(counts.total)} consolidated terms and ${String(counts.pending)} pending ` +
      "candidates would be deleted.",
  ];
  if (sample.length > 0) lines.push(`  ${sample.join(", ")}`);
  const remainder = counts.total - sample.length;
  if (remainder > 0) lines.push(`  ... and ${String(remainder)} more`);
  lines.push(
    "Rebuilding re-mines incrementally; the full glossary returns over subsequent passes.",
  );
  lines.push("Re-run with --yes to confirm.");
  return lines.join("\n");
}

function awaitPass(client: IPCClient, method: string): Promise<GlossaryPassSummaryLike> {
  return new Promise((resolve, reject) => {
    // In-place progress only on a TTY. `\r` rewrites the line, `\x1b[K` clears
    // the tail so a shorter line cannot leave stale characters behind, and the
    // closing `\n` stops the summary printing onto the progress line. Piped or
    // redirected output gets NO progress at all rather than a stream of escape
    // codes in a log file — the summary still prints either way.
    const tty = process.stderr.isTTY === true;
    let wrote = false;
    const endProgress = (): void => {
      if (wrote) process.stderr.write("\n");
    };

    const onProgress = (n: unknown): void => {
      if (!tty) return;
      const p = n as { done: number; total: number };
      process.stderr.write(progressLine(p.done, p.total));
      wrote = true;
    };
    // Single-flight in the gateway guarantees at most one job, so there is no
    // jobId to filter on — and filtering would race the `{ jobId }` reply.
    const onDone = (n: unknown): void => {
      settleResolve(n as GlossaryPassSummaryLike);
    };
    const onError = (n: unknown): void => {
      settleReject(new Error((n as { message: string }).message));
    };
    /**
     * A pass legitimately runs minutes, so this wait deliberately has NO
     * timeout — the client's `requestTimeoutMs` bounds the `call()` below, but
     * that resolves immediately with a job id and the RESULT arrives later as a
     * notification. Nothing was left to detect a gateway that died in between:
     * no pending call for the transport to reject, and no notification ever
     * coming, so the CLI hung forever. `onClose` (added in @nimbus-dev/client
     * 0.15.0 for exactly this) turns that into a fast, explicit failure.
     */
    const onClose = (err: Error): void => {
      settleReject(new Error(`gateway connection closed during the pass: ${err.message}`));
    };

    // Every handler is removed on the first settle. The client documents this
    // as a rule ("leaking handlers keeps dead streams firing") and it is not
    // theoretical here: `runAgentBriefCli` reuses this same client for the
    // brief that runs immediately afterwards.
    const teardown = (): void => {
      client.offNotification("glossary.passProgress", onProgress);
      client.offNotification("glossary.passDone", onDone);
      client.offNotification("glossary.passError", onError);
      client.offClose(onClose);
      endProgress();
    };
    function settleResolve(v: GlossaryPassSummaryLike): void {
      teardown();
      resolve(v);
    }
    function settleReject(e: Error): void {
      teardown();
      reject(e);
    }

    client.onNotification("glossary.passProgress", onProgress);
    client.onNotification("glossary.passDone", onDone);
    client.onNotification("glossary.passError", onError);
    client.onClose(onClose);
    client.call<{ jobId: string }>(method, {}).catch((err: unknown) => {
      settleReject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

type GlossaryPreviewLike = {
  stats: { total: number; pending: number };
  entries: Array<{ term: string }>;
};

function isGlossaryPreviewLike(v: unknown): v is GlossaryPreviewLike {
  if (v === null || typeof v !== "object") return false;
  const b = v as { stats?: unknown; entries?: unknown };
  if (b.stats === null || typeof b.stats !== "object") return false;
  const stats = b.stats as { total?: unknown; pending?: unknown };
  if (typeof stats.total !== "number" || typeof stats.pending !== "number") return false;
  if (!Array.isArray(b.entries)) return false;
  return b.entries.every(
    (e: unknown) =>
      e !== null && typeof e === "object" && typeof (e as { term?: unknown }).term === "string",
  );
}

/**
 * Reads the count + a highest-scoring sample via the same read-only
 * `agents.glossary` path an ordinary query uses — no mutating method is ever
 * called for the preview. Exported so a test can assert on the exact set of
 * IPC calls made (never `glossary.rebuild` / `glossary.refresh`) without
 * standing up a gateway.
 *
 * Bounded by the same `TIMEOUT_MS` discipline `awaitBrief` uses: a wedged or
 * crashed gateway that never emits `glossary.briefReady`/`briefError` must
 * fail closed with the same "Agent timed out after N s" shape, not hang
 * forever. `timeoutMs` is overridable so tests can force the timeout branch
 * without a real 30s wait.
 */
export function readRebuildPreview(
  client: IPCClient,
  timeoutMs: number = TIMEOUT_MS,
): Promise<{ counts: { total: number; pending: number }; sample: string[] }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Agent timed out after ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    const settleResolve = (v: {
      counts: { total: number; pending: number };
      sample: string[];
    }): void => {
      clearTimeout(timeout);
      resolve(v);
    };
    // Normalises a non-Error rejection the same way `awaitPass` does, so both
    // paths surface a consistent `Error` shape to the top-level CLI catch.
    const settleReject = (err: unknown): void => {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    client.onNotification("glossary.briefReady", (params: unknown) => {
      if (params === null || typeof params !== "object") {
        settleReject(new Error("Malformed glossary.briefReady payload"));
        return;
      }
      const p = params as { findings?: unknown };
      if (!isGlossaryPreviewLike(p.findings)) {
        settleReject(new Error("Malformed glossary.briefReady payload"));
        return;
      }
      settleResolve({ counts: p.findings.stats, sample: p.findings.entries.map((e) => e.term) });
    });
    client.onNotification("glossary.briefError", (params: unknown) => {
      const p = params === null || typeof params !== "object" ? {} : (params as { error?: string });
      settleReject(new Error(p.error ?? "Agent failed"));
    });
    client
      .call<{ sessionId: string }>("agents.glossary", { limit: REBUILD_SAMPLE })
      .catch(settleReject);
  });
}

/**
 * Testability seam: both members default to the real implementations, so
 * every real caller (`registry.ts`) is unaffected. Tests override one or
 * both to drive `runGlossaryCommand` end-to-end with a fake IPC client and no
 * `mock.module` — e.g. asserting `runAgentBriefCli` is never reached on the
 * `--rebuild`-without-`--yes` path, or that the pass-outcome write never
 * lands on stdout under `--json`.
 */
export type GlossaryCommandDeps = {
  withGatewayIpc: typeof withGatewayIpc;
  runAgentBriefCli: typeof runAgentBriefCli;
  /**
   * Overridable only so a test can force `readRebuildPreview`'s timeout
   * branch without a real 30s wait. Always `TIMEOUT_MS` in production —
   * `defaultGlossaryDeps` below omits it, so `readRebuildPreview`'s own
   * default parameter applies.
   */
  rebuildPreviewTimeoutMs?: number;
};

const defaultGlossaryDeps: GlossaryCommandDeps = { withGatewayIpc, runAgentBriefCli };

export async function runGlossaryCommand(
  args: string[],
  deps: GlossaryCommandDeps = defaultGlossaryDeps,
): Promise<void> {
  const parsed = parseGlossaryArgs(args);

  if (parsed.rebuild && !parsed.yes) {
    try {
      const { counts, sample } = await deps.withGatewayIpc((client) =>
        readRebuildPreview(client, deps.rebuildPreviewTimeoutMs),
      );
      process.stdout.write(`${renderRebuildPreview(counts, sample)}\n`);
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      // A gateway-not-running precondition failure gets the same exit code
      // every other command uses for it (`_agent-brief-cli.ts`'s own
      // `readGatewayState` check, documented in `docs/cli-reference.md` as
      // `1 = gateway not running`) — regardless of which flag reached this
      // preview path. A timeout or a malformed `agents.glossary` response is
      // a genuine agent-call failure, not a precondition failure, so it keeps
      // exit 2 — the same shape `runAgentBriefCli`'s catch uses for the same
      // distinction.
      process.exit(err instanceof GatewayNotRunningError ? 1 : 2);
    }
    return;
  }

  const runsPass = parsed.refresh || parsed.rebuild;
  const passMethod = parsed.rebuild ? "glossary.rebuild" : "glossary.refresh";

  await deps.runAgentBriefCli<GlossaryBriefLike>({
    kind: "glossary",
    guard: isGlossaryBriefLike,
    json: parsed.json,
    params: {
      ...(parsed.term === undefined ? {} : { term: parsed.term }),
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    },
    ...(runsPass
      ? {
          beforeCall: async (client: IPCClient) => {
            const summary = await awaitPass(client, passMethod);
            // stderr, not stdout: `--json` promises stdout carries JSON only,
            // and this human-readable summary must not land on the same
            // stream as the machine-readable findings that follow it.
            process.stderr.write(`${renderPassOutcome(summary).join("\n")}\n`);
          },
        }
      : {}),
  });
}
