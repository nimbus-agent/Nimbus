import type { AgentLatencyRecorder } from "../../telemetry/agent-latency.ts";

const TERMINAL_SUFFIXES = [".briefReady", ".briefError"] as const;

function isBriefSettlement(method: string): boolean {
  return TERMINAL_SUFFIXES.some((suffix) => method.endsWith(suffix));
}

/**
 * Wraps one dispatch's `notify` so the time from the dispatch to that brief's FIRST terminal
 * notification (`<agent>.briefReady` or `<agent>.briefError`) is recorded once, as telemetry's
 * agent-invocation latency. Every notification is still forwarded unchanged.
 *
 * Lives here rather than in `emit-brief.ts` because the seam every brief passes through is
 * `ipc/agents-rpc.ts`'s `dispatchAgentsRpc` (D22(d) forbids reaching an emitter any other way),
 * which hands each dispatch its own `notify`; wrapping it there covers every agent without
 * threading a recorder through seventeen agent contexts. Only the duration is recorded — never
 * the method, the agent, or the payload. A recorder failure never stops the notification.
 */
export function timeBriefSettlement(
  notify: (method: string, params: unknown) => void,
  recorder: AgentLatencyRecorder,
  now: () => number = Date.now,
): (method: string, params: unknown) => void {
  const startedAt = now();
  let recorded = false;
  return (method, params) => {
    if (!recorded && isBriefSettlement(method)) {
      recorded = true;
      try {
        recorder.record(now() - startedAt);
      } catch {
        /* best-effort telemetry: never affects brief delivery */
      }
    }
    notify(method, params);
  };
}
