/**
 * The four egress-ledger read routes, against a REAL HTTP server.
 *
 * Harness copied from clips/clip-e2e.test.ts: fresh temp dir, real SQLite DB at the current
 * schema version, an in-memory vault (a plain Map satisfies NimbusVault — no OS keychain), a real
 * PairingWindowController, and startReadOnlyHttpServer on port 0.
 *
 * Pairing directly through the controller is what makes the scope gate testable: `open(label,
 * scopes)` mints a token with exactly the scopes named, so a clip-only token and an egress-scoped
 * token can be compared against the same routes.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PairingWindowController } from "../clips/pairing-window.ts";
import { appendEgressEntry } from "../egress/egress-ledger.ts";
import type { EgressEntry } from "../egress/egress-record.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { ReadOnlyHttpServerHandle } from "./http-server.ts";
import { startReadOnlyHttpServer } from "./http-server.ts";

function makeInMemoryVault(): NimbusVault {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    listKeys: async (prefix?: string) => {
      const keys = [...store.keys()];
      return prefix === undefined ? keys : keys.filter((k) => k.startsWith(prefix));
    },
  };
}

function entry(over: Partial<EgressEntry> = {}): EgressEntry {
  return {
    timestamp: 100,
    sourceType: "sync",
    sourceId: null,
    destination: "github",
    method: "items.fetch",
    payloadSummary: "{}",
    hitlStatus: "not_required",
    resultStatus: "authorized",
    ...over,
  };
}

let tmpDir: string;
let dbPath: string;
let handle: ReadOnlyHttpServerHandle;
let vault: NimbusVault;
let pairing: PairingWindowController;
let base: string;
let egressToken: string;
let clipOnlyToken: string;

/** Mint a token carrying exactly `scopes`, through the real pairing flow. */
async function mint(label: string, scopes: string[]): Promise<string> {
  const { code } = pairing.open(label, scopes as never);
  const res = await fetch(`${base}/v1/clips/pair/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

function get(path: string, token?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

function ledgerRowCount(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "nimbus-egress-http-"));
  dbPath = join(tmpDir, "nimbus.db");
  const db = new Database(dbPath);
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  // Five chained rows, ids 1..5. Appended, never INSERTed: a raw insert leaves row_hash
  // unchained and GET /v1/egress/verify would then fail for an unrelated reason.
  for (let i = 1; i <= 5; i++) {
    appendEgressEntry(db, entry({ timestamp: i, method: `m.${i}` }));
  }
  db.close();

  vault = makeInMemoryVault();
  pairing = new PairingWindowController({ nowMs: () => Date.now() });
  handle = startReadOnlyHttpServer(dbPath, 0, { clipsVault: vault, pairingController: pairing });
  base = `http://127.0.0.1:${handle.port}`;

  egressToken = await mint("egress-browser", ["clip", "egress"]);
  clipOnlyToken = await mint("clip-only-browser", ["clip"]);
});

afterAll(() => {
  try {
    handle.stop();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("GET /v1/egress", () => {
  test("401 without a bearer token", async () => {
    expect((await get("/v1/egress")).status).toBe(401);
  });

  test("403 with a token lacking the egress scope, naming the gap", async () => {
    // The body must carry BOTH fields: the consumer builds a `nimbus clip scopes` command out of
    // them, and `--set` replaces the scope set, so it needs `granted` to avoid stripping scopes.
    const res = await get("/v1/egress", clipOnlyToken);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ required: "egress", granted: ["clip"] });
  });

  test("200 newest-first, carrying the window's counted totals", async () => {
    const res = await get("/v1/egress", egressToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { id: number }[];
      rowsTotal: number;
      rowsTruncated: boolean;
    };
    expect(body.rows.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
    expect(body.rowsTotal).toBe(5);
    expect(body.rowsTruncated).toBe(false);
  });

  test("rowsTotal counts the WHOLE window, not the page", async () => {
    // The reason totals are in the response at all: a consumer counting the page would
    // under-report, and with an ascending read would drop the newest rows while doing it.
    const res = await get("/v1/egress?limit=2", egressToken);
    const body = (await res.json()) as {
      rows: { id: number }[];
      rowsTotal: number;
      rowsTruncated: boolean;
    };
    expect(body.rows.map((r) => r.id)).toEqual([5, 4]);
    expect(body.rowsTotal).toBe(5);
    expect(body.rowsTruncated).toBe(true);
  });

  test("before pages backwards without gaps or repeats", async () => {
    const res = await get("/v1/egress?limit=2&before=4", egressToken);
    const body = (await res.json()) as { rows: { id: number }[] };
    expect(body.rows.map((r) => r.id)).toEqual([3, 2]);
  });

  test("an unparseable query value falls back to the default rather than 500ing", async () => {
    const res = await get("/v1/egress?limit=banana&before=-3", egressToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: { id: number }[] };
    expect(body.rows.map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
  });

  test("the route appends NO egress row", async () => {
    // A read that ledgered itself would inflate the very number it exists to report.
    const before = ledgerRowCount();
    await get("/v1/egress", egressToken);
    await get("/v1/egress/head", egressToken);
    await get("/v1/egress/verify", egressToken);
    await get("/v1/egress/prove", egressToken);
    expect(ledgerRowCount()).toBe(before);
  });
});

describe("the other three routes", () => {
  test("GET /v1/egress/head returns the head hash and count", async () => {
    const res = await get("/v1/egress/head", egressToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { head: string; count: number };
    expect(body.count).toBe(5);
    expect(body.head).toMatch(/^[0-9a-f]{64}$/);
  });

  test("GET /v1/egress/verify reports an intact chain", async () => {
    const res = await get("/v1/egress/verify", egressToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, verifiedRows: 5 });
  });

  test("GET /v1/egress/prove returns the signed window artifact", async () => {
    const res = await get("/v1/egress/prove", egressToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      digest: string;
      sigB64: string;
      pubkeyB64: string;
      rowsTotal: number;
      rowsTruncated: boolean;
    };
    expect(body.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.sigB64).toBe("string");
    expect(typeof body.pubkeyB64).toBe("string");
    expect(body.rowsTotal).toBe(5);
    expect(body.rowsTruncated).toBe(false);
  });

  test("all three enforce the same scope gate", async () => {
    for (const path of ["/v1/egress/head", "/v1/egress/verify", "/v1/egress/prove"]) {
      expect((await get(path)).status).toBe(401);
      expect((await get(path, clipOnlyToken)).status).toBe(403);
    }
  });
});

describe("prove is rate-limited, the plain reads are not", () => {
  test("a hot prove loop is refused; list keeps answering", async () => {
    // `prove` is the only one of the four that does asymmetric crypto per call — signWindowDigest
    // derives an Ed25519 keypair from the Vault share seed and signs. The other three are SQLite
    // reads. The budget is per-route and per-server-instance, matching how the write surface
    // fingerprints its routes (a constant per route kind, not per token), so this test runs
    // against its OWN server to get a clean bucket.
    const own = startReadOnlyHttpServer(dbPath, 0, {
      clipsVault: vault,
      pairingController: pairing,
    });
    try {
      const ownBase = `http://127.0.0.1:${own.port}`;
      const call = (path: string) =>
        fetch(`${ownBase}${path}`, { headers: { authorization: `Bearer ${egressToken}` } });

      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) {
        statuses.push((await call("/v1/egress/prove")).status);
      }
      expect(statuses[0]).toBe(200);
      expect(statuses).toContain(429);
      // A signing budget must not throttle a plain read.
      expect((await call("/v1/egress")).status).toBe(200);
    } finally {
      own.stop();
    }
  });
});

describe("the clips surface is unmounted", () => {
  test("404s with a named cause, never falling through to the public items table", async () => {
    // `dispatchReadOnlyDataGet`'s "/v1/items/*" entry is PUBLIC — no bearer gate at all. A
    // fall-through here would serve the record of everything this gateway ever sent to any local
    // process on the machine. This is the trap handleItemsResolve documents, one surface over.
    const bare = startReadOnlyHttpServer(dbPath, 0, {});
    try {
      const res = await fetch(`http://127.0.0.1:${bare.port}/v1/egress`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "egress_disabled" });
    } finally {
      bare.stop();
    }
  });
});
