import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { dispatchIndexRegraphRpc, IndexRegraphRpcError } from "./index-regraph-rpc.ts";

const silentLogger = pino({ level: "silent" });

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** Insert an item directly, bypassing the populator, to simulate pre-existing data.
 * Copied verbatim from `graph/regraph.test.ts` — test files cannot import each
 * other's helpers. */
function insertRawItem(
  db: Database,
  o: { service: string; type: string; externalId: string; title: string; body: string; at: number },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      `${o.service}:${o.externalId}`,
      o.service,
      o.type,
      o.externalId,
      o.title,
      o.body,
      o.at,
      o.at,
      JSON.stringify({ repo: "acme/app" }),
    ],
  );
}

function correlationEdgeCount(db: Database): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'correlates_with'").get() as {
      n: number;
    }
  ).n;
}

// Copied verbatim from `graph/regraph.test.ts` (C-1 fixture) — test files
// cannot import each other's helpers.
const CHECKOUT_SERVICE_CONFIG: ServiceConfig = {
  serviceId: "checkout",
  repos: [{ provider: "github", providerId: "acme/checkout" }],
  pagerdutyServices: ["PSVC1"],
  deployWorkflowPattern: /^Deploy/,
  incidentWindowMinutes: 60,
  excludePrLabels: [],
  deployEnvironments: ["prod"],
  severityP1Aliases: ["P1"],
};

/** Seed a PagerDuty incident + a deployment whose only shared service identity
 * is the `resolveServiceId` binding — neither carries a plain `metadata.service`.
 * Copied verbatim from `graph/regraph.test.ts`. */
function seedResolverBoundIncidentAndDeploy(
  db: Database,
  now: number,
  resolveServiceId: ReturnType<typeof buildServiceIdentityResolver>,
): void {
  upsertIndexedItem(
    db,
    {
      service: "pagerduty",
      type: "incident",
      externalId: "PD-1",
      title: "Checkout 500s",
      bodyPreview: "",
      modifiedAt: now + 60 * 60 * 1000,
      syncedAt: now + 60 * 60 * 1000,
      metadata: { pagerduty_service_id: "PSVC1" },
    },
    resolveServiceId,
  );
  upsertIndexedItem(
    db,
    {
      service: "github",
      type: "deployment",
      externalId: "deploy-9",
      title: "Deploy checkout v2",
      bodyPreview: "",
      modifiedAt: now,
      syncedAt: now,
      metadata: { repo: "acme/checkout", target: "production" },
    },
    resolveServiceId,
  );
}

describe("dispatchIndexRegraphRpc", () => {
  test("case 1: regraphs a raw-seeded PR/issue pair and emits a resolves edge", async () => {
    const db = freshDb();
    const now = Date.now();
    insertRawItem(db, {
      service: "github",
      type: "issue",
      externalId: "acme/app#4",
      title: "Login broken",
      body: "",
      at: now,
    });
    insertRawItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Fix login",
      body: "closes #4",
      at: now,
    });

    const out = await dispatchIndexRegraphRpc("index.regraph", null, { db, logger: silentLogger });
    expect(out).toEqual({ kind: "hit", value: { scanned: 2, graphed: 2, skipped: 0 } });

    expect(
      (
        db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  test("case 2: THE RESOLVER TRAP — with configDir the correlates_with edge survives; without it, it is destroyed", async () => {
    // --- with configDir: edge count unchanged ---
    const withDb = freshDb();
    const now = Date.now();
    const seedResolver = buildServiceIdentityResolver(
      new Map([["checkout", CHECKOUT_SERVICE_CONFIG]]),
    );
    seedResolverBoundIncidentAndDeploy(withDb, now, seedResolver);
    expect(correlationEdgeCount(withDb)).toBe(1);

    const configDir = mkdtempSync(join(tmpdir(), "nimbus-regraph-rpc-"));
    writeFileSync(
      join(configDir, "nimbus.toml"),
      `[ci.service.checkout]
repos = ["github:acme/checkout"]
pagerduty_services = ["PSVC1"]
`,
      "utf8",
    );

    const withOut = await dispatchIndexRegraphRpc("index.regraph", null, {
      db: withDb,
      configDir,
      logger: silentLogger,
    });
    expect(withOut).toEqual({ kind: "hit", value: { scanned: 2, graphed: 2, skipped: 0 } });
    // The resolver is threaded through: the edge is preserved, not cleared.
    expect(correlationEdgeCount(withDb)).toBe(1);

    // --- without configDir: edge count drops, proving the resolver is what
    // preserved it above ---
    const withoutDb = freshDb();
    seedResolverBoundIncidentAndDeploy(withoutDb, now, seedResolver);
    expect(correlationEdgeCount(withoutDb)).toBe(1);

    const withoutOut = await dispatchIndexRegraphRpc("index.regraph", null, {
      db: withoutDb,
      logger: silentLogger,
    });
    expect(withoutOut).toEqual({ kind: "hit", value: { scanned: 2, graphed: 2, skipped: 0 } });
    expect(correlationEdgeCount(withoutDb)).toBe(0);
  });

  test("case 3: unexpected params rejects with -32602", async () => {
    const db = freshDb();
    await expect(
      dispatchIndexRegraphRpc("index.regraph", { unexpected: 1 }, { db, logger: silentLogger }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
    await expect(
      dispatchIndexRegraphRpc("index.regraph", { unexpected: 1 }, { db, logger: silentLogger }),
    ).rejects.toBeInstanceOf(IndexRegraphRpcError);
  });

  test("case 4: unknown method returns a miss", async () => {
    const db = freshDb();
    const out = await dispatchIndexRegraphRpc("index.bogus", null, { db, logger: silentLogger });
    expect(out).toEqual({ kind: "miss" });
  });
});
