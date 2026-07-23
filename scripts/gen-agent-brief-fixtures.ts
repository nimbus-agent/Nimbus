/**
 * Generates the golden agent-brief fixture consumed by nimbus-client's
 * conformance gate. The payloads come from the real dispatchAgentsRpc →
 * emitBriefWithSynthesis path, so the fixture cannot drift from the wire by
 * being written down wrong.
 *
 * Usage: bun run scripts/gen-agent-brief-fixtures.ts > agent-briefs.json
 */
import { Database } from "bun:sqlite";
import { LocalIndex } from "../packages/gateway/src/index/local-index.ts";
import { dispatchAgentsRpc } from "../packages/gateway/src/ipc/agents-rpc.ts";

const PARAMS: Record<string, Record<string, unknown>> = {
  expert: { topicOrFile: "src/payments/charge.ts" },
  impact: { fileOrPrUrl: "src/payments/charge.ts" },
  catchup: { sinceMs: 259_200_000 },
  ghost: { file: "src/payments/charge.ts" },
  conflicts: { file: "src/payments/charge.ts" },
  huddle: { sinceMs: 259_200_000 },
  janitor: { resourceRef: "repo:acme/payments#branch/wip" },
  preflight: { ref: "HEAD", namespace: "payments" },
};

/**
 * Drive every agent through the real dispatch path and collect its `briefReady`
 * payload. Exported so the shape-snapshot test can call this directly rather than
 * shelling out and parsing stdout.
 */
export async function generateAgentBriefFixtures(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  for (const [agent, params] of Object.entries(PARAMS)) {
    // Same schema bootstrap the agents-rpc tests use (`freshDb()` in agents-rpc.test.ts).
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);

    try {
      out[agent] = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${agent} never emitted`)), 20_000);
        const settle = (fn: () => void): void => {
          clearTimeout(timer);
          fn();
        };
        // The dispatch promise must be caught, not discarded: a synchronous
        // validation failure (a bad PARAMS entry) rejects here without ever
        // calling notify, and a discarded rejection would stall for the full
        // 20s timeout and then report the misleading "never emitted".
        dispatchAgentsRpc(`agents.${agent}`, params, {
          db,
          notify: (method: string, p: unknown) => {
            if (method === `${agent}.briefReady`) settle(() => resolve(p));
            if (method === `${agent}.briefError`) {
              settle(() => reject(new Error(`${agent} errored: ${JSON.stringify(p)}`)));
            }
          },
        }).catch((err: unknown) => {
          settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        });
      });
    } finally {
      // finally, so a rejection above cannot leak this agent's database handle.
      db.close();
    }
  }

  return out;
}

// CLI entry: bun run scripts/gen-agent-brief-fixtures.ts > agent-briefs.json
if (import.meta.main) {
  process.stdout.write(`${JSON.stringify(await generateAgentBriefFixtures(), null, 2)}\n`);
}
