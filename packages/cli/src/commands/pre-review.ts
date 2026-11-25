import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { scanFlags } from "./incident-flag-scan.ts";
import { safeText } from "./incident-postmortem.ts";

/**
 * `nimbus pre-review <pr-url> [--json]` (Phase 10 "Automated PR pre-review"): a read-only "lint-plus" brief for a
 * pull request already in the local index. It lists the paths this repository's merged pull requests usually
 * changed beside the areas this one touches, your own past review notes on those pull requests, and how large this
 * one is against them. No model, no network call, nothing posted.
 */

export const PRE_REVIEW_USAGE = "Usage: nimbus pre-review <pr-url> [--json]";

export type PreReviewArgs = {
  readonly url: string;
  readonly json: boolean;
};

const BOOL_FLAGS: ReadonlySet<string> = new Set(["--json"]);

/** Parses the arguments after `pre-review`; `undefined` is a usage error. */
export function parsePreReviewArgs(argv: readonly string[]): PreReviewArgs | undefined {
  const f = scanFlags(argv, new Set(), BOOL_FLAGS);
  if (f?.id === undefined) return undefined;
  return { url: f.id, json: f.bools.has("--json") };
}

export interface PreReviewSink {
  out(s: string): void;
  err(s: string): void;
}

type Reply = { markdown: string };

/** Every line of the gateway's markdown, with control and invisible characters removed per line. */
function safeMarkdown(md: string): string {
  return md
    .split("\n")
    .map((line) => line.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trimEnd())
    .join("\n");
}

export async function runPreReviewWith(
  c: Pick<IPCClient, "call">,
  a: PreReviewArgs,
  sink: PreReviewSink,
): Promise<number> {
  try {
    await declareCliClientKind(c);
    const r = await c.call<Reply>("prreview.run", { url: a.url });
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return 0;
    }
    const md = safeMarkdown(r.markdown);
    sink.out(md.endsWith("\n") ? md : `${md}\n`);
    return 0;
  } catch (e) {
    sink.err(`${safeText(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}

/** The gateway seam of the command; the defaults are the real ones. */
export interface PreReviewDeps {
  readonly withIpc: (fn: (c: IPCClient) => Promise<number>) => Promise<number>;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
}

const DEFAULT_DEPS: PreReviewDeps = {
  withIpc: (fn) => withGatewayIpc(fn, getCliPlatformPaths()),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

export async function runPreReviewCommand(
  args: string[],
  deps: PreReviewDeps = DEFAULT_DEPS,
): Promise<void> {
  const a = parsePreReviewArgs(args);
  if (a === undefined) {
    deps.stderr(`${PRE_REVIEW_USAGE}
`);
    throw new CliExit(2);
  }
  const code = await deps.withIpc((c) =>
    runPreReviewWith(c, a, { out: deps.stdout, err: deps.stderr }),
  );
  if (code !== 0) throw new CliExit(code);
}
