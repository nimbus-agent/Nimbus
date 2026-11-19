import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { scanFlags } from "./incident-flag-scan.ts";
import { safeText } from "./incident-postmortem.ts";

/**
 * `nimbus pre-review <pr-url> [--synthesize] [--json]` (Phase 10 "Automated PR pre-review"): a read-only
 * "lint-plus" brief for a pull request already in the local index. It lists the paths this repository's merged
 * pull requests usually changed beside the areas this one touches, your own past review notes on those pull
 * requests, and how large this one is against them. No model unless `--synthesize`; nothing is posted.
 */

export const PRE_REVIEW_USAGE = "Usage: nimbus pre-review <pr-url> [--synthesize] [--json]";

export type PreReviewArgs = {
  readonly url: string;
  readonly json: boolean;
  readonly synthesize: boolean;
};

const BOOL_FLAGS: ReadonlySet<string> = new Set(["--synthesize", "--json"]);

/** Parses the arguments after `pre-review`; `undefined` is a usage error. */
export function parsePreReviewArgs(argv: readonly string[]): PreReviewArgs | undefined {
  const f = scanFlags(argv, new Set(), BOOL_FLAGS);
  if (f === undefined || f.id === undefined) return undefined;
  return { url: f.id, json: f.bools.has("--json"), synthesize: f.bools.has("--synthesize") };
}

export interface PreReviewSink {
  out(s: string): void;
  err(s: string): void;
}

type Reply = {
  markdown: string;
  synthesis: { attempted: boolean; used?: boolean; reason?: string; model?: string } | null;
};

/** Every line of the gateway's markdown, with control and invisible characters removed per line. */
function safeMarkdown(md: string): string {
  return md
    .split("\n")
    .map((line) => line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trimEnd())
    .join("\n");
}

function synthesisNote(s: Reply["synthesis"]): string | undefined {
  if (s === null) return undefined;
  if (s.attempted === false) {
    return `No model was used (${safeText(s.reason ?? "unavailable")}); this is the deterministic brief.\n`;
  }
  if (s.used === true) return `Rewritten by ${safeText(s.model ?? "the model")}; the Gaps section is verbatim.\n`;
  return `The model's rewrite was not used (${safeText(s.reason ?? "unknown")}); this is the deterministic brief.\n`;
}

export async function runPreReviewWith(
  c: Pick<IPCClient, "call">,
  a: PreReviewArgs,
  sink: PreReviewSink,
): Promise<number> {
  try {
    await declareCliClientKind(c);
    const r = await c.call<Reply>("prreview.run", {
      url: a.url,
      ...(a.synthesize ? { synthesize: true } : {}),
    });
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return 0;
    }
    const md = safeMarkdown(r.markdown);
    sink.out(md.endsWith("\n") ? md : `${md}\n`);
    const note = synthesisNote(r.synthesis);
    if (note !== undefined) sink.err(note);
    return 0;
  } catch (e) {
    sink.err(`${safeText(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

export async function runPreReviewCommand(args: string[]): Promise<void> {
  const a = parsePreReviewArgs(args);
  if (a === undefined) {
    process.stderr.write(`${PRE_REVIEW_USAGE}\n`);
    throw new CliExit(2);
  }
  const paths = getCliPlatformPaths();
  const code = await withGatewayIpc(
    (c) =>
      runPreReviewWith(c, a, {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      }),
    paths,
    // A synthesis waits on a model.
    { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS },
  );
  if (code !== 0) throw new CliExit(code);
}
