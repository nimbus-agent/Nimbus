import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { upsertOncallShift } from "../connectors/oncall-shift-items.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  createOncallNowTool,
  ONCALL_NOW_TOOL_MAX_SERVICE_CHARS,
  withheld,
} from "./oncall-now-tool.ts";

const origFetch = globalThis.fetch;

function make() {
  const db = createMemoryIndexDb();
  const localIndex = new LocalIndex(db);
  return { db, localIndex };
}

function run(
  tool: ReturnType<typeof createOncallNowTool>,
  input: unknown,
): Promise<Record<string, unknown>> {
  const exec = tool.execute as unknown as (i: unknown) => Promise<Record<string, unknown>>;
  return exec(input);
}

function seed(
  db: ReturnType<typeof createMemoryIndexDb>,
  over: Record<string, unknown> = {},
): void {
  const now = Date.now();
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
      startMs: now - 3_600_000,
      endMs: now + 3_600_000,
      serviceIds: ["P1"],
      serviceNames: ["payment-service"],
      serviceMapComplete: true,
      isMe: true,
      url: null,
      ...over,
    },
    now,
  );
}

beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error("oncall_now must not call out");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe("oncall_now tool", () => {
  test("returns the reader's result without e-mail addresses anywhere", async () => {
    const { db, localIndex } = make();
    seed(db, { userName: "bob@acme.com", userId: "U2", policyName: "p@q.io" });
    seed(db);
    const tool = createOncallNowTool({ localIndex, serviceConfigs: () => [] });
    const out = await run(tool, { service: "payment-service" });
    expect(out["status"]).toBe("ok");
    expect(JSON.stringify(out)).not.toContain("@");
    const shifts = out["shifts"] as Array<{ userName: string; isMe: boolean }>;
    expect(shifts.map((s) => s.userName).sort()).toEqual(["Alice Ng", "bob"]);
    expect("userEmail" in (shifts[0] ?? {})).toBe(false);
    expect(typeof out["note"]).toBe("string");
  });

  test("the service argument is clipped, and a non-string is ignored", async () => {
    const { db, localIndex } = make();
    seed(db);
    const tool = createOncallNowTool({
      localIndex,
      serviceConfigs: () => [],
    });
    const long = await run(tool, { service: "x".repeat(500) });
    expect(long["query"] as string).toHaveLength(ONCALL_NOW_TOOL_MAX_SERVICE_CHARS);
    expect((await run(tool, { service: 5 }))["query"]).toBeNull();
    expect((await run(tool, { service: "   " }))["query"]).toBeNull();
    expect((await run(tool, "junk"))["query"]).toBeNull();
    expect((await run(tool, undefined))["status"]).toBe("ok");
  });

  test("a binding resolves the service through the per-call config getter", async () => {
    const { db, localIndex } = make();
    seed(db);
    const tool = createOncallNowTool({
      localIndex,
      serviceConfigs: () => [{ serviceId: "checkout", pagerdutyServices: ["P1"] }],
    });
    expect((await run(tool, { service: "checkout" }))["resolvedVia"]).toBe("binding");
  });

  test("refusal statuses come back as data with a note, not as an error", async () => {
    const { db, localIndex } = make();
    const tool = createOncallNowTool({ localIndex, serviceConfigs: () => [] });
    const none = await run(tool, {});
    expect(none["status"]).toBe("no_data");
    expect(String(none["note"])).toContain("Do not name anyone as on call");
    seed(db);
    const miss = await run(tool, { service: "zzz-unknown" });
    expect(miss["status"]).toBe("no_match");
    expect(Array.isArray(miss["known"])).toBe(true);
  });

  test("it writes nothing", async () => {
    const { db, localIndex } = make();
    seed(db);
    const before = db.query("SELECT total_changes() AS n").get() as { n: number };
    const tool = createOncallNowTool({ localIndex, serviceConfigs: () => [] });
    await run(tool, {});
    expect(db.query("SELECT total_changes() AS n").get()).toEqual(before);
  });
});

describe("withheld equals the former e-mail regex", () => {
  const former = (s: string): string => s.replace(/([^\s@]+)@[^\s@]+/g, "$1");

  test("every string of up to 7 characters over name, @, ASCII and Unicode spaces and a lone surrogate", () => {
    const alphabet = ["a", "@", " ", "\u00a0", "\n", "\ud83d"];
    let level = [""];
    for (let len = 1; len <= 7; len += 1) {
      level = level.flatMap((p) => alphabet.map((c) => p + c));
      for (const s of level) {
        if (withheld(s) !== former(s)) expect([s, withheld(s)]).toEqual([s, former(s)]);
      }
    }
  });

  test("examples, and a long run with no domain stays linear", () => {
    expect(withheld("bob@acme.com and p@q.io, x@ @y a@b@c@d")).toBe("bob and p x@ @y a@c");
    const long = `${"a".repeat(200_000)}@`;
    const t0 = performance.now();
    expect(withheld(long)).toBe(long);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
