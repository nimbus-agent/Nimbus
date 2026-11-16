import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import type { OncallHandoffResult } from "../index/oncall-handoff-query.ts";
import { dispatchOncallHandoffRpc } from "./oncall-handoff-rpc.ts";
import { OncallNowRpcError } from "./oncall-now-rpc.ts";

const NOW = Date.UTC(2026, 10, 16, 18, 0);
const HOUR = 3_600_000;
const origFetch = globalThis.fetch;

let db: Database;
let dir: string;
beforeEach(() => {
  db = createMemoryIndexDb();
  dir = mkdtempSync(join(tmpdir(), "nimbus-oncall-handoff-"));
  globalThis.fetch = (() => {
    throw new Error("oncall.handoff must never make a network call");
  }) as unknown as typeof fetch;
  syncPagerdutyIncidentItems(
    syncTestContext(db, EMPTY_NIMBUS_VAULT, "pagerduty"),
    [
      {
        id: "INC1",
        title: "Checkout 500s",
        status: "triggered",
        urgency: "high",
        created_at: new Date(NOW - 2 * HOUR).toISOString(),
        updated_at: new Date(NOW - 2 * HOUR).toISOString(),
        service: { id: "P1" },
      },
    ],
    "",
    NOW - 2 * HOUR,
    new Map(),
  );
});
afterEach(() => {
  globalThis.fetch = origFetch;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  params: unknown,
  over: { configDir?: string; warn?: (m: string) => void } = {},
): Promise<OncallHandoffResult> {
  const out = await dispatchOncallHandoffRpc("oncall.handoff", params, {
    db,
    now: () => NOW,
    ...(over.configDir === undefined ? {} : { configDir: over.configDir }),
    ...(over.warn === undefined ? {} : { warn: over.warn }),
  });
  if (out.kind !== "hit") throw new Error("miss");
  return out.value as OncallHandoffResult;
}

async function rpcError(params: unknown): Promise<OncallNowRpcError> {
  const err = await call(params).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(OncallNowRpcError);
  return err as OncallNowRpcError;
}

describe("oncall.handoff", () => {
  test("no params returns the brief for the default window, from the index, with no network", async () => {
    for (const params of [{}, undefined]) {
      const r = await call(params);
      expect(r.status).toBe("ok");
      expect(r.window.basis).toBe("default");
      expect(r.events.items.map((e) => e.kind)).toEqual(["opened"]);
      expect(r.stillOpen.items.map((o) => o.itemId)).toEqual(["pagerduty:INC1"]);
    }
  });

  test("since and until take the gateway's time forms", async () => {
    const r = await call({ since: "-4h", until: "2026-11-16T17:00:00Z" });
    expect(r.window).toMatchObject({
      basis: "explicit",
      fromMs: NOW - 4 * HOUR,
      toMs: Date.UTC(2026, 10, 16, 17, 0),
    });
  });

  test("a [ci.service.*] binding scopes the service", async () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[ci.service.checkout]\nrepos = ["github:acme/c"]\npagerduty_services = ["P1"]\n`,
      "utf8",
    );
    const r = await call({ service: " checkout " }, { configDir: dir });
    expect(r.service).toBe("checkout");
    expect(r.stillOpen.total).toBe(1);
    const none = await call({ service: "other" }, { configDir: dir });
    expect(none.status).toBe("no_match");
  });

  test("rejects bad params with -32602", async () => {
    for (const bad of [
      "x",
      null,
      [],
      { service: 5 },
      { service: "  " },
      { service: "x".repeat(129) },
      { since: 5 },
      { until: "" },
      { since: "x".repeat(65) },
      { a: 1 },
      { since: "not a time" },
      { since: "-1h", until: "-2h" },
      { since: "-40d" },
      { until: "2999-01-01T00:00:00Z" },
    ]) {
      expect((await rpcError(bad)).rpcCode).toBe(-32602);
    }
  });

  test("a malformed config block degrades to no bindings, warns, and still answers", async () => {
    writeFileSync(join(dir, "nimbus.toml"), `[ci.service.]\nrepos = []\n`, "utf8");
    const warnings: string[] = [];
    const r = await call({}, { configDir: dir, warn: (m) => warnings.push(m) });
    expect(r.status).toBe("ok");
    expect(warnings).toHaveLength(1);
  });

  test("the default warner writes to stderr", async () => {
    writeFileSync(join(dir, "nimbus.toml"), `[ci.service.]\nrepos = []\n`, "utf8");
    const orig = process.stderr.write.bind(process.stderr);
    const seen: string[] = [];
    process.stderr.write = ((c: string | Uint8Array) => {
      seen.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      await call({}, { configDir: dir });
    } finally {
      process.stderr.write = orig;
    }
    expect(seen.join("")).toContain("oncall.handoff:");
  });

  test("an unowned method is a miss", async () => {
    const out = await dispatchOncallHandoffRpc("oncall.zzz", {}, { db });
    expect(out.kind).toBe("miss");
  });
});
