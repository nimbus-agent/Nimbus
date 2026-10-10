import { interpolatedPercentile } from "../util/interpolated-percentile.ts";

/** Same window as the query-latency ring (`db/latency-ring-buffer.ts`). */
export const AGENT_LATENCY_RING_SIZE = 1440;

/**
 * Process-wide, in-memory ring of agent-invocation DURATIONS (ms), feeding the telemetry payload's
 * `agent_invocation_latency_p50_ms` / `_p95_ms`.
 *
 * A sample is a number and nothing else — no agent name, no input, no session id — so nothing an
 * invocation was about can reach the telemetry payload through it. Never persisted: a restart
 * starts an empty window, and an empty window reports `0`/`0`, the value both keys carried before
 * they were instrumented.
 *
 * Constructed once in `platform/assemble.ts` and injected (DI) into `runAsk` and
 * `dispatchAgentsRpc`; there is deliberately no module-level singleton.
 */
export class AgentLatencyRecorder {
  private readonly buf: number[] = new Array<number>(AGENT_LATENCY_RING_SIZE);
  private head = 0;
  private count = 0;

  record(durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      return;
    }
    this.buf[this.head] = durationMs;
    this.head = (this.head + 1) % AGENT_LATENCY_RING_SIZE;
    this.count = Math.min(this.count + 1, AGENT_LATENCY_RING_SIZE);
  }

  size(): number {
    return this.count;
  }

  percentiles(): { p50Ms: number; p95Ms: number } {
    if (this.count === 0) {
      return { p50Ms: 0, p95Ms: 0 };
    }
    const sorted = this.buf.slice(0, this.count).sort((a, b) => a - b);
    return {
      p50Ms: Math.round(interpolatedPercentile(sorted, 0.5)),
      p95Ms: Math.round(interpolatedPercentile(sorted, 0.95)),
    };
  }
}
