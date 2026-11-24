import type { EpisodicTurnPort } from "../../memory/episodic-memory.ts";
import type { RunAskParams } from "../run-ask.ts";
import { shouldUseLocalRouter } from "../run-conversational-agent.ts";

/**
 * Long-term episodic memory at the ask turn (Phase 10, owner ruling OR-S4-MEM, invariant I61, static D52).
 *
 * The decision "is this turn the local owner's?" is made here and nowhere else. `offerConnectorWriteTools` is
 * the same signal I53 and I60 use (`CONNECTOR_WRITE_OFFER_BY_KIND`: true only for a connection that declared
 * `cli` or `ui`; the HTTP, MCP, ChatOps and unknown paths pass false), and a demo-rooted gateway is refused
 * (I41). The port is the one the boot wiring attached to the session store, absent unless the owner opted in
 * at boot on a non-demo gateway.
 *
 * What is recorded is `RunAskParams.input` and the final `reply` of the conversational route: the owner's own
 * words and the answer. Nothing a tool returned, nothing retrieved and nothing an MCP client sent passes here.
 */
export type EpisodicTurnGate = Pick<
  RunAskParams,
  | "offerConnectorWriteTools"
  | "paths"
  | "sessionMemoryStore"
  | "input"
  | "llmRouter"
  | "conversationalAgent"
>;

export function episodicFor(p: EpisodicTurnGate): EpisodicTurnPort | undefined {
  if (p.offerConnectorWriteTools !== true || p.paths.demo === true) return undefined;
  return p.sessionMemoryStore?.episodic;
}

/**
 * Whether every destination this turn's prompt can reach is a local provider (OR-S4-MEM-RECALL). The answer is
 * decided from `provider.isLocal` through `LlmRouter.answersOnlyLocally` (I34), never from a vendor id or from
 * `prefersLocal()`. A turn answered by the Mastra agent alone is remote; a turn that routes through the local
 * router but could fall back to the Mastra agent (no air-gap) is not provably local either.
 */
export async function answeringLocally(
  p: Pick<RunAskParams, "llmRouter" | "conversationalAgent">,
): Promise<boolean> {
  const router = p.llmRouter;
  if (router === undefined) return false;
  const agent = p.conversationalAgent;
  if (!shouldUseLocalRouter({ llmRouter: router, ...(agent === undefined ? {} : { agent }) })) {
    return false;
  }
  if (agent !== undefined && !router.enforcesAirGap()) return false;
  return router.answersOnlyLocally("agent_step");
}

/** The untrusted recall block for this question, or `undefined` (point-in-time, off, no match, any failure). */
export async function recallBlockFor(
  p: EpisodicTurnGate,
  pointInTimeMs: number | undefined,
): Promise<string | undefined> {
  if (pointInTimeMs !== undefined) return undefined;
  try {
    const port = episodicFor(p);
    return port === undefined
      ? undefined
      : await port.recallBlock(p.input, await answeringLocally(p));
  } catch {
    return undefined;
  }
}

/** Keeps this turn for the session's later summary. Never throws. */
export function recordEpisodicTurn(
  p: EpisodicTurnGate,
  sessionId: string | undefined,
  reply: string,
): void {
  if (sessionId === undefined || sessionId === "") return;
  try {
    episodicFor(p)?.recordOwnerTurn(sessionId, p.input, reply);
  } catch {
    // best-effort: memory never fails a turn
  }
}
