import type { EpisodicTurnPort } from "../../memory/episodic-memory.ts";
import type { RunAskParams } from "../run-ask.ts";

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
  "offerConnectorWriteTools" | "paths" | "sessionMemoryStore" | "input"
>;

export function episodicFor(p: EpisodicTurnGate): EpisodicTurnPort | undefined {
  if (p.offerConnectorWriteTools !== true || p.paths.demo === true) return undefined;
  return p.sessionMemoryStore?.episodic;
}

/** The untrusted recall block for this question, or `undefined` (point-in-time, off, no match, any failure). */
export async function recallBlockFor(
  p: EpisodicTurnGate,
  pointInTimeMs: number | undefined,
): Promise<string | undefined> {
  if (pointInTimeMs !== undefined) return undefined;
  try {
    return await episodicFor(p)?.recallBlock(p.input);
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
