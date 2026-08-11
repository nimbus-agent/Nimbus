import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PremortemBrief } from "../agents/_lib/premortem-types.ts";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { seedEpicWithServices } from "../premortem/cohort.test-helpers.ts";
import { dispatchAgentsRpc } from "./agents-rpc.ts";

const DAY_MS = 86_400_000;
const NOW = Date.now();

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function makeCtx(db: Database, extras?: { configDir?: string }) {
  return { db, notify: () => {}, ...extras };
}

/** A target-epic-only seed: a Jira Epic item with no children — enough to resolve, not enough to cohort. */
function seedChildlessEpic(db: Database, key: string): void {
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: key,
    title: `${key} title`,
    metadata: { issue_type: "Epic", status_category: "in_progress" },
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
  });
}

describe("dispatchAgentsRpc — agents.premortem param validation", () => {
  test("rejects a missing epicRef", async () => {
    await expect(
      dispatchAgentsRpc("agents.premortem", {}, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602, message: expect.stringContaining("epicRef") });
  });

  test("rejects a non-string epicRef", async () => {
    await expect(
      dispatchAgentsRpc("agents.premortem", { epicRef: 5 }, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects an empty epicRef after trim", async () => {
    await expect(
      dispatchAgentsRpc("agents.premortem", { epicRef: "   " }, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects params that are not an object", async () => {
    await expect(
      dispatchAgentsRpc("agents.premortem", "PROJ-1", makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      dispatchAgentsRpc("agents.premortem", ["PROJ-1"], makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      dispatchAgentsRpc("agents.premortem", null, makeCtx(freshDb())),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects a non-array services", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: "billing" },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602, message: expect.stringContaining("services") });
  });

  test("rejects a non-string element inside services", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: ["billing", 5] },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects an empty-after-trim service entry", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: ["   "] },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects an over-length service entry", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: ["s".repeat(65)] },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("rejects an over-long services array", async () => {
    // Each accepted entry becomes a watcher row plus a tombstone, and this method is
    // renderer-callable — the per-entry length bound alone leaves the write unbounded.
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", services: Array.from({ length: 33 }, (_v, i) => `svc-${String(i)}`) },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602, message: expect.stringContaining("at most 32") });
  });

  test("accepts exactly the cap", async () => {
    const db = freshDb();
    seedChildlessEpic(db, "PROJ-CAP");
    const out = await dispatchAgentsRpc(
      "agents.premortem",
      {
        epicRef: "PROJ-CAP",
        services: Array.from({ length: 32 }, (_v, i) => `svc-${String(i)}`),
      },
      makeCtx(db),
    );
    expect(out.kind).toBe("hit");
  });

  test("rejects a non-boolean repropose", async () => {
    await expect(
      dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "PROJ-1", repropose: "yes" },
        makeCtx(freshDb()),
      ),
    ).rejects.toMatchObject({ rpcCode: -32602, message: expect.stringContaining("repropose") });
  });
});

describe("dispatchAgentsRpc — agents.premortem happy paths", () => {
  test("resolves a bare epic key and returns a premortem-prefixed sessionId", async () => {
    const db = freshDb();
    seedChildlessEpic(db, "PROJ-1");
    const out = await dispatchAgentsRpc("agents.premortem", { epicRef: "PROJ-1" }, makeCtx(db));
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") {
      const v = out.value as { sessionId: string };
      expect(v.sessionId).toMatch(/^premortem/);
    }
  });

  test("accepts a jira: prefixed ref, repeatable services, and repropose together", async () => {
    const db = freshDb();
    seedChildlessEpic(db, "PROJ-2");
    const out = await dispatchAgentsRpc(
      "agents.premortem",
      { epicRef: "jira:PROJ-2", services: ["acme/billing", "acme/checkout"], repropose: true },
      makeCtx(db),
    );
    expect(out.kind).toBe("hit");
  });

  test("an unrelated method still misses so the next dispatcher can claim it", async () => {
    const out = await dispatchAgentsRpc("premortem.refresh", null, makeCtx(freshDb()));
    expect(out.kind).toBe("miss");
  });

  test("with no configDir, resolveServiceId is left unset (no throw; incident coupling degrades to a gap)", async () => {
    const db = freshDb();
    seedChildlessEpic(db, "PROJ-3");
    const out = await dispatchAgentsRpc("agents.premortem", { epicRef: "PROJ-3" }, makeCtx(db));
    expect(out.kind).toBe("hit");
  });

  // Exercises `premortemResolveServiceId`'s configDir-set branch, mirroring
  // `ipc/index-regraph-rpc.ts`'s construction of the same resolver.
  //
  // Asserts on the DELIVERED BRIEF, not on `out.kind === "hit"`. An earlier version of this test
  // claimed to prove "the real wiring survives" while asserting only that the dispatch hit —
  // deleting the entire `resolveServiceId` thread-through left it green, because a premortem with
  // no resolver hits just as happily. The incident-coupling risk is the one observable that can
  // only be produced BY the resolver: without it the summary says "cannot be measured".
  test("with a configDir carrying [ci.service.*], the delivered brief reports a MEASURED incident-coupling rate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-premortem-rpc-"));
    writeFileSync(
      join(dir, "nimbus.toml"),
      '[ci.service.billing]\nrepos = ["github:acme/billing"]\n',
      "utf8",
    );
    const db = freshDb();
    // The DORA config id (`billing`) is deliberately NOT the repo path (`acme/billing`), so a
    // same-string coincidence cannot stand in for the translation.
    seedEpicWithServices(db, {
      key: "PROJ-5",
      services: ["acme/billing"],
      resolvedAtMs: NOW - 5 * DAY_MS,
      createdAtMs: NOW - 15 * DAY_MS,
    });
    seedEpicWithServices(db, {
      key: "HIST-5",
      services: ["acme/billing"],
      resolvedAtMs: NOW - 40 * DAY_MS,
      createdAtMs: NOW - 70 * DAY_MS,
    });
    const depEnt = upsertGraphEntity(db, {
      type: "deployment",
      externalId: "deploy:rpc-1",
      label: "deploy rpc-1",
      service: "github-actions",
      metadata: { occurredAt: NOW - 65 * DAY_MS, affectedService: "billing" },
    });
    const incEnt = upsertGraphEntity(db, {
      type: "incident",
      externalId: "incident:rpc-1",
      label: "incident rpc-1",
      service: "pagerduty",
      metadata: { occurredAt: NOW - 65 * DAY_MS + 1_000, affectedService: "billing" },
    });
    upsertGraphRelation(db, depEnt, incEnt, "correlates_with", NOW - 65 * DAY_MS);

    const notifications: Array<{ method: string; params: unknown }> = [];
    const out = await dispatchAgentsRpc(
      "agents.premortem",
      { epicRef: "PROJ-5" },
      {
        db,
        notify: (method: string, params: unknown) => notifications.push({ method, params }),
        configDir: dir,
      },
    );
    expect(out.kind).toBe("hit");
    // `emitBriefWithSynthesis` builds fire-and-forget; give the queue a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ready = notifications.find((n) => n.method === "premortem.briefReady");
    if (ready === undefined) {
      throw new Error(
        `premortem.briefReady was never emitted; got ${notifications.map((n) => n.method).join(", ") || "nothing"}`,
      );
    }
    const findings = (ready.params as { findings: PremortemBrief }).findings;
    const coupling = findings.risks.find((r) => r.kind === "incident_coupling");
    expect(coupling?.summary).toContain("1 of 1 comparable epics (100%)");
    expect(coupling?.value).toBe(1);
  });
});
