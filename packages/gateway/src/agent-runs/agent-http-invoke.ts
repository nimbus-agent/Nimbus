// packages/gateway/src/agent-runs/agent-http-invoke.ts

import type { Database } from "bun:sqlite";
import type { LocalIndex } from "../index/local-index.ts";
import { AgentsRpcError, dispatchAgentsRpc, resolveHttpAgentMethod } from "../ipc/agents-rpc.ts";
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
 * The HTTP entry point into the agents namespace.
 *
 * Reaches agents THROUGH `dispatchAgentsRpc`, never through an `agents/<name>.ts` emitter — that is
 * what makes the egress append total by construction, and it is the property D22(d) enforces
 * statically. The params go through VERBATIM to the gateway's own validator: unlike the MCP
 * adapter this builds no params and mirrors no schema, so there is no second contract to drift.
 *
 * The context deliberately mirrors `ipc/server/dispatchers.ts` `tryDispatchAgentsRpc` — including
 * omitting `llm`, which that path also omits, so an HTTP brief and a socket brief are the same
 * answer to the same question. `notify` writes ONLY into the run controller: broadcasting an HTTP
 * caller's brief onto the socket would hand it to every other local client.
 */
export function buildAgentHttpInvoker(deps: AgentHttpInvokerDeps): AgentHttpInvoker {
  return async (agent, params, clientLabel): Promise<AgentInvokeResult> => {
    const method = resolveHttpAgentMethod(agent);
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

    if (out.kind === "miss") {
      // Unreachable — resolveHttpAgentMethod already checked membership of the same map — but a
      // silently leaked reservation would be worse than a redundant branch.
      deps.runs.abandon();
      return { ok: false, reason: "unknown_agent" };
    }

    const runId = readSessionId(out.value);
    if (runId === null) {
      deps.runs.abandon();
      throw new TypeError(`agent ${agent} returned no sessionId; cannot open a run`);
    }
    deps.runs.open(runId);
    return { ok: true, runId };
  };
}
