import { describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import {
  flattenOncallText,
  formatOncallUtc,
  type OncallShiftInput,
  oncallShiftBodyPreview,
  oncallShiftExternalId,
  oncallShiftTitle,
  upsertOncallShift,
} from "./oncall-shift-items.ts";

const END = Date.UTC(2026, 10, 12, 8, 0);

function pd(over: Partial<OncallShiftInput> = {}): OncallShiftInput {
  return {
    source: "pagerduty",
    userId: "U1",
    userName: "Alice Ng",
    userEmail: "alice@example.com",
    policyId: "EP1",
    policyName: "Payments policy",
    level: 1,
    scheduleId: "S1",
    scheduleName: "Payments primary",
    startMs: END - 3_600_000,
    endMs: END,
    serviceIds: ["P1"],
    serviceNames: ["payment-service"],
    serviceMapComplete: true,
    isMe: false,
    url: "https://x.pagerduty.com/schedules/S1",
    ...over,
  };
}

describe("oncall shift title", () => {
  test("PagerDuty with an end", () => {
    expect(oncallShiftTitle(pd())).toBe(
      "On call: Alice Ng — Payments primary (level 1) until 2026-11-12 08:00 UTC",
    );
  });
  test("no end, no schedule, no level", () => {
    expect(oncallShiftTitle(pd({ endMs: null, scheduleName: null, level: null }))).toBe(
      "On call: Alice Ng — Payments policy",
    );
  });
  test("a JSM next shift", () => {
    expect(
      oncallShiftTitle(
        pd({ source: "jsm", shift: "next", level: null, endMs: null, startMs: null }),
      ),
    ).toBe("Next on call: Alice Ng — Payments primary");
  });
  test("long and control-character names are cut and flattened", () => {
    const t = oncallShiftTitle(pd({ userName: `A\nB\u001b[31m${"x".repeat(200)}` }));
    expect(t.includes("\n")).toBe(false);
    expect(t.includes("\u001b")).toBe(false);
    expect(t.length).toBeLessThan(220);
    expect(flattenOncallText("a b\u007fc")).toBe("a b c");
    expect(oncallShiftTitle(pd({ scheduleName: null, policyName: null }))).toContain(
      "unknown schedule",
    );
  });
  test("UTC formatting", () => {
    expect(formatOncallUtc(END)).toBe("2026-11-12 08:00 UTC");
  });
});

describe("oncall shift external id", () => {
  test("is stable, start-sensitive, namespaced and never an incident id", () => {
    expect(oncallShiftExternalId(pd())).toBe(oncallShiftExternalId(pd()));
    expect(oncallShiftExternalId(pd())).not.toBe(oncallShiftExternalId(pd({ startMs: 5 })));
    expect(oncallShiftExternalId(pd())).toStartWith("oncall:pd:EP1:1:S1:U1:");
    const bare = oncallShiftExternalId(
      pd({ policyId: null, level: null, scheduleId: null, startMs: null }),
    );
    expect(bare).toBe("oncall:pd:-:-:-:U1:-");
    expect(oncallShiftExternalId(pd({ source: "jsm", shift: "next" }))).toBe(
      "oncall:jsm:S1:next:U1",
    );
    expect(oncallShiftExternalId(pd({ source: "jsm", scheduleId: null }))).toBe(
      "oncall:jsm:-:current:U1",
    );
  });
});

describe("oncall shift body preview", () => {
  test("lists the policy and the covered services, or says unknown", () => {
    expect(oncallShiftBodyPreview(pd())).toBe(
      "Escalation policy: Payments policy. Covers: payment-service.",
    );
    expect(oncallShiftBodyPreview(pd({ serviceNames: [], policyName: null }))).toBe(
      "Escalation policy: unknown. Covers: (unknown).",
    );
  });
});

describe("upsertOncallShift", () => {
  test("lands as an oncall_shift item with the exact metadata key set", () => {
    const db = createMemoryIndexDb();
    try {
      const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "pagerduty");
      const id = upsertOncallShift(ctx, pd({ isMe: true }), 1000);
      const row = db
        .query("SELECT type, service, title, metadata FROM item WHERE external_id = ?")
        .get(id) as { type: string; service: string; title: string; metadata: string };
      expect(row.type).toBe("oncall_shift");
      expect(row.service).toBe("pagerduty");
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      expect(Object.keys(meta).sort()).toEqual(
        [
          "end_ms",
          "escalation_level",
          "escalation_policy_id",
          "escalation_policy_name",
          "fetched_at_ms",
          "is_me",
          "schedule_id",
          "schedule_name",
          "service_ids",
          "service_map_complete",
          "service_names",
          "source",
          "start_ms",
          "user_email",
          "user_name",
        ].sort(),
      );
      expect(meta["is_me"]).toBe(true);
      expect(meta["fetched_at_ms"]).toBe(1000);
    } finally {
      db.close();
    }
  });

  test("omits unknown values and carries the JSM shift key", () => {
    const db = createMemoryIndexDb();
    try {
      const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "jira");
      const id = upsertOncallShift(
        ctx,
        pd({
          source: "jsm",
          shift: "current",
          userEmail: null,
          policyId: null,
          policyName: null,
          level: null,
          startMs: null,
          endMs: null,
        }),
        5,
      );
      const row = db.query("SELECT metadata FROM item WHERE external_id = ?").get(id) as {
        metadata: string;
      };
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      expect(meta["shift"]).toBe("current");
      for (const k of ["user_email", "start_ms", "end_ms", "escalation_level"]) {
        expect(k in meta).toBe(false);
      }
    } finally {
      db.close();
    }
  });
});
