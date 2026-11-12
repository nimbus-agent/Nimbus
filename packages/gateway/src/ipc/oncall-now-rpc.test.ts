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
import { upsertOncallShift } from "../connectors/oncall-shift-items.ts";
import type { OncallNowResult } from "../index/oncall-now-query.ts";
import { dispatchOncallNowRpc, OncallNowRpcError } from "./oncall-now-rpc.ts";

const NOW = Date.UTC(2026, 10, 11, 9, 0);
const origFetch = globalThis.fetch;

let db: Database;
let dir: string;
beforeEach(() => {
  db = createMemoryIndexDb();
  dir = mkdtempSync(join(tmpdir(), "nimbus-oncall-now-"));
  globalThis.fetch = (() => {
    throw new Error("oncall.now must never make a network call");
  }) as unknown as typeof fetch;
  upsertOncallShift(
    syncTestContext(db, EMPTY_NIMBUS_VAULT, "pagerduty"),
    {
      source: "pagerduty",
      userId: "U1",
      userName: "Alice Ng",
      userEmail: "alice@example.com",
      policyId: "EP1",
      policyName: "Payments policy",
      level: 1,
      scheduleId: "S1",
      scheduleName: "Payments primary",
      startMs: NOW - 3_600_000,
      endMs: NOW + 3_600_000,
      serviceIds: ["P1"],
      serviceNames: ["payment-service"],
      serviceMapComplete: true,
      isMe: false,
      url: null,
    },
    NOW,
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
): Promise<OncallNowResult> {
  const out = await dispatchOncallNowRpc("oncall.now", params, {
    db,
    now: () => NOW,
    ...(over.configDir === undefined ? {} : { configDir: over.configDir }),
    ...(over.warn === undefined ? {} : { warn: over.warn }),
  });
  if (out.kind !== "hit") throw new Error("miss");
  return out.value as OncallNowResult;
}

describe("oncall.now", () => {
  test("no params returns everything with a null query", async () => {
    for (const params of [{}, undefined]) {
      const r = await call(params);
      expect(r.status).toBe("ok");
      expect(r.query).toBeNull();
      expect(r.shifts[0]?.userName).toBe("Alice Ng");
    }
  });

  test("a service filters, and a [ci.service.*] binding resolves it", async () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      `[ci.service.checkout]\nrepos = ["github:acme/c"]\npagerduty_services = ["P1"]\n`,
      "utf8",
    );
    const r = await call({ service: " checkout " }, { configDir: dir });
    expect(r.resolvedVia).toBe("binding");
    expect(r.query).toBe("checkout");
    expect((await call({ service: "payment-service" })).resolvedVia).toBe("service_name");
  });

  test("rejects bad params with -32602", async () => {
    for (const bad of [
      "x",
      null,
      [],
      { service: 5 },
      { service: "  " },
      { service: "x".repeat(129) },
      { service: "a", extra: 1 },
    ]) {
      const err = await call(bad).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OncallNowRpcError);
      expect((err as OncallNowRpcError).rpcCode).toBe(-32602);
    }
  });

  test("a malformed config block degrades to no bindings, warns, and still answers", async () => {
    writeFileSync(join(dir, "nimbus.toml"), `[ci.service.]\nrepos = []\n`, "utf8");
    const warnings: string[] = [];
    const r = await call(
      { service: "payment-service" },
      { configDir: dir, warn: (m) => warnings.push(m) },
    );
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
    expect(seen.join("")).toContain("oncall.now:");
  });

  test("an unowned method is a miss", async () => {
    const out = await dispatchOncallNowRpc("oncall.zzz", {}, { db });
    expect(out.kind).toBe("miss");
  });
});
