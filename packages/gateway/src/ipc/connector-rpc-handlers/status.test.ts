import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRpcFixture, type RpcFixture } from "../../../test/helpers/rpc-harness.ts";
import { transitionHealth } from "../../connectors/health.ts";
import { ConnectorRpcError } from "../connector-rpc-shared.ts";
import type { ConnectorRpcHandlerContext } from "./context.ts";
import {
  handleConnectorHealthHistory,
  handleConnectorListStatus,
  handleConnectorStatus,
} from "./status.ts";

let fixture: RpcFixture;

beforeEach(() => {
  fixture = createRpcFixture();
});

afterEach(() => {
  fixture.cleanup();
});

function buildCtx(rec: Record<string, unknown> | undefined): ConnectorRpcHandlerContext {
  return {
    rec,
    vault: fixture.vault,
    localIndex: fixture.localIndex,
    openUrl: async () => {},
    syncScheduler: undefined,
    connectorMesh: undefined,
    notify: fixture.notify,
  };
}

function registerConnector(id: string): void {
  fixture.localIndex.ensureConnectorSchedulerRegistration(id, 60_000, 1_700_000_000_000);
}

function seedHistory(id: string, count: number): void {
  for (let i = 0; i < count; i++) {
    transitionHealth(fixture.db, id, { type: "sync_success" });
  }
}

function seedTelemetry(service: string, count: number): void {
  for (let i = 0; i < count; i++) {
    fixture.db.run(
      `INSERT INTO sync_telemetry
       (service, started_at, duration_ms, items_upserted, items_deleted, bytes_transferred, had_more, error_msg)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [service, 1_700_000_000_000 + i, 100, i, 0, null, 0, null],
    );
  }
}

describe("handleConnectorListStatus", () => {
  test("no filter returns all rows", () => {
    registerConnector("github");
    registerConnector("slack");
    const r = handleConnectorListStatus(buildCtx({}));
    expect(r.kind).toBe("hit");
    const list = r.value as Array<{ serviceId: string }>;
    expect(list.map((x) => x.serviceId).sort((a, b) => a.localeCompare(b))).toEqual([
      "github",
      "slack",
    ]);
  });

  test("undefined rec returns all rows", () => {
    registerConnector("github");
    const r = handleConnectorListStatus(buildCtx(undefined));
    expect(r.kind).toBe("hit");
    expect(r.value as unknown[]).toHaveLength(1);
  });

  test("empty-string serviceId filter is treated as no filter", () => {
    registerConnector("github");
    registerConnector("slack");
    const r = handleConnectorListStatus(buildCtx({ serviceId: "" }));
    expect(r.kind).toBe("hit");
    expect(r.value as unknown[]).toHaveLength(2);
  });

  test("non-string serviceId is treated as no filter", () => {
    registerConnector("github");
    const r = handleConnectorListStatus(buildCtx({ serviceId: 42 }));
    expect(r.kind).toBe("hit");
    expect(r.value as unknown[]).toHaveLength(1);
  });

  test("valid serviceId filter returns subset", () => {
    registerConnector("github");
    registerConnector("slack");
    const r = handleConnectorListStatus(buildCtx({ serviceId: "github" }));
    expect(r.kind).toBe("hit");
    const list = r.value as Array<{ serviceId: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.serviceId).toBe("github");
  });

  test("unknown serviceId filter throws -32602", () => {
    registerConnector("github");
    try {
      handleConnectorListStatus(buildCtx({ serviceId: "::::invalid::::" }));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConnectorRpcError);
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("Invalid serviceId filter");
    }
  });
});

describe("handleConnectorStatus", () => {
  test("known serviceId without stats returns the row only", () => {
    registerConnector("github");
    const r = handleConnectorStatus(buildCtx({ serviceId: "github" }));
    expect(r.kind).toBe("hit");
    const v = r.value as { serviceId: string; telemetry?: unknown };
    expect(v.serviceId).toBe("github");
    expect(v.telemetry).toBeUndefined();
  });

  test("includeStats: true attaches telemetry", () => {
    registerConnector("github");
    seedTelemetry("github", 3);
    const r = handleConnectorStatus(buildCtx({ serviceId: "github", includeStats: true }));
    expect(r.kind).toBe("hit");
    const v = r.value as { serviceId: string; telemetry: unknown[] };
    expect(v.telemetry).toHaveLength(3);
  });

  test("stats: true alias attaches telemetry", () => {
    registerConnector("github");
    seedTelemetry("github", 1);
    const r = handleConnectorStatus(buildCtx({ serviceId: "github", stats: true }));
    expect(r.kind).toBe("hit");
    const v = r.value as { telemetry: unknown[] };
    expect(v.telemetry).toHaveLength(1);
  });

  test("unknown serviceId throws -32602", () => {
    try {
      handleConnectorStatus(buildCtx({ serviceId: "github" }));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("Unknown connector");
    }
  });

  test("missing serviceId throws -32602", () => {
    try {
      handleConnectorStatus(buildCtx({}));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("Missing serviceId");
    }
  });
});

describe("handleConnectorHealthHistory", () => {
  test("default limit (100) returns all history rows newest first", () => {
    registerConnector("github");
    seedHistory("github", 3);
    const r = handleConnectorHealthHistory(buildCtx({ service: "github" }));
    expect(r.kind).toBe("hit");
    const list = r.value as Array<{
      id: number;
      connectorId: string;
      toState: string;
      occurredAtMs: number;
    }>;
    expect(list).toHaveLength(3);
    expect(list[0]?.connectorId).toBe("github");
    expect(list[0]?.toState).toBe("healthy");
    expect(typeof list[0]?.occurredAtMs).toBe("number");
  });

  // `seeded` is how many history rows exist; `returned` is how many the clamped limit yields —
  // so the 99_999 row proves the 500 ceiling by returning everything seeded, not the raw limit.
  test.each([
    ["custom limit is honored", 5, 2, 2],
    ["limit < 1 is clamped to 1", 3, 0, 1],
    ["limit > 500 is clamped to 500", 2, 99_999, 2],
    ["limit float is floored", 4, 2.9, 2],
  ])("%s", (_label, seeded, limit, returned) => {
    registerConnector("github");
    seedHistory("github", seeded);
    const r = handleConnectorHealthHistory(buildCtx({ service: "github", limit }));
    expect(r.kind).toBe("hit");
    expect(r.value as unknown[]).toHaveLength(returned);
  });

  test("non-finite limit is ignored (default 100)", () => {
    registerConnector("github");
    seedHistory("github", 3);
    const r = handleConnectorHealthHistory(
      buildCtx({ service: "github", limit: Number.POSITIVE_INFINITY }),
    );
    expect(r.kind).toBe("hit");
    expect(r.value as unknown[]).toHaveLength(3);
  });

  test("non-number limit is ignored (default 100)", () => {
    registerConnector("github");
    seedHistory("github", 3);
    const r = handleConnectorHealthHistory(buildCtx({ service: "github", limit: "many" }));
    expect(r.kind).toBe("hit");
    expect(r.value as unknown[]).toHaveLength(3);
  });

  test("missing service throws -32602", () => {
    try {
      handleConnectorHealthHistory(buildCtx({}));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
    }
  });

  test("invalid service id throws -32602", () => {
    try {
      handleConnectorHealthHistory(buildCtx({ service: "::::invalid::::" }));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
    }
  });
});
