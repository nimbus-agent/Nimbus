import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import {
  HOUR,
  markSynced,
  serviceConfig,
  T0,
  writeSlackMessage,
} from "../__fixtures__/index-writers.ts";
import { chatLane, chatTermsFor, skippedChat } from "./chat.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  markSynced(d, "slack", T0);
  return d;
}

const OPEN = T0 + 2 * HOUR;
const NOW = OPEN + HOUR;
const secs = (ms: number): string => `${String(Math.floor(ms / 1000))}.000100`;
const at = (ms: number, text: string, ts = secs(ms)) =>
  writeSlackMessage(db0, { ts, text, atMs: ms });
let db0: Database;

function run(cfg = serviceConfig()) {
  return chatLane(db0, { cfg, openedAtMs: OPEN, nowMs: NOW });
}

describe("lane 3, chat terms", () => {
  test("derived: service id, Sentry slugs, repo basenames; at least 3 characters, at most 6, no duplicates", () => {
    const t = chatTermsFor(
      serviceConfig({
        sentryProjects: ["payments-api", "ab", "PAYMENT-SERVICE"],
        repos: [
          { provider: "github", providerId: "acme/checkout-web" },
          { provider: "gitlab", providerId: "acme/payment-service" },
        ],
      }),
    );
    expect(t.source).toBe("derived");
    expect(t.terms).toEqual(["payment-service", "payments-api", "checkout-web"]);
    const many = chatTermsFor(
      serviceConfig({
        sentryProjects: ["aaa", "bbb", "ccc", "ddd", "eee", "fff", "ggg"],
        repos: [],
      }),
    );
    expect(many.terms).toHaveLength(6);
  });

  test("configured aliases REPLACE the derivation entirely", () => {
    const t = chatTermsFor(serviceConfig({ chatAliases: ["checkout", "web-checkout"] }));
    expect(t).toEqual({ terms: ["checkout", "web-checkout"], source: "configured" });
  });
});

describe("lane 3, chat", () => {
  test("the window is [open - 24 h, now]; matches carry their term as the rule; newest first", () => {
    db0 = db();
    at(OPEN - 25 * HOUR, "payment-service old thread");
    const early = at(OPEN - 23 * HOUR, "payment-service looked odd yesterday");
    const after = at(OPEN + 10 * 60_000, "Looking at payment-service now");
    at(NOW + 1000, "payment-service from the future");
    at(OPEN, "nothing relevant here");
    const r = run();
    expect(r.lane.messages.map((m) => m.id)).toEqual([after, early]);
    expect(r.lane.messages.every((m) => m.rule === "chat_phrase:payment-service")).toBe(true);
    expect(r.lane.total).toBe(2);
    expect(r.lane.fromMs).toBe(OPEN - 24 * HOUR);
    expect(r.gaps[0]?.detail).toContain("derived");
    expect(r.gaps[0]?.detail).toContain("`payment-service`");
  });

  test("configured terms ONLY: a message matching only a derived term is absent", () => {
    db0 = db();
    at(OPEN, "payment-service is down", "1.000001");
    at(OPEN + 1000, "the checkout page 500s", "1.000002");
    const r = run(serviceConfig({ chatAliases: ["checkout"] }));
    expect(r.lane.messages).toHaveLength(1);
    expect(r.lane.messages[0]?.rule).toBe("chat_phrase:checkout");
    expect(r.lane.termsSource).toBe("configured");
    expect(r.gaps[0]?.detail).toContain("configured");
  });

  test("a term with FTS syntax characters is a literal phrase", () => {
    db0 = db();
    at(OPEN, 'He said "OR" * foo', "1.000001");
    const r = run(
      serviceConfig({ serviceId: 'x"y', chatAliases: ['"OR" *', "foo OR bar", "NOT"] }),
    );
    expect(r.lane.messages.map((m) => m.rule)).toEqual(['chat_phrase:"OR" *']);
  });

  test("merge and de-duplicate across terms, cap 50 with the true total", () => {
    db0 = db();
    for (let i = 0; i < 60; i += 1) {
      at(
        OPEN + i * 1000,
        `payment-service and payments-api #${String(i)}`,
        `${String(1000 + i)}.000001`,
      );
    }
    const r = run();
    expect(r.lane.total).toBe(60);
    expect(r.lane.messages).toHaveLength(50);
    expect(new Set(r.lane.messages.map((m) => m.id)).size).toBe(50);
    // first term wins the rule for a message both terms match
    expect(r.lane.messages[0]?.rule).toBe("chat_phrase:payment-service");
  });

  test("titles are single-lined and capped", () => {
    db0 = db();
    at(OPEN, `payment-service ${"x".repeat(400)}\nforged line`, "1.000001");
    const m = run().lane.messages[0];
    expect(m?.title).not.toContain("\n");
    expect(Array.from(m?.title ?? "").length).toBeLessThanOrEqual(200);
  });

  test("no chat connector synced is a connector gap, not an empty list", () => {
    db0 = createMemoryIndexDb();
    dbs.push(db0);
    const r = run();
    expect(r.lane.total).toBe(0);
    expect(r.gaps[0]?.category).toBe("missing_connector");
  });

  test("skippedChat carries the reason and searches nothing", () => {
    expect(skippedChat("unbound").lane).toMatchObject({
      skipped: "unbound",
      termsSource: "none",
      total: 0,
    });
  });
});
