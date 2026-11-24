import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { seedPostmortemRecord } from "../incident/__fixtures__/postmortem-seed.ts";
import type { IncidentRpcError } from "./incident-rpc.ts";
import { dispatchInvestigationRpc, type InvestigationRpcCtx } from "./investigation-rpc.ts";
import { checkLanMethodAllowed } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

async function seeded() {
  const s = await seedPostmortemRecord({ resolved: false });
  dbs.push(s.db);
  return s;
}

const caller = (kind: ClientKind) => ({ clientId: "c1", kind });

function ctxFor(db: Database, extra: Partial<InvestigationRpcCtx> = {}): InvestigationRpcCtx {
  return {
    incident: {
      db,
      engine: { assembleNow: async () => ({}) } as never,
      dependsOn: () => new Map(),
    },
    now: () => 9_000_000,
    runner: () => undefined,
    ...extra,
  };
}

async function call(
  params: unknown,
  ctx: InvestigationRpcCtx,
  kind: ClientKind = "cli",
  method = "incident.investigateSynthesize",
) {
  return dispatchInvestigationRpc(method, params, ctx, caller(kind));
}

async function rejects(p: Promise<unknown>): Promise<IncidentRpcError> {
  try {
    await p;
  } catch (e) {
    return e as IncidentRpcError;
  }
  throw new Error("expected a rejection");
}

type Reply = {
  recordId: string;
  version: number;
  markdown: string;
  synthesis: { attempted: boolean; used?: boolean; reason?: string };
};

describe("incident.investigateSynthesize", () => {
  test("another method is a miss", async () => {
    const { db } = await seeded();
    expect((await call({}, ctxFor(db), "cli", "incident.investigate")).kind).toBe("miss");
  });

  for (const kind of ["unknown", "mcp", "http"] as const) {
    test(`a ${kind} connection is refused before anything is read or any model is built`, async () => {
      let built = 0;
      const db = {
        query: () => {
          throw new Error("a query ran before the kind check");
        },
      } as unknown as Database;
      const e = await rejects(
        call(
          { id: "x" },
          ctxFor(db, {
            runner: () => {
              built += 1;
              return undefined;
            },
          }),
          kind,
        ),
      );
      expect(e.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
      expect(built).toBe(0);
    });
  }

  test("is off the LAN, like the whole incident namespace", () => {
    expect(() =>
      checkLanMethodAllowed("incident.investigateSynthesize", { peerId: "p", writeAllowed: true }),
    ).toThrow(/not callable over LAN/);
  });

  test("parameters are checked: a missing id and an unknown key are -32602", async () => {
    const { db } = await seeded();
    const e1 = await rejects(call({}, ctxFor(db)));
    expect(e1.rpcCode).toBe(-32602);
    const e2 = await rejects(call({ id: "x", synthesize: true }, ctxFor(db)));
    expect(e2.message).toContain('unknown parameter "synthesize"');
  });

  test("with no usable model the reply is the deterministic investigation and says no model was asked", async () => {
    const { db, recordId } = await seeded();
    const out = await call({ id: recordId }, ctxFor(db));
    const r = (out as { value: Reply }).value;
    expect(r.recordId).toBe(recordId);
    expect(r.synthesis).toEqual({ attempted: false, reason: "disabled" });
    expect(r.markdown.startsWith("# Investigation: ")).toBe(true);
    expect(r.markdown).toContain("## Gaps");
  });

  test("with a model, the rewrite is used but the reserved sections stay verbatim", async () => {
    const { db, recordId } = await seeded();
    const run: SynthesisRunner = {
      run: async () => ({
        ok: true,
        markdown:
          "## Summary\n\nREWRITTEN-BY-MODEL\n\n## Leads\n\nINVENTED CAUSE: the deploy did it",
        model: "m",
        remote: false,
      }),
    };
    const out = await call({ id: recordId }, ctxFor(db, { runner: () => run }));
    const r = (out as { value: Reply }).value;
    expect(r.synthesis.attempted).toBe(true);
    expect(r.markdown).toContain("REWRITTEN-BY-MODEL");
    expect(r.markdown).not.toContain("INVENTED CAUSE");
    expect(r.markdown).toContain("## Gaps");
    expect(r.markdown).toContain("## Data freshness");
  });

  test("a model failure falls back to the deterministic brief with a footer, never an error", async () => {
    const { db, recordId } = await seeded();
    const run: SynthesisRunner = {
      run: async () => ({ ok: false, reason: "provider_error" }),
    };
    const out = await call({ id: recordId }, ctxFor(db, { runner: () => run }));
    const r = (out as { value: Reply }).value;
    expect(r.synthesis.attempted).toBe(true);
    expect(r.synthesis.used).toBe(false);
    expect(r.markdown).toContain("## Gaps");
    expect(r.markdown).toContain("synthesis was attempted and discarded");
  });

  test("an unknown id is a typed -32602", async () => {
    const { db } = await seeded();
    const e = await rejects(call({ id: "nothing" }, ctxFor(db)));
    expect(e.rpcCode).toBe(-32602);
    expect(e.message).toContain("ERR_INCIDENT_NOT_FOUND");
  });
});
