import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import type { PushDelivery } from "./push-runner.ts";
import { createPushDeliverer, PUSH_NOTIFY_CAP } from "./push-sinks.ts";
import { PushStore } from "./push-store.ts";

let db: Database;
let store: PushStore;
beforeEach(() => {
  db = createMemoryIndexDb();
  store = new PushStore(db);
});
afterEach(() => db.close());

function item(id: string, status: "ok" | "failed", openedAtMs: number): PushDelivery {
  const row = store.insert(
    id,
    status === "ok"
      ? { status, sessionId: "s", briefMarkdown: "m", briefJson: "{}" }
      : { status, sessionId: null, failureCode: "timeout: x" },
    1,
  );
  return {
    row,
    incident: {
      id,
      title: `P1 ${id}`,
      url: null,
      status: "triggered",
      severity: "P1",
      urgency: "high",
      openedAtMs,
      pagerdutyServiceId: "S",
      assigneeEmails: [],
    },
  };
}

test("one ok brief → one pointer toast, one id-only event, both recorded", async () => {
  const toasts: [string, string][] = [];
  const events: unknown[] = [];
  const deliver = createPushDeliverer({
    store,
    notify: (t, b) => {
      toasts.push([t, b]);
    },
    emit: (p) => events.push(p),
    now: () => 9,
  });
  await deliver([item("pagerduty:A", "ok", 100)]);
  expect(toasts).toEqual([
    ["Nimbus on-call", "P1 pagerduty:A — brief ready: nimbus oncall pushed pagerduty:A"],
  ]);
  expect(events).toEqual([{ incidentId: "pagerduty:A", status: "ok" }]);
  expect(store.get("pagerduty:A")?.delivery).toEqual({
    toast: { outcome: "delivered", at: 9 },
    event: { outcome: "delivered", at: 9 },
  });
});

test("a failed brief still notifies, saying so", async () => {
  const toasts: string[] = [];
  await createPushDeliverer({
    store,
    notify: (_t, b) => {
      toasts.push(b);
    },
    emit: () => {},
    now: () => 1,
  })([item("pagerduty:F", "failed", 1)]);
  expect(toasts[0]).toBe(
    "P1 pagerduty:F — brief could not be assembled: nimbus oncall pushed pagerduty:F",
  );
});

test(`more than ${PUSH_NOTIFY_CAP}: newest ${PUSH_NOTIFY_CAP} toasted + one summary; rest coalesced; events for ALL`, async () => {
  const toasts: string[] = [];
  const events: unknown[] = [];
  const items = [1, 5, 3, 4, 2].map((n) => item(`pagerduty:${n}`, "ok", n));
  await createPushDeliverer({
    store,
    notify: (_t, b) => {
      toasts.push(b);
    },
    emit: (p) => events.push(p),
    now: () => 1,
  })(items);
  expect(toasts.slice(0, 3).map((b) => b.split(" ")[1])).toEqual([
    "pagerduty:5",
    "pagerduty:4",
    "pagerduty:3",
  ]);
  expect(toasts[3]).toBe("Briefs ready for 5 P1 incidents (3 shown) — nimbus oncall pushed list");
  expect(toasts).toHaveLength(4);
  expect(events).toHaveLength(5);
  expect(store.get("pagerduty:1")?.delivery["toast"]?.outcome).toBe("coalesced");
});

test("a throwing toast does not block the event, and is recorded as failed", async () => {
  const events: unknown[] = [];
  await createPushDeliverer({
    store,
    notify: () => {
      throw new Error("no display");
    },
    emit: (p) => events.push(p),
    now: () => 1,
  })([item("pagerduty:A", "ok", 1)]);
  expect(events).toHaveLength(1);
  expect(store.get("pagerduty:A")?.delivery["toast"]).toEqual({
    outcome: "failed",
    reason: "no display",
    at: 1,
  });
});
