import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import {
  configMap,
  HOUR,
  markSynced,
  resolverFor,
  serviceConfig,
  T0,
} from "../incident/__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "../incident/__fixtures__/trigger-writers.ts";
import { IncidentError } from "../incident/assemble.ts";
import { createIncidentEngine, type IncidentEngine } from "../incident/incident-engine.ts";
import * as store from "../incident/incident-store.ts";
import { type Remediation, RemediationError } from "../incident/remediation.ts";
import { dispatchIncidentRpc, IncidentRpcError, requireOwnerKind } from "./incident-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const cfg = serviceConfig();
const resolver = resolverFor(cfg);
const NOW = T0 + HOUR;

function setup(): { db: Database; engine: IncidentEngine; calls: string[] } {
  const db = createMemoryIndexDb();
  dbs.push(db);
  const calls: string[] = [];
  const real = createIncidentEngine({
    db,
    now: () => NOW,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
  });
  const engine: IncidentEngine = {
    ...real,
    assembleNow: (id) => {
      calls.push(id);
      return real.assembleNow(id);
    },
  };
  return { db, engine, calls };
}

async function call(
  s: ReturnType<typeof setup>,
  method: string,
  params: unknown,
  kind: ClientKind = "cli",
  dependsOn: () => ReadonlyMap<string, readonly string[]> = () => new Map(),
): Promise<unknown> {
  const out = await dispatchIncidentRpc(
    method,
    params,
    { db: s.db, engine: s.engine, dependsOn },
    { kind },
  );
  if (out.kind === "miss") throw new Error(`miss ${method}`);
  return out.value;
}

async function rpcError(p: Promise<unknown>): Promise<IncidentRpcError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof IncidentRpcError))
    throw new Error(`expected IncidentRpcError, got ${String(e)}`);
  return e;
}

type ListOut = {
  status: string;
  records: { id: string; triggerItemId: string; checkedAtMs: number }[];
  sources: { service: string; connected: boolean }[];
};

describe("incident.list", () => {
  test("no_data with no record and no trigger connector; none once a connector is synced", async () => {
    const s = setup();
    const a = (await call(s, "incident.list", {})) as ListOut;
    expect(a.status).toBe("no_data");
    expect(a.sources.map((x) => x.service)).toEqual([
      "pagerduty",
      "jira",
      "sentry",
      "montecarlo",
      "bigeye",
    ]);
    markSynced(s.db, "pagerduty", NOW);
    const b = (await call(s, "incident.list", {})) as ListOut;
    expect(b.status).toBe("none");
    expect(b.sources.find((x) => x.service === "pagerduty")?.connected).toBe(true);
  });

  test("ok with records; filters by open, service and source; carries checkedAtMs", async () => {
    const s = setup();
    const a = writePagerdutyIncident(
      s.db,
      { id: "A", openedAtMs: NOW - 60_000, priority: "P1" },
      resolver,
    );
    await s.engine.assembleNow(a);
    const all = (await call(s, "incident.list", {})) as ListOut;
    expect(all.status).toBe("ok");
    expect(all.records[0]).toMatchObject({ triggerItemId: a, checkedAtMs: NOW });
    expect(((await call(s, "incident.list", { open: true })) as ListOut).records).toHaveLength(1);
    expect(
      ((await call(s, "incident.list", { service: "payment-service" })) as ListOut).records,
    ).toHaveLength(1);
    expect(((await call(s, "incident.list", { source: "jira" })) as ListOut).status).toBe("none");
    expect(
      ((await call(s, "incident.list", { service: "other", limit: 5 })) as ListOut).records,
    ).toEqual([]);
  });

  test.each([
    [{ limit: 0 }],
    [{ limit: 201 }],
    [{ limit: 1.5 }],
    [{ open: "yes" }],
    [{ service: "" }],
    [{ source: "github" }],
    [{ kind: "cli" }],
    ["text"],
  ])("a bad payload %j is -32602", async (params) => {
    const s = setup();
    expect((await rpcError(call(s, "incident.list", params))).rpcCode).toBe(-32602);
  });
});

describe("incident.get", () => {
  test("by record id, trigger item id and provider id; versions, markdown and triggerStillIndexed", async () => {
    const s = setup();
    const a = writePagerdutyIncident(
      s.db,
      { id: "A", openedAtMs: NOW - 60_000, priority: "P1" },
      resolver,
    );
    await s.engine.assembleNow(a);
    const row = store.getByTriggerItem(s.db, a);
    for (const id of [row?.id ?? "", a, "A"]) {
      const out = (await call(s, "incident.get", { id })) as {
        record: {
          summary: { id: string };
          markdown: string;
          versions: unknown[];
          triggerStillIndexed: boolean;
          record: { schema: number };
        };
      };
      expect(out.record.summary.id).toBe(row?.id ?? "");
      expect(out.record.markdown).toContain("# Incident");
      expect(out.record.versions).toHaveLength(1);
      expect(out.record.record.schema).toBe(1);
      expect(out.record.triggerStillIndexed).toBe(true);
    }
    s.db.run("DELETE FROM item");
    const gone = (await call(s, "incident.get", { id: row?.id })) as {
      record: { triggerStillIndexed: boolean };
    };
    expect(gone.record.triggerStillIndexed).toBe(false);
  });

  test("not assembled, nothing indexed, ambiguous, not a trigger", async () => {
    const s = setup();
    writePagerdutyIncident(s.db, { id: "A", openedAtMs: NOW, priority: "P1" }, resolver);
    expect(await call(s, "incident.get", { id: "pagerduty:A" })).toEqual({
      record: null,
      reason: "not_assembled",
      triggerItemId: "pagerduty:A",
    });
    expect(await call(s, "incident.get", { id: "nope" })).toEqual({
      record: null,
      reason: "no_item",
    });
    s.db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES
        ('jira:X','jira','alert','X','t',1,1), ('sentry:X','sentry','error_issue','X','t',1,1), ('github:1','github','issue','1','t',1,1)`,
    );
    const amb = await rpcError(call(s, "incident.get", { id: "X" }));
    expect(amb.rpcCode).toBe(-32602);
    expect(amb.message).toContain("ERR_INCIDENT_AMBIGUOUS");
    expect(amb.message).toContain("jira:X");
    expect((await rpcError(call(s, "incident.get", { id: "github:1" }))).message).toContain(
      "ERR_INCIDENT_NOT_A_TRIGGER",
    );
    expect((await rpcError(call(s, "incident.get", { id: "" }))).rpcCode).toBe(-32602);
    expect((await rpcError(call(s, "incident.get", { id: "a", extra: 1 }))).rpcCode).toBe(-32602);
  });
});

describe("incident.assemble", () => {
  test("assembles by provider id: created, then unchanged", async () => {
    const s = setup();
    writePagerdutyIncident(s.db, { id: "A", openedAtMs: NOW - 60_000, priority: "P1" }, resolver);
    const first = (await call(s, "incident.assemble", { id: "A" })) as {
      outcome: string;
      record: { version: number };
    };
    expect(first).toMatchObject({ outcome: "created", record: { version: 1 } });
    expect(
      ((await call(s, "incident.assemble", { id: "pagerduty:A" })) as { outcome: string }).outcome,
    ).toBe("unchanged");
  });

  test("not found, not a trigger, ambiguous, a record whose item is gone", async () => {
    const s = setup();
    expect((await rpcError(call(s, "incident.assemble", { id: "nope" }))).message).toContain(
      "ERR_INCIDENT_NOT_FOUND",
    );
    s.db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('github:1','github','issue','1','t',1,1)",
    );
    expect((await rpcError(call(s, "incident.assemble", { id: "github:1" }))).message).toContain(
      "ERR_INCIDENT_NOT_A_TRIGGER",
    );
    const a = writePagerdutyIncident(s.db, { id: "A", openedAtMs: NOW, priority: "P1" }, resolver);
    await s.engine.assembleNow(a);
    const rid = store.getByTriggerItem(s.db, a)?.id ?? "";
    s.db.run("DELETE FROM item WHERE id = ?", [a]);
    expect((await rpcError(call(s, "incident.assemble", { id: rid }))).message).toContain(
      "no longer in the index",
    );
    s.db.run(
      "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('jira:X','jira','alert','X','t',1,1),('sentry:X','sentry','error_issue','X','t',1,1)",
    );
    expect((await rpcError(call(s, "incident.assemble", { id: "X" }))).message).toContain(
      "ERR_INCIDENT_AMBIGUOUS",
    );
  });
});

describe("owner kinds only (the spec, § 5.3)", () => {
  const FORBIDDEN: ClientKind[] = ["mcp", "http", "chatops", "fleet", "push", "unknown"];
  const METHODS: [string, unknown][] = [
    ["incident.list", {}],
    ["incident.get", { id: "pagerduty:A" }],
    ["incident.assemble", { id: "pagerduty:A" }],
    ["incident.timeline", { id: "pagerduty:A" }],
    ["incident.proposals", { id: "pagerduty:A" }],
    ["incident.remediate", { id: "pagerduty:A", proposalId: "prp_0123456789abcdef" }],
    ["incident.undo", { actionId: "act_0123456789abcdef" }],
    ["incident.advisory", {}],
    ["incident.advisorySet", { on: true }],
  ];

  test("list, get AND assemble refuse every other kind BEFORE any query or engine call, and serve cli and ui", async () => {
    for (const kind of FORBIDDEN) {
      for (const [method, params] of METHODS) {
        const s = setup();
        const ran: string[] = [];
        const spyDb = new Proxy(s.db, {
          get(target, prop) {
            if (prop === "query" || prop === "prepare" || prop === "run") ran.push(String(prop));
            const v = Reflect.get(target, prop, target) as unknown;
            return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
          },
        });
        const e = await rpcError(
          dispatchIncidentRpc(
            method,
            params,
            { db: spyDb, engine: s.engine, dependsOn: () => new Map() },
            { kind },
          ).then((o) => o.kind),
        );
        expect(e.rpcCode, `${kind} ${method}`).toBe(-32000);
        expect(e.message).toContain("ERR_INCIDENT_FORBIDDEN_CLIENT");
        expect(ran, `${kind} ${method} touched the database`).toEqual([]);
        expect(s.calls).toEqual([]);
      }
    }
    for (const kind of ["cli", "ui"] as const) {
      const s = setup();
      expect(((await call(s, "incident.list", {}, kind)) as ListOut).status).toBe("no_data");
    }
  });

  test("the check is one function, and a kind param is refused", () => {
    expect(() => requireOwnerKind("cli")).not.toThrow();
    expect(() => requireOwnerKind("mcp")).toThrow(IncidentRpcError);
  });

  test("an unknown method is a miss", async () => {
    const s = setup();
    expect(
      await dispatchIncidentRpc(
        "incident.zzz",
        {},
        { db: s.db, engine: s.engine, dependsOn: () => new Map() },
        { kind: "cli" },
      ),
    ).toEqual({ kind: "miss" });
  });
});

describe("Phase 10 IC4: incident.timeline and the cascade", () => {
  const dep = (): ReadonlyMap<string, readonly string[]> =>
    new Map([
      ["payment-service", ["db"]],
      ["db", []],
    ]);

  async function twoRecords(s: ReturnType<typeof setup>): Promise<{ a: string; b: string }> {
    const dbCfg = serviceConfig({
      serviceId: "db",
      pagerdutyServices: ["PSVC_DB"],
      jsmAlertTags: [],
      sentryProjects: [],
      dataModels: [],
    });
    const r2 = resolverFor(cfg, dbCfg);
    const a = writePagerdutyIncident(
      s.db,
      { id: "CA", openedAtMs: NOW - 20 * 60_000, priority: "P1" },
      r2,
    );
    const b = writePagerdutyIncident(
      s.db,
      { id: "CB", openedAtMs: NOW - 15 * 60_000, priority: "P1", pagerdutyServiceId: "PSVC_DB" },
      r2,
    );
    const engine = createIncidentEngine({
      db: s.db,
      now: () => NOW,
      emit: () => {},
      loadServiceConfigs: () => configMap(cfg, dbCfg),
      readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
      demo: false,
      logger: { warn: () => {} },
    });
    await engine.assembleNow(a);
    await engine.assembleNow(b);
    return { a, b };
  }

  test("timeline: params are validated and an unknown id or version is a typed error", async () => {
    const s = setup();
    const { a } = await twoRecords(s);
    for (const p of [
      {},
      { id: "" },
      { id: a, version: 0 },
      { id: a, version: 1.5 },
      { id: a, extra: 1 },
    ]) {
      expect((await rpcError(call(s, "incident.timeline", p))).rpcCode).toBe(-32602);
    }
    expect(
      (await rpcError(call(s, "incident.timeline", { id: "nothing:here" }))).message,
    ).toContain("ERR_INCIDENT_NOT_FOUND");
    expect((await rpcError(call(s, "incident.timeline", { id: a, version: 9 }))).message).toContain(
      "ERR_INCIDENT_VERSION_NOT_FOUND",
    );
    const ok = (await call(s, "incident.timeline", { id: a })) as {
      events: { kind: string }[];
      version: number;
    };
    expect(ok.events.map((e) => e.kind)).toContain("opened");
    expect(ok.version).toBe(1);
  });

  test("get answers the live cascade of a record, and null for a record alone", async () => {
    const s = setup();
    const { a, b } = await twoRecords(s);
    const got = (await call(s, "incident.get", { id: a }, "cli", dep)) as {
      record: {
        cascade: { status: string; role: string; rootRecordId: string; markdown: string } | null;
      };
    };
    expect(got.record.cascade?.status).toBe("ok");
    expect(got.record.cascade?.role).toBe("downstream");
    expect(got.record.cascade?.markdown).toContain("## Cascade");
    const bId = (await call(s, "incident.list", {})) as ListOut;
    expect(bId.records.map((r) => r.triggerItemId)).toContain(b);
    // no depends_on declared: still a cluster, ranked by time and labelled so
    const none = (await call(s, "incident.get", { id: a })) as {
      record: { cascade: { markdown: string } };
    };
    expect(none.record.cascade.markdown).toContain("no depends_on is declared");
    // closed records are not part of a cascade
    s.db.run("UPDATE incident_record SET status = 'closed'");
    const alone = (await call(s, "incident.get", { id: a })) as { record: { cascade: unknown } };
    expect(alone.record.cascade).toBeNull();
  });

  test("get degrades to cascade unavailable when the depends_on read throws; list { cascade: true } returns groups", async () => {
    const s = setup();
    const { a } = await twoRecords(s);
    const bad = (await call(s, "incident.get", { id: a }, "cli", () => {
      throw new Error("x");
    })) as { record: { cascade: { status: string } } };
    expect(bad.record.cascade).toEqual({ status: "unavailable" });
    const listed = (await call(s, "incident.list", { cascade: true }, "cli", dep)) as ListOut & {
      groups: unknown[];
    };
    expect(listed.groups).toHaveLength(1);
    expect((await call(s, "incident.list", {})) as object).not.toHaveProperty("groups");
    expect((await rpcError(call(s, "incident.list", { cascade: "yes" }))).rpcCode).toBe(-32602);
  });
});

describe("IC5a: remediate, undo, proposals and the advisory switch", () => {
  type Calls = string[];
  function fakeRemediation(calls: Calls): Remediation {
    return {
      proposals: (ref: string) => {
        calls.push(`proposals ${ref}`);
        return { recordId: "inc_x", version: 1, advisory: false, proposals: [], unavailable: [] };
      },
      remediate: async (p: { ref: string; proposalId: string; clientId: string }) => {
        calls.push(`remediate ${p.ref} ${p.proposalId} ${p.clientId}`);
        if (p.proposalId === "prp_ffffffffffffffff") {
          throw new RemediationError("ERR_PROPOSAL_STALE", "stale");
        }
        if (p.proposalId === "prp_eeeeeeeeeeeeeeee") {
          throw new IncidentError("ERR_INCIDENT_NOT_FOUND", "gone");
        }
        if (p.proposalId === "prp_dddddddddddddddd") throw new Error("boom");
        return {
          proposalId: p.proposalId,
          actionId: "act_1",
          status: "executed",
          nonHuman: false,
          undoable: false,
        };
      },
      undo: async (p: { actionId: string; clientId: string }) => {
        calls.push(`undo ${p.actionId} ${p.clientId}`);
        return { actionId: p.actionId, status: "undone", nonHuman: false };
      },
      advisory: () => {
        calls.push("advisory");
        return true;
      },
      setAdvisory: (on: boolean) => {
        calls.push(`set ${String(on)}`);
        return on;
      },
    } as unknown as Remediation;
  }

  async function act(
    method: string,
    params: unknown,
    over: {
      kind?: ClientKind;
      clientId?: string | undefined;
      remediation?: Remediation | undefined;
    } = {},
  ): Promise<unknown> {
    const s = setup();
    const out = await dispatchIncidentRpc(
      method,
      params,
      {
        db: s.db,
        engine: s.engine,
        dependsOn: () => new Map(),
        ...(over.remediation === undefined ? {} : { remediation: over.remediation }),
      },
      {
        kind: over.kind ?? "cli",
        ...("clientId" in over
          ? over.clientId === undefined
            ? {}
            : { clientId: over.clientId }
          : { clientId: "client-1" }),
      },
    );
    if (out.kind === "miss") throw new Error(`miss ${method}`);
    return out.value;
  }

  test("each method reaches the service with THIS connection's client id and nothing else", async () => {
    const calls: Calls = [];
    const r = fakeRemediation(calls);
    await act("incident.proposals", { id: "inc_a" }, { remediation: r });
    await act(
      "incident.remediate",
      { id: "inc_a", proposalId: "prp_0123456789abcdef" },
      { remediation: r },
    );
    await act("incident.undo", { actionId: "act_0123456789abcdef" }, { remediation: r });
    expect(await act("incident.advisory", {}, { remediation: r })).toEqual({ advisory: true });
    expect(await act("incident.advisorySet", { on: false }, { remediation: r })).toEqual({
      advisory: false,
    });
    expect(calls).toEqual([
      "proposals inc_a",
      "remediate inc_a prp_0123456789abcdef client-1",
      "undo act_0123456789abcdef client-1",
      "advisory",
      "set false",
    ]);
  });

  test("a remediation refusal is a params error `<CODE>: <message>`; other errors propagate", async () => {
    const r = fakeRemediation([]);
    const e = await rpcError(
      act(
        "incident.remediate",
        { id: "a", proposalId: "prp_ffffffffffffffff" },
        { remediation: r },
      ),
    );
    expect(e.rpcCode).toBe(-32602);
    expect(e.message).toBe("ERR_PROPOSAL_STALE: stale");
    const e2 = await rpcError(
      act(
        "incident.remediate",
        { id: "a", proposalId: "prp_eeeeeeeeeeeeeeee" },
        { remediation: r },
      ),
    );
    expect(e2.message).toBe("ERR_INCIDENT_NOT_FOUND: gone");
    await expect(
      act(
        "incident.remediate",
        { id: "a", proposalId: "prp_dddddddddddddddd" },
        { remediation: r },
      ),
    ).rejects.toThrow("boom");
  });

  test("no remediation service, or no connection to ask: refused before anything runs", async () => {
    const none = await rpcError(act("incident.advisory", {}));
    expect(none.message).toContain("ERR_REMEDIATION_UNAVAILABLE");
    const r = fakeRemediation([]);
    for (const [method, params] of [
      ["incident.remediate", { id: "a", proposalId: "prp_0123456789abcdef" }],
      ["incident.undo", { actionId: "act_0123456789abcdef" }],
    ] as const) {
      for (const clientId of [undefined, ""]) {
        const e = await rpcError(act(method, params, { remediation: r, clientId }));
        expect(e.message).toContain("no connection to ask the owner on");
      }
    }
  });

  test("parameters are validated: unknown keys, wrong types, empty and over-long ids", async () => {
    const r = fakeRemediation([]);
    const bad: [string, unknown, RegExp][] = [
      ["incident.proposals", {}, /id must be a non-empty string/],
      ["incident.proposals", { id: "a", extra: 1 }, /unknown parameter "extra"/],
      ["incident.remediate", { id: "a" }, /proposalId must be a non-empty string/],
      ["incident.remediate", { id: "a", proposalId: "p".repeat(65) }, /proposalId/],
      [
        "incident.remediate",
        { id: "a", proposalId: "prp_0123456789abcdef", amount: 1 },
        /unknown parameter/,
      ],
      ["incident.undo", {}, /actionId must be a non-empty string/],
      ["incident.undo", { actionId: "" }, /actionId/],
      ["incident.undo", { actionId: "a", id: "b" }, /unknown parameter "id"/],
      ["incident.advisory", { on: true }, /unknown parameter "on"/],
      ["incident.advisorySet", {}, /on must be a boolean/],
      ["incident.advisorySet", { on: "yes" }, /on must be a boolean/],
    ];
    for (const [method, params, re] of bad) {
      const e = await rpcError(act(method, params, { remediation: r }));
      expect(e.rpcCode).toBe(-32602);
      expect(e.message).toMatch(re);
    }
  });

  test("the IC5a surface stays off the renderer (I7); the LAN refusal is pinned per method in lan-rpc.test.ts", async () => {
    const rust = await Bun.file(
      fileURLToPath(new URL("../../../ui/src-tauri/src/gateway_bridge.rs", import.meta.url)),
    ).text();
    for (const m of ["proposals", "remediate", "undo", "advisory", "advisorySet"]) {
      expect(rust.split(`"incident.${m}"`).length - 1, m).toBe(1);
      // Named once, inside IC10a's negative list (each entry asserted `!is_method_allowed`).
      const pinFn = rust.indexOf("fn allowlist_incident_reads_only()");
      const pinEnd = rust.indexOf("must not be renderer-callable", pinFn);
      const at = rust.indexOf(`"incident.${m}",`);
      expect(pinFn > -1 && at > pinFn && at < pinEnd, m).toBe(true);
    }
  });
});
