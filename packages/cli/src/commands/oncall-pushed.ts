import { briefTextFor } from "../lib/agent-brief-render.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type OncallPushedArgs =
  | { readonly mode: "newest"; readonly json: boolean }
  | { readonly mode: "list"; readonly json: boolean }
  | {
      readonly mode: "one";
      readonly incidentId: string;
      readonly retry: boolean;
      readonly json: boolean;
    };
export interface OncallPushedIpc {
  call(method: string, params?: unknown): Promise<unknown>;
}
export interface OncallPushedSink {
  out(s: string): void;
  err(s: string): void;
}

export const ONCALL_PUSHED_USAGE =
  "Usage: nimbus oncall pushed [--json] | nimbus oncall pushed list [--json] | nimbus oncall pushed <incident-id> [--retry] [--json]";

const PUSH_OFF_HINT = "On-call push is off. Set [oncall.push] enabled = true in nimbus.toml.\n";

type Brief = {
  incidentId: string;
  status: "ok" | "failed";
  title: string | null;
  createdAt: number;
  briefMarkdown: string | null;
  failureCode: string | null;
};
type ListResult = { enabled: boolean; identity: string; briefs: Brief[] };

export function parseOncallPushedArgs(argv: readonly string[]): OncallPushedArgs | undefined {
  let json = false;
  let retry = false;
  const pos: string[] = [];
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--retry") retry = true;
    else if (a.startsWith("-")) return undefined;
    else pos.push(a);
  }
  if (pos.length > 1) return undefined;
  if (pos.length === 0) return retry ? undefined : { mode: "newest", json };
  if (pos[0] === "list") return retry ? undefined : { mode: "list", json };
  return { mode: "one", incidentId: pos[0] as string, retry, json };
}

function renderBrief(b: Brief, sink: OncallPushedSink, demo: boolean): number {
  if (b.status === "failed") {
    sink.err(
      `The brief for ${b.incidentId} could not be assembled: ${b.failureCode ?? "unknown"}\n`,
    );
    sink.err(`Retry: nimbus oncall pushed ${b.incidentId} --retry\n`);
    return 1;
  }
  sink.out(`${briefTextFor(b.briefMarkdown ?? "", demo)}\n`);
  return 0;
}

async function runList(c: OncallPushedIpc, json: boolean, sink: OncallPushedSink): Promise<number> {
  const r = (await c.call("oncall.pushedList", { limit: 50 })) as ListResult;
  if (json) {
    sink.out(`${JSON.stringify(r)}\n`);
    return 0;
  }
  if (r.briefs.length === 0) {
    sink.out("No pushed briefs yet.\n");
    if (!r.enabled) sink.out(PUSH_OFF_HINT);
    return 0;
  }
  for (const b of r.briefs) {
    const status = b.status === "ok" ? "ok    " : "FAILED";
    sink.out(
      `${new Date(b.createdAt).toISOString()}  ${status}  ${b.incidentId}  ${b.title ?? ""}\n`,
    );
  }
  return 0;
}

function jsonExitCode(brief: Brief | null, named: boolean): number {
  // Spec § 2.7: newest+none → 0 (an empty list is an answer); a named id with none → 1;
  // a failed brief → 1; an ok brief → 0.
  if (brief === null) {
    if (named) return 1;
    return 0;
  }
  if (brief.status === "failed") return 1;
  return 0;
}

/** Every mode but `list`: the ones that answer with a single brief. */
type BriefArgs = Exclude<OncallPushedArgs, { readonly mode: "list" }>;

/** `--retry` re-assembles a failed brief; otherwise read the named brief, or the newest one. */
function requestBrief(c: OncallPushedIpc, a: BriefArgs): Promise<unknown> {
  if (a.mode === "newest") return c.call("oncall.pushedGet", {});
  if (a.retry) return c.call("oncall.pushedRetry", { incidentId: a.incidentId });
  return c.call("oncall.pushedGet", { incidentId: a.incidentId });
}

/** No brief matched: a named id is an error, an empty newest is an answer (plus the off hint). */
async function renderNoBrief(
  c: OncallPushedIpc,
  a: BriefArgs,
  sink: OncallPushedSink,
): Promise<number> {
  if (a.mode === "one") {
    sink.err(`No pushed brief for ${a.incidentId}.\n`);
    return 1;
  }
  sink.out("No pushed briefs yet.\n");
  const list = (await c.call("oncall.pushedList", { limit: 1 })) as ListResult;
  if (!list.enabled) sink.out(PUSH_OFF_HINT);
  return 0;
}

export async function runOncallPushedWith(
  c: OncallPushedIpc,
  a: OncallPushedArgs,
  sink: OncallPushedSink,
  demo: boolean,
): Promise<number> {
  try {
    if (a.mode === "list") return await runList(c, a.json, sink);
    const raw = await requestBrief(c, a);
    const brief = (raw as { brief: Brief | null }).brief;
    if (a.json) {
      sink.out(`${JSON.stringify({ brief })}\n`);
      return jsonExitCode(brief, a.mode === "one");
    }
    // `return await`, not a bare return: a failing off-hint lookup must reach the catch below.
    if (brief === null) return await renderNoBrief(c, a, sink);
    return renderBrief(brief, sink, demo);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${msg}\n`);
    return 1;
  }
}

export async function runOncallPushed(argv: string[]): Promise<void> {
  const a = parseOncallPushedArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${ONCALL_PUSHED_USAGE}\n`);
    throw new CliExit(1);
  }
  const paths = getCliPlatformPaths();
  const code = await withGatewayIpc(
    (c) =>
      runOncallPushedWith(
        c,
        a,
        { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
        paths.demo === true,
      ),
    paths,
  );
  if (code !== 0) throw new CliExit(code);
}
