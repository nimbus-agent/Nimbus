/**
 * User-MCP model access (I42, PR 2): `runAsk` puts the turn's DISPATCHING executor into the
 * request context ONLY when its caller decided — at the entry point, from the session kind — that
 * this turn belongs to the local owner. The executor's presence is what `engine/agent.ts` reads as
 * the offer signal, so "flag false → no executor" is the whole non-owner boundary on this side.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";

import type { EgressSink } from "../egress/egress-ledger.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { agentRequestContext, getAgentRequestUserMcpExecutor } from "./agent-request-context.ts";
import type { ToolExecutor } from "./executor.ts";
import { type RunAskParams, runAsk } from "./run-ask.ts";
import type { ConnectorDispatcher } from "./types.ts";

const stubBase = join(tmpdir(), "nimbus-run-ask-user-mcp-test");
const stubPaths: PlatformPaths = {
  configDir: join(stubBase, "cfg"),
  dataDir: join(stubBase, "data"),
  logDir: join(stubBase, "logs"),
  socketPath: join(stubBase, "gateway.sock"),
  extensionsDir: join(stubBase, "ext"),
  tempDir: join(stubBase, "tmp"),
  sandboxDir: join(stubBase, "sandbox"),
};

type EgressEntry = Parameters<EgressSink["append"]>[0];

type Harness = {
  params: RunAskParams;
  seen: { executor: ToolExecutor | undefined; agentRan: boolean };
  consentClientIds: string[];
  egress: EgressEntry[];
  dispatched: string[];
  close: () => void;
};

function harness(over: Partial<RunAskParams> = {}): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('x:1', 'x', 'note', '1', 't', 1, 1)",
  );
  const localIndex = new LocalIndex(db);
  const seen: Harness["seen"] = { executor: undefined, agentRan: false };
  const consentClientIds: string[] = [];
  const egress: EgressEntry[] = [];
  const dispatched: string[] = [];
  const consentCoordinator: ConsentCoordinator = {
    async requestConsent(clientId: string): Promise<boolean> {
      consentClientIds.push(clientId);
      return true;
    },
    rejectAllPending(): void {},
    pendingCount(): number {
      return 0;
    },
  };
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action): Promise<unknown> {
      dispatched.push(action.type);
      return { ok: true };
    },
  };
  // The agent records what the request context held AT THE MOMENT IT RAN — the property that
  // matters, since `engine/agent.ts` resolves its tool list per request from that store.
  const agent = {
    generate: async () => {
      seen.agentRan = true;
      seen.executor = getAgentRequestUserMcpExecutor();
      return { text: "agent reply" };
    },
  } as unknown as Agent;
  const params: RunAskParams = {
    input: "what is in my notes server?",
    stream: false,
    clientId: "owner-client-7",
    paths: stubPaths,
    consentCoordinator,
    localIndex,
    dispatcher,
    egressSink: { append: (e) => egress.push(e) },
    sendChunk: () => {},
    conversationalAgent: agent,
    classify: async () => ({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0 }),
    ...over,
  };
  return { params, seen, consentClientIds, egress, dispatched, close: () => localIndex.close() };
}

describe("runAsk — user-MCP executor in the request context", () => {
  test("flag true: the agent sees an executor bound to p.clientId's consent and carrying p.egressSink", async () => {
    const h = harness({ offerUserMcpTools: true });
    await agentRequestContext.run({}, () => runAsk(h.params));
    expect(h.seen.agentRan).toBe(true);
    const ex = h.seen.executor;
    expect(ex).toBeDefined();
    if (ex === undefined) throw new Error("unreachable");
    // Drive it as the user-MCP agent tool would: the owner is prompted on THIS turn's client, and
    // the I29 row lands in THIS turn's sink before the dispatch.
    const out = await ex.execute({
      type: "mcp_notes.search",
      payload: { mcpToolId: "mcp_notes_search", input: { q: "x" } },
    });
    expect(out.status).toBe("ok");
    expect(h.consentClientIds).toEqual(["owner-client-7"]);
    expect(h.egress.length).toBe(1);
    expect(h.dispatched).toEqual(["mcp_notes.search"]);
    h.close();
  });

  test("flag false: the agent runs with no executor in context", async () => {
    const h = harness({ offerUserMcpTools: false });
    await agentRequestContext.run({}, () => runAsk(h.params));
    expect(h.seen.agentRan).toBe(true);
    expect(h.seen.executor).toBeUndefined();
    h.close();
  });

  test("flag absent: the agent runs with no executor in context (absent is never an offer)", async () => {
    const h = harness();
    await agentRequestContext.run({}, () => runAsk(h.params));
    expect(h.seen.agentRan).toBe(true);
    expect(h.seen.executor).toBeUndefined();
    h.close();
  });

  test('ChatOps-shaped call (clientId "chatops", flag false) gets no executor', async () => {
    const h = harness({ clientId: "chatops", offerUserMcpTools: false });
    await agentRequestContext.run({}, () => runAsk(h.params));
    expect(h.seen.executor).toBeUndefined();
    h.close();
  });

  test("flag true outside any request context: the turn still answers, nothing to hold an executor", async () => {
    const h = harness({ offerUserMcpTools: true });
    const out = await runAsk(h.params);
    expect(out.reply).toContain("agent reply");
    expect(h.seen.executor).toBeUndefined();
    h.close();
  });

  test("one construction site: the plan path and the agent path share buildAskExecutor", async () => {
    const src = await readFile(join(import.meta.dir, "run-ask.ts"), "utf8");
    expect(src.match(/new ToolExecutor\(/g)?.length).toBe(1);
    expect(src).toMatch(/function buildAskExecutor\(p: RunAskParams\): ToolExecutor \{/);
    const planAt = src.indexOf("async function runActionsPlan(");
    expect(planAt).toBeGreaterThan(-1);
    const planBody = src.slice(planAt, src.indexOf("\n}\n", planAt));
    expect(planBody).toContain("buildAskExecutor(p)");
  });
});
