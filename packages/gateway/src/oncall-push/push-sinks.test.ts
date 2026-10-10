import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { renderPushHeadline, renderPushSummary } from "./push-headline.ts";
import type { PushDelivery } from "./push-runner.ts";
import {
  CHATOPS_NOT_RUNNING_REASON,
  createPushDeliverer,
  NO_NAMESPACE_REASON,
  NO_NOTIFIER_REASON,
  PUSH_NOTIFY_CAP,
} from "./push-sinks.ts";
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
  expect(toasts[3]).toBe("5 P1 incidents paged (5 briefs ready) — nimbus oncall pushed list");
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

function throwingStore(failOn: (sink: string) => boolean): PushStore {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "recordDelivery") {
        return (id: string, sink: string, o: Parameters<PushStore["recordDelivery"]>[2]) => {
          if (failOn(sink)) throw new Error("store down");
          return target.recordDelivery(id, sink, o);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

test("emit throws → every toast still goes out and the event is recorded failed", async () => {
  const toasts: string[] = [];
  await createPushDeliverer({
    store,
    notify: (_t, b) => {
      toasts.push(b);
    },
    emit: () => {
      throw new Error("bus closed");
    },
    now: () => 1,
  })([item("pagerduty:A", "ok", 2), item("pagerduty:B", "ok", 1)]);
  expect(toasts).toHaveLength(2);
  expect(store.get("pagerduty:A")?.delivery["event"]).toEqual({
    outcome: "failed",
    reason: "bus closed",
    at: 1,
  });
  expect(store.get("pagerduty:A")?.delivery["toast"]?.outcome).toBe("delivered");
});

test("notify returns a rejected promise → toast failed, event still delivered", async () => {
  await createPushDeliverer({
    store,
    notify: () => Promise.reject(new Error("async no display")),
    emit: () => {},
    now: () => 1,
  })([item("pagerduty:A", "ok", 1)]);
  expect(store.get("pagerduty:A")?.delivery["toast"]).toEqual({
    outcome: "failed",
    reason: "async no display",
    at: 1,
  });
  expect(store.get("pagerduty:A")?.delivery["event"]?.outcome).toBe("delivered");
});

test("recordDelivery throws → deliverer resolves; all toasts and events still attempted", async () => {
  const items = [item("pagerduty:A", "ok", 2), item("pagerduty:B", "ok", 1)];
  const toasts: string[] = [];
  const events: unknown[] = [];
  await createPushDeliverer({
    store: throwingStore(() => true),
    notify: (_t, b) => {
      toasts.push(b);
    },
    emit: (p) => events.push(p),
    now: () => 1,
  })(items);
  expect(events).toHaveLength(2);
  expect(toasts).toHaveLength(2);
});

test("emit succeeds but its record throws → the event is not re-recorded as failed, later sinks run", async () => {
  const attempted: string[] = [];
  const recorded: string[] = [];
  const inner = throwingStore((s) => s === "event");
  const spy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "recordDelivery") {
        return (id: string, sink: string, o: { outcome: string }) => {
          recorded.push(`${sink}:${o.outcome}`);
          return (target.recordDelivery as (...a: unknown[]) => void)(id, sink, o);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  await createPushDeliverer({
    store: spy,
    notify: (_t, b) => {
      attempted.push(b);
    },
    emit: () => {},
    now: () => 1,
  })([item("pagerduty:A", "ok", 1)]);
  expect(recorded).toEqual(["event:delivered", "toast:delivered"]);
  expect(attempted).toHaveLength(1);
});

test("one sink at a time: events in stored order, toasts newest first, each recorded before the next goes out", async () => {
  const seen: string[] = [];
  const spy = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "recordDelivery") {
        return (id: string, sink: string, o: Parameters<PushStore["recordDelivery"]>[2]) => {
          seen.push(`record ${sink} ${id}`);
          return target.recordDelivery(id, sink, o);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  await createPushDeliverer({
    store: spy,
    notify: (_t, b) => {
      seen.push(`toast ${b.split("nimbus oncall pushed ")[1]}`);
    },
    emit: (p) => {
      seen.push(`emit ${p.incidentId}`);
    },
    now: () => 1,
  })([
    item("pagerduty:e1", "ok", 1),
    item("pagerduty:e2", "failed", 3),
    item("pagerduty:e3", "ok", 2),
  ]);
  expect(seen).toEqual([
    "emit pagerduty:e1",
    "record event pagerduty:e1",
    "emit pagerduty:e2",
    "record event pagerduty:e2",
    "emit pagerduty:e3",
    "record event pagerduty:e3",
    "toast pagerduty:e2",
    "record toast pagerduty:e2",
    "toast pagerduty:e3",
    "record toast pagerduty:e3",
    "toast pagerduty:e1",
    "record toast pagerduty:e1",
  ]);
});

test("a throwing summary toast records overflow rows coalesced WITH the reason", async () => {
  let calls = 0;
  const items = [1, 2, 3, 4].map((n) => item(`pagerduty:${n}`, "ok", n));
  await createPushDeliverer({
    store,
    notify: () => {
      calls += 1;
      if (calls === 4) throw new Error("summary boom");
    },
    emit: () => {},
    now: () => 1,
  })(items);
  expect(store.get("pagerduty:1")?.delivery["toast"]).toEqual({
    outcome: "coalesced",
    reason: "summary toast failed: summary boom",
    at: 1,
  });
});

test("boundary: exactly 3 → 3 toasts, no summary; exactly 4 → 3 + summary + 1 coalesced", async () => {
  const run = async (n: number): Promise<string[]> => {
    const toasts: string[] = [];
    const items = Array.from({ length: n }, (_, i) => item(`pagerduty:b${n}-${i}`, "ok", i + 1));
    await createPushDeliverer({
      store,
      notify: (_t, b) => {
        toasts.push(b);
      },
      emit: () => {},
      now: () => 1,
    })(items);
    return toasts;
  };
  const three = await run(3);
  expect(three).toHaveLength(3);
  expect(three.some((b) => b.includes("incidents paged"))).toBe(false);
  const four = await run(4);
  expect(four).toHaveLength(4);
  expect(four[3]).toContain("4 P1 incidents paged");
  expect(store.get("pagerduty:b4-0")?.delivery["toast"]?.outcome).toBe("coalesced");
});

test("the summary counts only ok rows as ready — a failed brief is paged, not ready", async () => {
  const toasts: string[] = [];
  const items = [
    item("pagerduty:s1", "ok", 1),
    item("pagerduty:s2", "failed", 2),
    item("pagerduty:s3", "failed", 3),
    item("pagerduty:s4", "ok", 4),
    item("pagerduty:s5", "failed", 5),
  ];
  await createPushDeliverer({
    store,
    notify: (_t, b) => {
      toasts.push(b);
    },
    emit: () => {},
    now: () => 1,
  })(items);
  expect(toasts[3]).toBe("5 P1 incidents paged (2 briefs ready) — nimbus oncall pushed list");
});

test("notifyDelivers false → every toast skipped with the reason, notify never called, no summary, events delivered", async () => {
  let notifyCalls = 0;
  const events: unknown[] = [];
  const items = [1, 2, 3, 4, 5].map((n) => item(`pagerduty:n${n}`, n === 2 ? "failed" : "ok", n));
  await createPushDeliverer({
    store,
    notify: () => {
      notifyCalls += 1;
    },
    notifyDelivers: () => false,
    emit: (p) => events.push(p),
    now: () => 7,
  })(items);
  expect(notifyCalls).toBe(0);
  expect(events).toHaveLength(5);
  for (const n of [1, 2, 3, 4, 5]) {
    expect(store.get(`pagerduty:n${n}`)?.delivery).toEqual({
      event: { outcome: "delivered", at: 7 },
      toast: { outcome: "skipped", reason: NO_NOTIFIER_REASON, at: 7 },
    });
  }
  expect(NO_NOTIFIER_REASON).toBe(
    "OS notifications are off or unavailable on this gateway (see nimbus notifications status)",
  );
});

test("an incident with no openedAtMs sorts as oldest: toasted after dated ones, and coalesced first when over the cap", async () => {
  const toasts: string[] = [];
  const undated = (id: string, status: "ok" | "failed"): PushDelivery => {
    const d = item(id, status, 0);
    return { ...d, incident: { ...d.incident, openedAtMs: null } };
  };
  const items = [
    undated("pagerduty:u1", "ok"),
    item("pagerduty:d1", "ok", 10),
    item("pagerduty:d2", "ok", 20),
    undated("pagerduty:u2", "ok"),
  ];
  await createPushDeliverer({
    store,
    notify: (_t, b) => {
      toasts.push(b);
    },
    emit: () => {},
    now: () => 1,
  })(items);
  expect(toasts.slice(0, 3).map((b) => b.split("nimbus oncall pushed ")[1])).toEqual([
    "pagerduty:d2",
    "pagerduty:d1",
    "pagerduty:u1",
  ]);
  expect(store.get("pagerduty:u2")?.delivery["toast"]?.outcome).toBe("coalesced");
});

test("the summary uses the singular '1 brief ready' when exactly one brief was assembled", async () => {
  const toasts: string[] = [];
  const items = [
    item("pagerduty:o1", "ok", 4),
    item("pagerduty:o2", "failed", 3),
    item("pagerduty:o3", "failed", 2),
    item("pagerduty:o4", "failed", 1),
  ];
  await createPushDeliverer({
    store,
    notify: (_t, b) => {
      toasts.push(b);
    },
    emit: () => {},
    now: () => 1,
  })(items);
  expect(toasts[3]).toBe("4 P1 incidents paged (1 brief ready) — nimbus oncall pushed list");
});

test("a sink that throws a non-Error value is recorded failed with the stringified reason", async () => {
  await createPushDeliverer({
    store,
    notify: () => {
      throw "toast exploded";
    },
    emit: () => {
      throw 42;
    },
    now: () => 3,
  })([item("pagerduty:ne", "ok", 1)]);
  expect(store.get("pagerduty:ne")?.delivery).toEqual({
    event: { outcome: "failed", reason: "42", at: 3 },
    toast: { outcome: "failed", reason: "toast exploded", at: 3 },
  });
});

const NS = "project:pay";
function chatDeliverer(
  post: ((text: string) => Promise<number>) | undefined,
  over: {
    namespace?: string;
    notifyDelivers?: boolean;
    notify?: () => void;
    warn?: (m: string, f: Record<string, string>) => void;
  } = {},
) {
  return createPushDeliverer({
    store,
    notify: over.notify ?? (() => {}),
    ...(over.notifyDelivers === undefined
      ? {}
      : { notifyDelivers: () => over.notifyDelivers === true }),
    emit: () => {},
    now: () => 7,
    chatops: { namespace: over.namespace ?? NS, post: () => post },
    ...(over.warn === undefined ? {} : { warn: over.warn }),
  });
}

test("chatops: an empty namespace skips every row and never posts", async () => {
  let calls = 0;
  await chatDeliverer(async () => (calls += 1), { namespace: "" })([item("pagerduty:A", "ok", 1)]);
  expect(calls).toBe(0);
  expect(store.get("pagerduty:A")?.delivery["chatops"]).toEqual({
    outcome: "skipped",
    reason: NO_NAMESPACE_REASON,
    at: 7,
  });
});

test("chatops: an unbound poster skips every row", async () => {
  await chatDeliverer(undefined)([item("pagerduty:A", "ok", 1), item("pagerduty:B", "ok", 2)]);
  for (const id of ["pagerduty:A", "pagerduty:B"]) {
    expect(store.get(id)?.delivery["chatops"]).toMatchObject({
      outcome: "skipped",
      reason: CHATOPS_NOT_RUNNING_REASON,
    });
  }
});

test("chatops: 0 channels → skipped with the namespace named; N → delivered with the real headline", async () => {
  const a = item("pagerduty:A", "ok", 1);
  await chatDeliverer(async () => 0)([a]);
  expect(store.get("pagerduty:A")?.delivery["chatops"]).toMatchObject({
    outcome: "skipped",
    reason: `namespace ${NS} has no notify channels`,
  });
  const texts: string[] = [];
  const b = item("pagerduty:B", "ok", 1);
  await chatDeliverer(async (t) => {
    texts.push(t);
    return 2;
  })([b]);
  expect(texts).toEqual([renderPushHeadline(b)]);
  expect(store.get("pagerduty:B")?.delivery["chatops"]).toEqual({ outcome: "delivered", at: 7 });
});

test("chatops: a throwing post is failed, says partial, is warned once, and the toast still runs", async () => {
  const warns: [string, Record<string, string>][] = [];
  const toasts: number[] = [];
  await chatDeliverer(
    async () => {
      throw new Error("boom");
    },
    { notify: () => void toasts.push(1), warn: (m, f) => void warns.push([m, f]) },
  )([item("pagerduty:A", "ok", 1)]);
  expect(store.get("pagerduty:A")?.delivery["chatops"]).toMatchObject({
    outcome: "failed",
    reason: "boom (delivery may be partial)",
  });
  expect(warns).toEqual([
    [
      "[oncall.push] chatops post failed",
      { incidentId: "pagerduty:A", reason: "boom (delivery may be partial)" },
    ],
  ]);
  expect(toasts).toHaveLength(1);
});

test("chatops: a throwing toast does not stop the chat post", async () => {
  let posted = 0;
  await chatDeliverer(async () => (posted += 1), {
    notify: () => {
      throw new Error("toast down");
    },
  })([item("pagerduty:A", "ok", 1)]);
  expect(posted).toBe(1);
  expect(store.get("pagerduty:A")?.delivery["toast"]?.outcome).toBe("failed");
});

test("chatops: posts even when notifyDelivers is false", async () => {
  let posted = 0;
  await chatDeliverer(async () => (posted += 1), { notifyDelivers: false })([
    item("pagerduty:A", "ok", 1),
  ]);
  expect(posted).toBe(1);
  expect(store.get("pagerduty:A")?.delivery["toast"]?.outcome).toBe("skipped");
  expect(store.get("pagerduty:A")?.delivery["chatops"]?.outcome).toBe("delivered");
});

test(`chatops: past ${PUSH_NOTIFY_CAP}, newest-first headlines then ONE summary; rest coalesced`, async () => {
  const items = [1, 5, 3, 4, 2].map((n) => item(`pagerduty:${n}`, "ok", n));
  const texts: string[] = [];
  await chatDeliverer(async (t) => {
    texts.push(t);
    return 1;
  })(items);
  const byId = (id: string) => items.find((d) => d.row.incidentId === id) as (typeof items)[number];
  expect(texts).toEqual([
    renderPushHeadline(byId("pagerduty:5")),
    renderPushHeadline(byId("pagerduty:4")),
    renderPushHeadline(byId("pagerduty:3")),
    renderPushSummary(items, [byId("pagerduty:2"), byId("pagerduty:1")]),
  ]);
  for (const id of ["pagerduty:2", "pagerduty:1"]) {
    expect(store.get(id)?.delivery["chatops"]).toEqual({ outcome: "coalesced", at: 7 });
  }
});

// The headline loop is sequential by design (the S9382 suppression on it): the channel shows the
// headlines in the order they are posted, so a slow post must hold back the next one rather than
// let it overtake. The FIRST (newest) post is the slow one, so overlapping posts would interleave.
test("chatops: one post in flight at a time — a slow headline holds back the next, and the summary follows them", async () => {
  const items = [1, 2, 3, 4].map((n) => item(`pagerduty:${n}`, "ok", n));
  const events: string[] = [];
  let n = 0;
  await chatDeliverer(async () => {
    n += 1;
    const i = n;
    events.push(`start ${i}`);
    if (i === 1) await new Promise((r) => setTimeout(r, 5));
    events.push(`end ${i}`);
    return 1;
  })(items);
  expect(events).toEqual([
    "start 1",
    "end 1",
    "start 2",
    "end 2",
    "start 3",
    "end 3",
    "start 4",
    "end 4",
  ]);
});

test("chatops: a summary that reaches 0 channels marks the rest skipped, not coalesced", async () => {
  const items = [1, 2, 3, 4].map((n) => item(`pagerduty:${n}`, "ok", n));
  await chatDeliverer(async () => 0)(items);
  expect(store.get("pagerduty:1")?.delivery["chatops"]).toMatchObject({
    outcome: "skipped",
    reason: `namespace ${NS} has no notify channels`,
  });
});

test("chatops: a failed summary post marks the rest coalesced with the reason, and warns per row", async () => {
  const items = [1, 2, 3, 4, 5].map((n) => item(`pagerduty:${n}`, "ok", n));
  let n = 0;
  const warns: string[] = [];
  await chatDeliverer(
    async () => {
      n += 1;
      if (n === 4) throw new Error("rate limited");
      return 1;
    },
    { warn: (_m, f) => void warns.push(f["incidentId"] ?? "") },
  )(items);
  for (const id of ["pagerduty:2", "pagerduty:1"]) {
    expect(store.get(id)?.delivery["chatops"]).toMatchObject({
      outcome: "coalesced",
      reason: "summary post failed: rate limited (delivery may be partial)",
    });
  }
  expect(warns).toEqual(["pagerduty:2", "pagerduty:1"]);
});

test("chatops: the poster is read at delivery time, so a later binding is seen", async () => {
  let bound: ((t: string) => Promise<number>) | undefined;
  const deliver = createPushDeliverer({
    store,
    notify: () => {},
    emit: () => {},
    now: () => 7,
    chatops: { namespace: NS, post: () => bound },
  });
  let posted = 0;
  bound = async () => (posted += 1);
  await deliver([item("pagerduty:A", "ok", 1)]);
  expect(posted).toBe(1);
});

test("chatops: a headline render that throws is a failed row, deliver resolves, and the toast still runs", async () => {
  const bad: PushDelivery = {
    ...item("pagerduty:A", "ok", 1),
    incident: null as unknown as PushDelivery["incident"],
  };
  let posted = 0;
  await chatDeliverer(async () => (posted += 1), {})([bad]);
  expect(posted).toBe(0);
  expect(store.get("pagerduty:A")?.delivery["chatops"]?.outcome).toBe("failed");
  // The toast sink still ran; it is `failed` because its own bodyFor(d) throws on the nulled incident.
  expect(store.get("pagerduty:A")?.delivery["toast"]?.outcome).toBe("failed");
  const reason = store.get("pagerduty:A")?.delivery["chatops"]?.reason ?? "";
  expect(reason.startsWith("could not render: ")).toBe(true);
  expect(reason).not.toContain("(delivery may be partial)");
});

test("chatops: a throwing poster getter skips every row as not running, and the toast still runs", async () => {
  const toasts: number[] = [];
  const deliver = createPushDeliverer({
    store,
    notify: () => void toasts.push(1),
    emit: () => {},
    now: () => 7,
    chatops: {
      namespace: NS,
      post: () => {
        throw new Error("getter down");
      },
    },
  });
  await deliver([item("pagerduty:A", "ok", 1), item("pagerduty:B", "ok", 2)]);
  for (const id of ["pagerduty:A", "pagerduty:B"]) {
    expect(store.get(id)?.delivery["chatops"]).toMatchObject({
      outcome: "skipped",
      reason: CHATOPS_NOT_RUNNING_REASON,
    });
  }
  expect(toasts).toHaveLength(2);
});
