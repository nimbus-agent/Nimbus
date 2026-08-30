// packages/gateway/src/agent-runs/agent-http-invoke.ts

import type { Database } from "bun:sqlite";
import { buildAgentSynthesisRunner } from "../agents/_lib/agent-synthesis-runner.ts";
import type { SynthesisRouter } from "../agents/_lib/synthesis-llm.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { RpcMissOrHit } from "../ipc/_lib/dispatch-by-method.ts";
import {
  AgentsRpcError,
  dispatchAgentsRpc,
  resolveExternalAgentMethod,
} from "../ipc/agents-rpc.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import type { AgentRunController } from "./agent-run-store.ts";

export type AgentInvokeResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly reason: "unknown_agent" }
  | {
      readonly ok: false;
      readonly reason: "busy";
      readonly activeRuns: number;
      readonly oldestExpiresInSeconds: number | null;
    }
  | { readonly ok: false; readonly reason: "invalid_params"; readonly detail: string };

export type AgentHttpInvokerDeps = {
  readonly db: Database;
  readonly runs: AgentRunController;
  readonly index?: LocalIndex;
  readonly configDir?: string;
  readonly selfIdentity?: BoxKeypair;
  /**
   * Structurally satisfied by `LlmRegistry.llmRouter` in production (`platform/assemble.ts`'s
   * `bootAgentsIntoHttpSidecar`, which always supplies it). Required — not optional — so a future
   * HTTP boot path cannot omit it and go silently inert; pass `undefined` explicitly (e.g. in a
   * test harness with no LLM registry) to fall back to `buildAgentSynthesisRunner` skipping the
   * runner entirely, same as `[agents].synthesis = "off"`.
   */
  readonly router: SynthesisRouter | undefined;
};

/**
 * `(agent, params, clientLabel) => result`. `clientLabel` is the VERIFIED token label from
 * `verifyApiToken` — server-derived, never caller-supplied.
 */
export type AgentHttpInvoker = (
  agent: string,
  params: unknown,
  clientLabel: string,
) => Promise<AgentInvokeResult>;

function readSessionId(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as { sessionId?: unknown };
  return typeof v.sessionId === "string" && v.sessionId !== "" ? v.sessionId : null;
}

/**
 * The run id for a completed dispatch, or a thrown TypeError.
 *
 * Both failure paths are unreachable BY CONSTRUCTION — `resolveExternalAgentMethod` and
 * `dispatchByMethod` consult the same handler map, so a `miss` cannot follow a resolved method; and
 * all ten exposed agents return `{sessionId}`. They are kept because the alternative to a loud
 * throw is opening a run under `undefined`, which would strand the caller polling an id that names
 * nothing.
 *
 * Exported ONLY so those paths can be exercised directly. Defensive code that no test can reach is
 * indistinguishable from defensive code that does not work, and this is cheaper than either
 * deleting the checks or carrying them unverified.
 */
export function requireRunId(agent: string, out: RpcMissOrHit): string {
  const runId = out.kind === "hit" ? readSessionId(out.value) : null;
  if (runId === null) {
    throw new TypeError(`agent ${agent} returned no sessionId; cannot open a run`);
  }
  return runId;
}

/**
 * The HTTP entry point into the agents namespace.
 *
 * Reaches agents THROUGH `dispatchAgentsRpc`, never through an `agents/<name>.ts` emitter — that is
 * what makes the egress append total by construction, and it is the property D22(d) enforces
 * statically. The params go through VERBATIM to the gateway's own validator: unlike the MCP
 * adapter this builds no params and mirrors no schema, so there is no second contract to drift.
 *
 * The context deliberately mirrors `ipc/server/dispatchers.ts` `tryDispatchAgentsRpc` — same db,
 * index, configDir and federation identity. The `runner` field is built by the SAME
 * `buildAgentSynthesisRunner` factory that path calls, from the same `configDir` and a
 * structurally-equivalent router, so an HTTP brief and a socket brief are the same answer to the
 * same question UNDER EVERY `[agents].synthesis` MODE — by construction, not by both callers
 * happening to omit the field. `notify` writes ONLY into the run controller: broadcasting an HTTP
 * caller's brief onto the socket would hand it to every other local client.
 */
export function buildAgentHttpInvoker(deps: AgentHttpInvokerDeps): AgentHttpInvoker {
  return async (agent, params, clientLabel): Promise<AgentInvokeResult> => {
    const method = resolveExternalAgentMethod(agent);
    if (method === null) return { ok: false, reason: "unknown_agent" };

    // Reserved SYNCHRONOUSLY, before the await: the run id does not exist until dispatch returns,
    // so a post-hoc count would over-admit by the number of requests in flight.
    const admitted = deps.runs.admit();
    if (!admitted.ok) {
      return {
        ok: false,
        reason: "busy",
        activeRuns: admitted.activeRuns,
        oldestExpiresInSeconds: admitted.oldestExpiresInSeconds,
      };
    }

    // The SAME factory `ipc/server/dispatchers.ts` calls for the socket path — see the doc comment
    // above for why that makes an HTTP brief and a socket brief the same answer to the same
    // question, under every `[agents].synthesis` mode.
    const runner = buildAgentSynthesisRunner({
      configDir: deps.configDir,
      db: deps.db,
      router: deps.router,
      method,
    });

    let out: Awaited<ReturnType<typeof dispatchAgentsRpc>>;
    try {
      out = await dispatchAgentsRpc(method, params, {
        db: deps.db,
        notify: (m, p): void => {
          deps.runs.observe(m, p);
        },
        ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
        ...(deps.index === undefined ? {} : { index: deps.index }),
        ...(deps.selfIdentity === undefined ? {} : { selfIdentity: deps.selfIdentity }),
        ...(runner === undefined ? {} : { runner }),
        // Server-derived on BOTH fields. There is no connection to hand-shake here, so `kind` is a
        // literal the gateway sets after verifying the token, and `clientId` is that token's
        // verified label — stronger attribution than stdio's self-declared kind, not weaker.
        caller: { clientId: clientLabel, kind: "http" },
      });
    } catch (e) {
      deps.runs.abandon();
      if (e instanceof AgentsRpcError) {
        return { ok: false, reason: "invalid_params", detail: e.message };
      }
      // A failed egress append lands here. It propagates: no row, no run, no brief (I29).
      throw e;
    }

    let runId: string;
    try {
      runId = requireRunId(agent, out);
    } catch (e) {
      // Release the reservation before propagating: a leaked slot would shrink the cap for the
      // lifetime of the process, turning a one-off bug into a permanent capacity loss.
      deps.runs.abandon();
      throw e;
    }
    deps.runs.open(runId);
    return { ok: true, runId };
  };
}
