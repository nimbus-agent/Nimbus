import { GATEWAY_VERSION } from "../../version.ts";
import { EXTERNAL_AGENT_NAMES } from "../agents-rpc.ts";
import {
  ROUTE_KEY_AGENT_RUN_GET,
  ROUTE_KEY_AGENTS_LIST,
  ROUTE_KEY_BRIEF_GET,
} from "../http-route-auth.ts";
import { json, requireScopedSurface } from "./_shared.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

// GET /v1/briefs/{id} — bearer-authed read of an in-memory run. Mounted in the fetch handler,
// NOT in dispatchReadOnlyDataGet: that table is documented "no bearer gate", so routing briefs
// through it would expose a user's research report to any local process on the machine.
export const BRIEF_GET_RE = /^\/v1\/briefs\/(\w{1,64})$/;

/** Kept identical to http-write-routes.ts BRIEF_DISABLED_HINT — one string, two surfaces. */
const BRIEFS_DISABLED_HINT = "research briefs disabled — enable [briefs] in nimbus.toml";

/** Same body as the POST routes' 404, so the client renders one string, not two. */
function briefsDisabled(): Response {
  return json({ error: "briefs_disabled", hint: BRIEFS_DISABLED_HINT }, 404);
}

/** The read side of an in-memory run store (`BriefRunController`, `AgentRunController`). */
type PolledRuns<R> = {
  get(id: string): R | null;
  wasKnown(id: string): boolean;
};

/**
 * One poll of an in-memory run: 200 with the route's own field-by-field `render` of the run, or —
 * for an id the store no longer holds — 410 when this process held the run and has since dropped
 * it (expired or evicted), else 404 for unknown OR lost to a gateway restart: the tombstone set is
 * in-memory, so a client polling across a restart cannot see 410. Both misses are terminal:
 * re-issue the call, never keep waiting. Shared by brief and agent runs, whose stores both keep
 * their tombstones in memory and so answer a poll the same way.
 */
function serveRunPoll<R>(
  runs: PolledRuns<R>,
  id: string,
  render: (run: R) => Record<string, unknown>,
): Response {
  const run = runs.get(id);
  if (run === null) {
    return runs.wasKnown(id) ? json({ error: "expired" }, 410) : json({ error: "not_found" }, 404);
  }
  return json(render(run), 200);
}

export async function handleBriefGet(
  req: Request,
  id: string,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const runs = opts.briefRuns;
  if (runs === undefined) return briefsDisabled();
  // Shared parser from http-auth.ts (Task 1) — same header handling as the write dispatcher.
  const gate = await requireScopedSurface(req, opts, ROUTE_KEY_BRIEF_GET, briefsDisabled);
  if (!gate.ok) return gate.response;
  // `failureReason`, NOT `error`: on every other route here `error` means an HTTP-level
  // failure, so reusing it for a legitimately-failed run would make `if (body.error)` —
  // the obvious client check — misread a normal outcome as a transport error.
  return serveRunPoll(runs, id, (run) => ({
    status: run.status,
    ...(run.report === null ? {} : { report: run.report }),
    ...(run.error === null ? {} : { failureReason: run.error }),
  }));
}

// GET /v1/agents/runs/{id} — bearer-authed read of an in-memory run. Mounted in the fetch handler,
// NOT in dispatchReadOnlyDataGet: that table is documented "no bearer gate", so routing a brief
// synthesised from the private index through it would expose it to any local process on the machine.
export const AGENT_RUN_GET_RE = /^\/v1\/agents\/runs\/(\w{1,64})$/;

/** Kept identical to http-write-routes.ts AGENTS_DISABLED_HINT — one string, two surfaces. */
const AGENTS_DISABLED_HINT = "agent invocation over HTTP disabled — no local index is wired";

/** 404 that names the cause, so a client can write first-run copy instead of guessing. */
function agentsDisabled(): Response {
  return json({ error: "agents_disabled", hint: AGENTS_DISABLED_HINT }, 404);
}

export async function handleAgentsList(
  req: Request,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  // Both halves, like the write seam (`buildAgentsSeam`): with runs but no invoker the surface is
  // not mounted, and answering here would leak the agent names and the gateway version.
  if (opts.agentRuns === undefined || opts.agentInvoke === undefined) return agentsDisabled();
  const gate = await requireScopedSurface(req, opts, ROUTE_KEY_AGENTS_LIST, agentsDisabled);
  if (!gate.ok) return gate.response;
  // Derived from AGENTS_RPC_HANDLERS, so it cannot advertise a name that POST would then 404.
  //
  // `version` rides along because a NAME does not imply an ARM. `why`, `expert` and `ownership`
  // have been published for releases and their `itemUrl` arms have not, so a client gating on the
  // arm cannot learn what it needs from the name list alone. It goes HERE rather than on a route
  // of its own, or on `GET /v1/health`, because this is the request such a client already makes at
  // the moment it needs the answer: both facts arrive in one round trip, and there is no version
  // to cache and then serve stale after the owner upgrades without re-pairing.
  //
  // The web clipper is the first consumer (`agents-capability.ts`'s `meetsFloor`): it withholds
  // its item-scoped lanes below a floor and fails CLOSED when no version is reported, so an
  // absent field here is not cosmetic — it keeps those lanes dark on every gateway.
  return json({ agents: [...EXTERNAL_AGENT_NAMES], version: GATEWAY_VERSION }, 200);
}

export async function handleAgentRunGet(
  req: Request,
  id: string,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const runs = opts.agentRuns;
  if (runs === undefined || opts.agentInvoke === undefined) return agentsDisabled();
  const gate = await requireScopedSurface(req, opts, ROUTE_KEY_AGENT_RUN_GET, agentsDisabled);
  if (!gate.ok) return gate.response;
  // `failureReason`, NOT `error`: on every other route here `error` means an HTTP-level failure, so
  // reusing it for a legitimately-failed run would make `if (body.error)` — the obvious client
  // check — misread a normal outcome as a transport error. Same choice as handleBriefGet.
  return serveRunPoll(runs, id, (run) => ({
    status: run.status,
    ...(run.brief === null ? {} : { brief: run.brief }),
    ...(run.findings === null ? {} : { findings: run.findings }),
    ...(run.error === null ? {} : { failureReason: run.error }),
    // Why a synthesized rewrite was, or was not, used — the answer `SynthesisProvenance` exists
    // to carry. Absent for a `briefError` run (no `briefReady` ever landed) and while `running`.
    ...(run.synthesis === null ? {} : { synthesis: run.synthesis }),
  }));
}
