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

const out: Record<string, unknown> = {};

for (const [agent, params] of Object.entries(PARAMS)) {
  // Same schema bootstrap the agents-rpc tests use (`freshDb()` in agents-rpc.test.ts).
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);

  const payload = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${agent} never emitted`)), 20_000);
    void dispatchAgentsRpc(`agents.${agent}`, params, {
      db,
      notify: (method: string, p: unknown) => {
        if (method === `${agent}.briefReady`) {
          clearTimeout(timer);
          resolve(p);
        }
        if (method === `${agent}.briefError`) {
          clearTimeout(timer);
          reject(new Error(`${agent} errored: ${JSON.stringify(p)}`));
        }
      },
    });
  });

  out[agent] = payload;
  db.close();
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
