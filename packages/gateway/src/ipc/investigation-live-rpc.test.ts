// Owner ruling 9: `incident.investigateLive` and `incident.investigateSynthesize { live }` answer a connection that
// declared `cli` and nobody else, make no read unless asked, and reach a model only on the synthesize request,
// through the I11 envelope. The live reader is a fake here; its real behaviour is `investigation-live.test.ts`.
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { seedPostmortemRecord } from "../incident/__fixtures__/postmortem-seed.ts";
import type { Investigation } from "../incident/investigate.ts";
import type { LiveInvestigator } from "../investigation/investigation-live.ts";
import type { IncidentRpcError } from "./incident-rpc.ts";
import { dispatchInvestigationRpc, type InvestigationRpcCtx } from "./investigation-rpc.ts";
import { checkLanMethodAllowed } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const LIVE_TITLE = "LIVE-ISSUE-TITLE-7";

type Calls = { clientId: string; budgetMs: number | undefined }[];

function fakeLive(calls: Calls): LiveInvestigator {
  return {
    run: async ({ investigation, clientId, budgetMs }) => {
      calls.push({ clientId, budgetMs });
      return {
        ...investigation,
        live: {
          backend: "sentry",
          budgetMs: budgetMs ?? 15_000,
          status: "ok",
          projects: [{ project: "payments-api", outcome: "read", scanned: 1, matched: 1 }],
          rows: [
            {
              issueId: "9",
              title: LIVE_TITLE,
              url: null,
              project: "payments-api",
              level: "error",
              status: "unresolved",
              count: 3,
              userCount: 1,
              firstSeenMs: null,
              lastSeenMs: investigation.span.fromMs + 1,
              newSinceDeploy: false,
            },
          ],
          total: 1,
        },
      } satisfies Investigation;
    },
  };
}

async function setup(extra: Partial<InvestigationRpcCtx> = {}) {
  const s = await seedPostmortemRecord({ resolved: false });
  dbs.push(s.db);
  const ctx: InvestigationRpcCtx = {
    incident: {
      db: s.db,
      engine: { assembleNow: async () => ({}) } as never,
      dependsOn: () => new Map(),
    },
    now: () => 9_000_000,
    runner: () => undefined,
    ...extra,
  };
  return { ...s, ctx };
}

const call = (
  method: string,
  params: unknown,
  ctx: InvestigationRpcCtx,
  kind: ClientKind = "cli",
) => dispatchInvestigationRpc(method, params, ctx, { kind, clientId: "c1" });

async function rejects(p: Promise<unknown>): Promise<IncidentRpcError> {
  try {
    await p;
  } catch (e) {
    return e as IncidentRpcError;
  }
  throw new Error("expected a rejection");
}

/** A context whose database throws on any query: proves a refusal came before anything was read. */
function untouchable(calls: Calls): InvestigationRpcCtx {
  const db = {
    query: () => {
      throw new Error("a query ran before the kind check");
    },
  } as unknown as Database;
  return {
    incident: { db, engine: {} as never, dependsOn: () => new Map() },
    now: () => 1,
    runner: () => undefined,
    live: fakeLive(calls),
  };
}

describe("incident.investigateLive", () => {
  test("a cli connection gets the investigation with the live block, asked on ITS connection", async () => {
    const calls: Calls = [];
    const { ctx, recordId } = await setup({ live: fakeLive(calls) });
    const out = await call("incident.investigateLive", { id: recordId, budgetSeconds: 7 }, ctx);
    const v = (out as { value: { investigation: Investigation; markdown: string } }).value;
    expect(calls).toEqual([{ clientId: "c1", budgetMs: 7000 }]);
    expect(v.investigation.live?.rows[0]?.title).toBe(LIVE_TITLE);
    expect(v.markdown).toContain("## Sentry error issues, live");
    expect(v.markdown).toContain(LIVE_TITLE);
    expect(v.markdown).toContain("Live read, not stored");
    expect(v.markdown.indexOf("## Gaps")).toBeGreaterThan(v.markdown.indexOf(LIVE_TITLE));
  });

  test("the desktop (ui) is refused with ERR_INVESTIGATE_LIVE_CLI_ONLY before anything is read or run", async () => {
    const calls: Calls = [];
    const ctx = untouchable(calls);
    const live = await rejects(call("incident.investigateLive", { id: "x" }, ctx, "ui"));
    expect(live.message).toContain("ERR_INVESTIGATE_LIVE_CLI_ONLY");
    const synth = await rejects(
      call("incident.investigateSynthesize", { id: "x", live: true }, ctx, "ui"),
    );
    expect(synth.message).toContain("ERR_INVESTIGATE_LIVE_CLI_ONLY");
    expect(calls).toEqual([]);
  });

  for (const kind of ["unknown", "mcp", "http", "push", "fleet"] as const) {
    test(`a ${kind} connection is refused as not an owner kind, and nothing is read`, async () => {
      const calls: Calls = [];
      const e = await rejects(
        call("incident.investigateLive", { id: "x" }, untouchable(calls), kind),
      );
      expect(e.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
      expect(calls).toEqual([]);
    });
  }

  test("is off the LAN, like the whole incident namespace", () => {
    expect(() =>
      checkLanMethodAllowed("incident.investigateLive", { peerId: "p", writeAllowed: true }),
    ).toThrow(/not callable over LAN/);
  });

  test("a gateway with no live reader (a demo gateway) refuses, never answers as if it read", async () => {
    const { ctx, recordId } = await setup();
    const e = await rejects(call("incident.investigateLive", { id: recordId }, ctx));
    expect(e.message).toContain("ERR_INVESTIGATE_LIVE_UNAVAILABLE");
  });

  test("parameters are checked: budget bounds, types and unknown keys are -32602", async () => {
    const { ctx, recordId } = await setup({ live: fakeLive([]) });
    for (const bad of [0, 61, 1.5, "5", null]) {
      const e = await rejects(
        call("incident.investigateLive", { id: recordId, budgetSeconds: bad }, ctx),
      );
      expect(e.rpcCode).toBe(-32602);
    }
    const e = await rejects(call("incident.investigateLive", { id: recordId, live: true }, ctx));
    expect(e.message).toContain('unknown parameter "live"');
  });
});

describe("incident.investigateSynthesize with live", () => {
  test("without live, no live read is made and no budget is accepted", async () => {
    const calls: Calls = [];
    const { ctx, recordId } = await setup({ live: fakeLive(calls) });
    await call("incident.investigateSynthesize", { id: recordId }, ctx);
    expect(calls).toEqual([]);
    const e = await rejects(
      call("incident.investigateSynthesize", { id: recordId, budgetSeconds: 5 }, ctx),
    );
    expect(e.message).toContain("budgetSeconds applies only with live");
    const e2 = await rejects(
      call("incident.investigateSynthesize", { id: recordId, live: "yes" }, ctx),
    );
    expect(e2.rpcCode).toBe(-32602);
  });

  test("with live, the model sees the live rows only inside the I11 envelope", async () => {
    const calls: Calls = [];
    const prompts: string[] = [];
    const runner: SynthesisRunner = {
      run: async (prompt) => {
        prompts.push(prompt);
        return { ok: false, reason: "provider_error" };
      },
    };
    const { ctx, recordId } = await setup({ live: fakeLive(calls), runner: () => runner });
    const out = await call(
      "incident.investigateSynthesize",
      { id: recordId, live: true, budgetSeconds: 9 },
      ctx,
    );
    expect(calls).toEqual([{ clientId: "c1", budgetMs: 9000 }]);
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] ?? "";
    const at = prompt.indexOf(LIVE_TITLE);
    expect(at).toBeGreaterThan(-1);
    expect(prompt.lastIndexOf("<tool_output", at)).toBeGreaterThan(-1);
    expect(prompt.indexOf("</tool_output>", at)).toBeGreaterThan(at);
    const r = (out as { value: { markdown: string } }).value;
    expect(r.markdown).toContain("## Gaps");
  });

  test("a live investigation reaches no model unless the owner asked to synthesize", async () => {
    const prompts: string[] = [];
    const runner: SynthesisRunner = {
      run: async (prompt) => {
        prompts.push(prompt);
        return { ok: false, reason: "provider_error" };
      },
    };
    const { ctx, recordId } = await setup({ live: fakeLive([]), runner: () => runner });
    await call("incident.investigateLive", { id: recordId }, ctx);
    expect(prompts).toEqual([]);
  });
});
