import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { seedPostmortemRecord } from "../incident/__fixtures__/postmortem-seed.ts";
import type { ConsentCoordinator } from "./consent.ts";
import type { IncidentRpcError } from "./incident-rpc.ts";
import {
  dispatchPostmortemRpc,
  type PostmortemActWiring,
  type PostmortemRpcCtx,
} from "./postmortem-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

async function seeded(resolved = true) {
  const s = await seedPostmortemRecord({ resolved });
  dbs.push(s.db);
  return s;
}

const caller = (kind: ClientKind) => ({ clientId: "c1", kind });

async function call(
  method: string,
  params: unknown,
  ctx: PostmortemRpcCtx,
  kind: ClientKind = "cli",
  consent?: ConsentCoordinator,
): Promise<unknown> {
  const out = await dispatchPostmortemRpc(method, params, ctx, caller(kind), consent);
  if (out.kind !== "hit") throw new Error("miss");
  return out.value;
}

async function rejects(p: Promise<unknown>): Promise<IncidentRpcError> {
  try {
    await p;
  } catch (e) {
    return e as IncidentRpcError;
  }
  throw new Error("expected a rejection");
}

function ctxFor(db: Database, extra: Partial<PostmortemRpcCtx> = {}): PostmortemRpcCtx {
  return { db, now: () => 9_000_000, runner: () => undefined, ...extra };
}

const approving = (prompts: string[] = []): ConsentCoordinator => ({
  requestConsent: async (_c, p) => {
    prompts.push(p.prompt);
    return { approved: true, answerSource: "human" };
  },
  requestConfirmedConsent: async () => ({ approved: false, typed: "", answerSource: "human" }),
  rejectAllPending: () => {},
  pendingCount: () => 0,
});

function act(dispatched: PlannedAction[] = []): PostmortemActWiring {
  return {
    dispatcher: {
      dispatch: async (a) => {
        dispatched.push(a);
        return { content: [{ type: "text", text: JSON.stringify({ id: "424242" }) }] };
      },
    },
    egressSink: { append: () => {} },
    audit: { recordAudit: () => {} },
    policyHitl: NO_POLICY_OVERLAY,
    getTribalKbConfig: () => undefined,
  };
}

describe("the owner-kind gate runs first", () => {
  for (const kind of ["unknown", "mcp", "http"] as const) {
    test(`a ${kind} connection gets ERR_INCIDENT_FORBIDDEN_CLIENT before any query`, async () => {
      const db = {
        query: () => {
          throw new Error("a query ran before the kind check");
        },
      } as unknown as Database;
      for (const m of ["incident.postmortem", "incident.postmortemPush"]) {
        const e = await rejects(call(m, { id: "x" }, ctxFor(db), kind));
        expect(e.rpcCode).toBe(-32000);
        expect(e.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
      }
    });
  }

  test("other methods are a miss; ui is served like cli", async () => {
    const { db, recordId } = await seeded();
    const miss = await dispatchPostmortemRpc("incident.list", {}, ctxFor(db), caller("cli"));
    expect(miss.kind).toBe("miss");
    const r = (await call("incident.postmortem", { id: recordId }, ctxFor(db), "ui")) as {
      recordId: string;
    };
    expect(r.recordId).toBe(recordId);
  });
});

describe("incident.postmortem", () => {
  test("returns the draft for a record id, a trigger item id and the provider's id", async () => {
    const { db, recordId, itemId } = await seeded();
    for (const id of [recordId, itemId, "PM9"]) {
      const r = (await call("incident.postmortem", { id }, ctxFor(db))) as {
        recordId: string;
        version: number;
        markdown: string;
        synthesis: unknown;
      };
      expect(r.recordId).toBe(recordId);
      expect(r.version).toBe(1);
      expect(r.markdown.startsWith("# Post-mortem: Checkout latency")).toBe(true);
      expect(r.synthesis).toBeNull();
    }
  });

  test("synthesize with no model available says so and still returns the deterministic draft", async () => {
    const { db, recordId } = await seeded();
    const r = (await call(
      "incident.postmortem",
      { id: recordId, synthesize: true },
      ctxFor(db),
    )) as {
      markdown: string;
      synthesis: unknown;
    };
    expect(r.synthesis).toEqual({ attempted: false, reason: "disabled" });
    expect(r.markdown).toContain("## Candidate causes");
  });

  test("synthesize with a runner reaches it; without the flag the runner is never built", async () => {
    const { db, recordId } = await seeded();
    let built = 0;
    const run: SynthesisRunner = {
      run: async () => ({
        ok: true,
        markdown: "## Summary\n\nVIA-RUNNER",
        model: "m",
        remote: false,
      }),
    };
    const ctx = ctxFor(db, {
      runner: () => {
        built += 1;
        return run;
      },
    });
    const plain = (await call("incident.postmortem", { id: recordId }, ctx)) as {
      synthesis: unknown;
    };
    expect(plain.synthesis).toBeNull();
    expect(built).toBe(0);
    const r = (await call("incident.postmortem", { id: recordId, synthesize: true }, ctx)) as {
      markdown: string;
      synthesis: { used: boolean };
    };
    expect(built).toBe(1);
    expect(r.markdown).toContain("VIA-RUNNER");
    expect(r.synthesis.used).toBe(true);
  });

  test("an unexpected failure is not turned into a typed error", async () => {
    const { db, recordId } = await seeded();
    const ctx = ctxFor(db, {
      runner: () => {
        throw new Error("router exploded");
      },
    });
    await expect(
      call("incident.postmortem", { id: recordId, synthesize: true }, ctx),
    ).rejects.toThrow("router exploded");
  });

  test("a template is parsed; a bad one is -32602 with the fixed code", async () => {
    const { db, recordId } = await seeded();
    const r = (await call(
      "incident.postmortem",
      { id: recordId, template: "{{summary}}" },
      ctxFor(db),
    )) as { markdown: string };
    expect(r.markdown).not.toContain("## Candidate causes");
    const e = await rejects(
      call("incident.postmortem", { id: recordId, template: "{{wat}}" }, ctxFor(db)),
    );
    expect(e.rpcCode).toBe(-32602);
    expect(e.message).toContain("ERR_POSTMORTEM_TEMPLATE");
  });

  test("an open record, an unknown id and an unassembled item are refused with typed errors", async () => {
    const open = await seeded(false);
    const e1 = await rejects(call("incident.postmortem", { id: open.recordId }, ctxFor(open.db)));
    expect(e1.message).toContain("ERR_POSTMORTEM_NOT_RESOLVED");
    const e2 = await rejects(call("incident.postmortem", { id: "nothing" }, ctxFor(open.db)));
    expect(e2.message).toContain("ERR_INCIDENT_NOT_FOUND");
    open.db.run("DELETE FROM incident_record");
    const e3 = await rejects(call("incident.postmortem", { id: open.itemId }, ctxFor(open.db)));
    expect(e3.message).toContain("ERR_INCIDENT_NOT_FOUND");
  });

  test("a non-trigger item and an ambiguous provider id are refused", async () => {
    const { db } = await seeded();
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('slack:m1','slack','message','m1','t',1,1)",
    );
    const e1 = await rejects(call("incident.postmortem", { id: "slack:m1" }, ctxFor(db)));
    expect(e1.message).toContain("ERR_INCIDENT_NOT_A_TRIGGER");
    db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('jira:PM9','jira','alert','PM9','t',1,1)",
    );
    const e2 = await rejects(call("incident.postmortem", { id: "PM9" }, ctxFor(db)));
    expect(e2.message).toContain("ERR_INCIDENT_AMBIGUOUS");
  });

  test("parameters are validated: object payload, no unknown key, id, boolean, template size", async () => {
    const { db, recordId } = await seeded();
    const ctx = ctxFor(db);
    for (const bad of [null, [], "x", 5]) {
      expect((await rejects(call("incident.postmortem", bad, ctx))).rpcCode).toBe(-32602);
    }
    for (const bad of [
      {},
      { id: "" },
      { id: 5 },
      { id: "x".repeat(300) },
      { id: recordId, extra: 1 },
      { id: recordId, synthesize: "yes" },
      { id: recordId, template: 5 },
      { id: recordId, template: "x".repeat(80_001) },
    ]) {
      expect((await rejects(call("incident.postmortem", bad, ctx))).rpcCode).toBe(-32602);
    }
  });
});

describe("incident.postmortemPush", () => {
  const md = "# Post-mortem: Checkout latency\n\n## Summary\n\n- ok\n";

  test("is unavailable without the wiring or a consent coordinator (fail closed)", async () => {
    const { db, recordId } = await seeded();
    const params = { id: recordId, target: "confluence", space: "ENG", markdown: md };
    const e1 = await rejects(
      call("incident.postmortemPush", params, ctxFor(db), "cli", approving()),
    );
    expect(e1.rpcCode).toBe(-32000);
    expect(e1.message).toContain("ERR_POSTMORTEM_PUSH_UNAVAILABLE");
    const e2 = await rejects(call("incident.postmortemPush", params, ctxFor(db, { act: act() })));
    expect(e2.message).toContain("ERR_POSTMORTEM_PUSH_UNAVAILABLE");
  });

  test("an approved Confluence push goes through the executor: one linked dispatch, asked on this connection", async () => {
    const { db, recordId } = await seeded();
    const dispatched: PlannedAction[] = [];
    const prompts: string[] = [];
    const r = await call(
      "incident.postmortemPush",
      { id: recordId, target: "confluence", space: "ENG", parent: "99", markdown: md },
      ctxFor(db, { act: act(dispatched) }),
      "cli",
      approving(prompts),
    );
    expect(r).toEqual({ outcome: "pushed", pageId: "424242" });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.incident?.id).toBe(recordId);
    expect(prompts[0]).toContain("Create a Confluence page in space ENG");
  });

  test("a refused body comes back as a value, with nothing dispatched", async () => {
    const { db, recordId } = await seeded();
    const dispatched: PlannedAction[] = [];
    const r = await call(
      "incident.postmortemPush",
      {
        id: recordId,
        target: "confluence",
        space: "ENG",
        markdown: `${md}\n![x](http://e/x.png)\n`,
      },
      ctxFor(db, { act: act(dispatched) }),
      "cli",
      approving(),
    );
    expect(r).toMatchObject({ outcome: "refused", code: "ERR_POSTMORTEM_PUSH_IMAGE" });
    expect(dispatched).toEqual([]);
  });

  test("a push for an unknown record is refused before any wiring is touched", async () => {
    const { db } = await seeded();
    const e = await rejects(
      call(
        "incident.postmortemPush",
        { id: "nothing", target: "confluence", space: "ENG", markdown: md },
        ctxFor(db, { act: act() }),
        "cli",
        approving(),
      ),
    );
    expect(e.message).toContain("ERR_INCIDENT_NOT_FOUND");
  });

  test("the target and its ids are validated", async () => {
    const { db, recordId } = await seeded();
    const ctx = ctxFor(db, { act: act() });
    const good = "0123456789abcdef0123456789abcdef";
    for (const bad of [
      { target: "slack", markdown: md },
      { markdown: md },
      { target: "notion", markdown: md },
      { target: "notion", parent: "short", markdown: md },
      { target: "notion", parent: good, space: "ENG", markdown: md },
      { target: "confluence", markdown: md },
      { target: "confluence", space: "bad key!", markdown: md },
      { target: "confluence", space: "ENG", parent: "abc", markdown: md },
      { target: "confluence", space: "ENG" },
      { target: "confluence", space: "ENG", markdown: "x".repeat(300_000) },
      { target: "confluence", space: "ENG", markdown: md, extra: 1 },
      { target: "confluence", space: "ENG", markdown: md, title: "" },
    ]) {
      const e = await rejects(
        call("incident.postmortemPush", { id: recordId, ...bad }, ctx, "cli", approving()),
      );
      expect(e.rpcCode).toBe(-32602);
    }
    const ok = await call(
      "incident.postmortemPush",
      { id: recordId, target: "notion", parent: good, markdown: md },
      ctx,
      "cli",
      approving(),
    );
    expect((ok as { outcome: string }).outcome).toBe("unavailable");
  });
});
