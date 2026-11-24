import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { seedPostmortemRecord } from "../incident/__fixtures__/postmortem-seed.ts";
import type { IncidentRpcError } from "./incident-rpc.ts";
import { checkLanMethodAllowed } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";
import { dispatchUpdateSynthesisRpc, type UpdateSynthesisRpcCtx } from "./update-synthesis-rpc.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

async function seeded() {
  const s = await seedPostmortemRecord({ resolved: false });
  dbs.push(s.db);
  return s;
}

function ctxFor(db: Database, extra: Partial<UpdateSynthesisRpcCtx> = {}): UpdateSynthesisRpcCtx {
  return { db, now: () => 9_000_000, runner: () => undefined, ...extra };
}

function call(
  params: unknown,
  ctx: UpdateSynthesisRpcCtx,
  kind: ClientKind = "cli",
  method = "incident.updateSynthesize",
) {
  return dispatchUpdateSynthesisRpc(method, params, ctx, { clientId: "c1", kind });
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
  text: string;
  lead: string | null;
  audience: string;
  synthesis: { attempted: boolean; used?: boolean };
};

const lead = (markdown: string): SynthesisRunner => ({
  run: async () => ({ ok: true, markdown, model: "m", remote: false }),
});

describe("incident.updateSynthesize", () => {
  test("another method is a miss", async () => {
    const { db } = await seeded();
    expect((await call({}, ctxFor(db), "cli", "incident.update")).kind).toBe("miss");
  });

  for (const kind of ["unknown", "mcp", "http"] as const) {
    test(`a ${kind} connection is refused before any query or model build`, async () => {
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

  test("is off the LAN with the rest of the incident namespace", () => {
    expect(() =>
      checkLanMethodAllowed("incident.updateSynthesize", { peerId: "p", writeAllowed: true }),
    ).toThrow(/not callable over LAN/);
  });

  test("parameters are checked", async () => {
    const { db, recordId } = await seeded();
    for (const bad of [
      { id: recordId, audience: "everyone" },
      { id: recordId, version: 0 },
      { id: recordId, version: "1" },
      { id: recordId, send: true },
      {},
    ]) {
      const e = await rejects(call(bad, ctxFor(db)));
      expect(e.rpcCode).toBe(-32602);
    }
  });

  test("with no model it is the plain update and says no model was asked", async () => {
    const { db, recordId } = await seeded();
    const r = ((await call({ id: recordId }, ctxFor(db))) as { value: Reply }).value;
    expect(r.lead).toBeNull();
    expect(r.synthesis as unknown).toEqual({ attempted: false, reason: "disabled" });
    expect(r.text).toContain("Not checked with the provider.");
  });

  test("with a model the lead comes first and the facts are verbatim; the model builds only on request", async () => {
    const { db, recordId } = await seeded();
    let built = 0;
    const ctx = ctxFor(db, {
      runner: () => {
        built += 1;
        return lead("## Lead\n\nThe team is on it.\n\n## Update text\n\nFAKE");
      },
    });
    const r = ((await call({ id: recordId, audience: "engineers" }, ctx)) as { value: Reply })
      .value;
    expect(built).toBe(1);
    expect(r.audience).toBe("engineers");
    expect(r.lead).toBe("The team is on it.");
    expect(r.text.startsWith("The team is on it.\n\n")).toBe(true);
    expect(r.text).not.toContain("FAKE");
    expect(r.text).toContain("Not checked with the provider.");
  });

  test("an unknown id is a typed -32602", async () => {
    const { db } = await seeded();
    const e = await rejects(call({ id: "nothing" }, ctxFor(db)));
    expect(e.rpcCode).toBe(-32602);
  });
});

describe("incident.updateSynthesize errors", () => {
  test("a version that is not stored is the typed ERR_INCIDENT_VERSION_NOT_FOUND, -32602", async () => {
    const { db, recordId } = await seeded();
    const e = await rejects(call({ id: recordId, version: 99 }, ctxFor(db)));
    expect(e.rpcCode).toBe(-32602);
    expect(e.message).toContain("ERR_INCIDENT_VERSION_NOT_FOUND");
  });

  test("an unexpected failure is not turned into a typed error", async () => {
    const { db, recordId } = await seeded();
    const ctx = ctxFor(db, {
      runner: () => {
        throw new Error("router exploded");
      },
    });
    await expect(call({ id: recordId }, ctx)).rejects.toThrow("router exploded");
  });
});
