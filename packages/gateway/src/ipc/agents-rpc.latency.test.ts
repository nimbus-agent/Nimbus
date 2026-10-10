import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { AgentLatencyRecorder } from "../telemetry/agent-latency.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

class Capturing extends AgentLatencyRecorder {
  readonly samples: number[] = [];
  override record(ms: number): void {
    this.samples.push(ms);
    super.record(ms);
  }
}

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function db(withSchema: boolean): Database {
  const d = new Database(":memory:");
  if (withSchema) LocalIndex.ensureSchema(d);
  openDbs.push(d);
  return d;
}

/** Resolves with the terminal notification method for `kind` (`briefReady` or `briefError`). */
function settlement(kind: string): {
  notify: (m: string, p: unknown) => void;
  settled: Promise<string>;
} {
  let done!: (m: string) => void;
  const settled = new Promise<string>((res) => {
    done = res;
  });
  return {
    notify: (m) => {
      if (m === `${kind}.briefReady` || m === `${kind}.briefError`) done(m);
    },
    settled,
  };
}

describe("dispatchAgentsRpc agent-invocation latency (telemetry)", () => {
  test("one brief that reaches briefReady records exactly one duration", async () => {
    const rec = new Capturing();
    const { notify, settled } = settlement("expert");
    await dispatchAgentsRpc(
      "agents.expert",
      { topicOrFile: "anything" },
      { db: db(true), notify, agentLatencyRecorder: rec },
    );
    expect(await settled).toBe("expert.briefReady");
    expect(rec.samples).toHaveLength(1);
    expect(rec.samples[0]).toBeGreaterThanOrEqual(0);
  });

  test("one brief that ends in briefError records exactly one duration", async () => {
    const rec = new Capturing();
    const { notify, settled } = settlement("expert");
    // No schema: the brief builder's first index read throws inside the background task.
    await dispatchAgentsRpc(
      "agents.expert",
      { topicOrFile: "anything" },
      { db: db(false), notify, agentLatencyRecorder: rec },
    );
    expect(await settled).toBe("expert.briefError");
    expect(rec.samples).toHaveLength(1);
  });

  test("no recorder: the brief still settles and nothing is required of the caller", async () => {
    const { notify, settled } = settlement("expert");
    await dispatchAgentsRpc("agents.expert", { topicOrFile: "anything" }, { db: db(true), notify });
    expect(await settled).toBe("expert.briefReady");
  });

  test("an unrecognised method records nothing", async () => {
    const rec = new Capturing();
    const out = await dispatchAgentsRpc(
      "agents.nope",
      {},
      { db: db(true), notify: () => {}, agentLatencyRecorder: rec },
    );
    expect(out.kind).toBe("miss");
    expect(rec.samples).toHaveLength(0);
  });
});
