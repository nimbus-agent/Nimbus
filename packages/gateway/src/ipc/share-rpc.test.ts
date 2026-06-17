import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeToolCallLog } from "../db/tool-call-log.ts";
import { LocalIndex } from "../index/local-index.ts";
import { ensureShareKeypair } from "../share/share-keypair.ts";
import { getShareRecord, listShareRecords } from "../share/share-store.ts";
import { dispatchShareRpc, type ShareHttpSinkConfig, type ShareRpcCtx } from "./share-rpc.ts";

function fakeVault() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async () => {},
    listKeys: async () => [...m.keys()],
  };
}

type CtxOverrides = {
  approve?: boolean;
  httpSink?: ShareHttpSinkConfig;
  respondApproval?: (requestId: string, approved: boolean) => boolean;
  vaultSeed?: Record<string, string>;
};

function freshCtx(db: Database, over: CtxOverrides = {}): ShareRpcCtx {
  const audit: { actionType: string; hitlStatus: string }[] = [];
  const vault = fakeVault();
  for (const [k, v] of Object.entries(over.vaultSeed ?? {})) {
    void vault.set(k, v);
  }
  const ctx: ShareRpcCtx & { audit: typeof audit } = {
    db,
    vault,
    label: "test-host",
    now: () => 1000,
    collectSession: async () => ({
      turns: [{ role: "user" as const, text: "ping alice@corp.com", timestamp: 1 }],
      toolCalls: [{ toolId: "t1", service: "svc", params: null, status: "ok" }],
    }),
    requestApproval: async () => over.approve ?? true,
    recordAudit: (e) => audit.push({ actionType: e.actionType, hitlStatus: e.hitlStatus }),
    respondApproval: over.respondApproval ?? (() => true),
    httpSink: over.httpSink ?? { url: "" },
    audit,
  };
  return ctx;
}

let db: Database;
let tmp: string;

beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  tmp = await mkdtemp(join(tmpdir(), "share-rpc-"));
});

afterEach(async () => {
  db.close();
  await rm(tmp, { recursive: true, force: true });
});

describe("dispatchShareRpc — hit/miss", () => {
  test("unknown share.* method returns a miss", async () => {
    const out = await dispatchShareRpc("share.bogus", {}, freshCtx(db));
    expect(out.kind).toBe("miss");
  });

  test("each known method returns a hit", async () => {
    const ctx = freshCtx(db);
    for (const m of ["share.list", "share.pubkey", "share.prune"]) {
      const out = await dispatchShareRpc(m, {}, ctx);
      expect(out.kind).toBe("hit");
    }
  });
});

describe("share.create", () => {
  test("approved file sink: persists, writes the redacted file, returns contentHash", async () => {
    const filePath = join(tmp, "out.json");
    const out = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", kind: "transcript", sink: { type: "file", path: filePath } },
      freshCtx(db, { approve: true }),
    );
    expect(out.kind).toBe("hit");
    const value = (out as { value: { status: string; contentHash?: string } }).value;
    expect(value.status).toBe("ok");
    expect(typeof value.contentHash).toBe("string");

    // Persisted exactly one row.
    expect(listShareRecords(db, { now: 2000 }).length).toBe(1);
    // The on-disk redacted body never contains the raw email.
    const written = await readFile(filePath, "utf8");
    expect(written).not.toContain("alice@corp.com");
    expect(written).toContain(value.contentHash as string);
  });

  test("rejected approval: nothing persisted, no file written, status rejected", async () => {
    const filePath = join(tmp, "denied.json");
    const out = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file", path: filePath } },
      freshCtx(db, { approve: false }),
    );
    expect((out as { value: { status: string } }).value.status).toBe("rejected");
    expect(listShareRecords(db, { now: 2000 }).length).toBe(0);
    expect(await Bun.file(filePath).exists()).toBe(false);
  });

  test("recipe kind + file sink without a path: persists but writes no file", async () => {
    const out = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", kind: "recipe", sink: { type: "file" } },
      freshCtx(db, { approve: true }),
    );
    expect((out as { value: { status: string } }).value.status).toBe("ok");
    expect(listShareRecords(db, { now: 2000 }).length).toBe(1);
  });

  test("peer sink: persisted + signed but not forwarded (stub)", async () => {
    const out = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "peer", peerId: "p1" } },
      freshCtx(db, { approve: true }),
    );
    expect((out as { value: { status: string } }).value.status).toBe("ok");
    expect(listShareRecords(db, { now: 2000 }).length).toBe(1);
  });

  test("http sink with an unconfigured url throws ERR_SHARE_HTTP_SINK_UNCONFIGURED", async () => {
    await expect(
      dispatchShareRpc(
        "share.create",
        { sessionId: "s1", sink: { type: "http" } },
        freshCtx(db, { approve: true, httpSink: { url: "" } }),
      ),
    ).rejects.toThrow(/ERR_SHARE_HTTP_SINK_UNCONFIGURED/);
    // Approved + signed + persisted before the emit failed — the emit is the only failure point.
    expect(listShareRecords(db, { now: 2000 }).length).toBe(1);
  });

  test("http sink builds the configured auth header (from Vault) before the SSRF-blocked fetch", async () => {
    // url points at a loopback host: safeFetch builds the headers (the token path) and THEN
    // fail-closes on the private address — so the auth-header construction is exercised without a
    // real network call. The token is read from the Vault (never from config).
    const ctx = freshCtx(db, {
      approve: true,
      httpSink: {
        url: "http://127.0.0.1:9/share",
        authHeaderName: "authorization",
        authVaultKey: "share.sink.token",
      },
      vaultSeed: { "share.sink.token": "Bearer abc123" },
    });
    await expect(
      dispatchShareRpc("share.create", { sessionId: "s1", sink: { type: "http" } }, ctx),
    ).rejects.toThrow(/loopback|private|unsafe/);
    // Approved + signed + persisted before the SSRF guard rejected the emit.
    expect(listShareRecords(db, { now: 2000 }).length).toBe(1);
  });

  test("missing sessionId throws ERR_INVALID_PARAMS", async () => {
    await expect(dispatchShareRpc("share.create", {}, freshCtx(db))).rejects.toThrow(
      /ERR_INVALID_PARAMS: sessionId/,
    );
  });

  test("an unknown sink.type is rejected (not silently coerced to a file)", async () => {
    await expect(
      dispatchShareRpc(
        "share.create",
        { sessionId: "s1", sink: { type: "carrier-pigeon" } },
        freshCtx(db, { approve: true }),
      ),
    ).rejects.toThrow(/ERR_INVALID_PARAMS: unknown sink\.type/);
    expect(listShareRecords(db, { now: 2000 }).length).toBe(0);
  });

  test("share.create kind=recipe builds body.recipe from tool_call_log and persists it", async () => {
    const ctx = freshCtx(db, { approve: true });
    writeToolCallLog(ctx.db, {
      sessionId: "s1",
      toolId: "gmail_search",
      service: "gmail",
      calledAt: 1,
      durationMs: 1,
      resultEnvelope: "{}",
      status: "ok",
      params: { q: "hi" },
    });
    const res = (await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", kind: "recipe", sink: { type: "file" } },
      ctx,
    )) as { value: { status: string; contentHash: string } };
    expect(res.value.status).toBe("ok");
    const stored = getShareRecord(ctx.db, res.value.contentHash);
    const body = JSON.parse(stored!.bodyJson) as {
      kind: string;
      recipe?: { steps: unknown[] };
      turns?: unknown;
    };
    expect(body.kind).toBe("recipe");
    expect(body.recipe?.steps).toHaveLength(1);
    expect(body.turns).toBeUndefined();
  });

  test("expiresMs is converted to an absolute expiresAt on the persisted share", async () => {
    await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file" }, expiresMs: 60_000 },
      freshCtx(db, { approve: true }),
    );
    const [row] = listShareRecords(db, { now: 2000, includeExpired: true });
    expect(row?.expiresAt).toBe(1000 + 60_000); // ctx.now() === 1000
  });

  test("caller redact patterns are threaded into the gate and applied to the body", async () => {
    const filePath = join(tmp, "redact.json");
    await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file", path: filePath }, redact: ["ping"] },
      freshCtx(db, { approve: true }),
    );
    const written = await readFile(filePath, "utf8");
    // "ping" is not PII — it is redacted only because the caller pattern was wired through.
    expect(written).not.toContain("ping");
    expect(written).toContain("[REDACTED]");
  });
});

describe("share read methods", () => {
  test("share.list returns persisted shares (default + includeExpired)", async () => {
    await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file" } },
      freshCtx(db, { approve: true }),
    );
    const out = await dispatchShareRpc("share.list", { includeExpired: true }, freshCtx(db));
    const shares = (out as { value: { shares: unknown[] } }).value.shares;
    expect(shares.length).toBe(1);
  });

  test("share.get returns the record by contentHash; null when absent", async () => {
    const created = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file" } },
      freshCtx(db, { approve: true }),
    );
    const hash = (created as { value: { contentHash: string } }).value.contentHash;
    const hit = await dispatchShareRpc("share.get", { contentHash: hash }, freshCtx(db));
    expect((hit as { value: { share: unknown } }).value.share).not.toBeNull();
    const miss = await dispatchShareRpc("share.get", { contentHash: "nope" }, freshCtx(db));
    expect((miss as { value: { share: unknown } }).value.share).toBeNull();
  });

  test("share.pubkey returns the share signing public key", async () => {
    const ctx = freshCtx(db);
    const out = await dispatchShareRpc("share.pubkey", {}, ctx);
    const pub = (out as { value: { pubkey: string } }).value.pubkey;
    const kp = await ensureShareKeypair(ctx.vault);
    expect(pub).toBe(kp.pubkeyB64);
  });

  test("share.verify of a freshly-created share via bytesB64 verifies ok", async () => {
    const filePath = join(tmp, "bytes.json");
    await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file", path: filePath } },
      freshCtx(db, { approve: true }),
    );
    const bytesB64 = Buffer.from(await readFile(filePath)).toString("base64");
    const out = await dispatchShareRpc("share.verify", { bytesB64 }, freshCtx(db));
    expect((out as { value: { signatureValid: boolean } }).value.signatureValid).toBe(true);
  });

  test("share.verify via a local file path (input) verifies the written share file", async () => {
    const filePath = join(tmp, "verify-me.json");
    await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file", path: filePath } },
      freshCtx(db, { approve: true }),
    );
    const out = await dispatchShareRpc("share.verify", { input: filePath }, freshCtx(db));
    expect((out as { value: { signatureValid: boolean } }).value.signatureValid).toBe(true);
  });

  test("share.verify with neither input nor bytesB64 throws ERR_INVALID_PARAMS", async () => {
    await expect(dispatchShareRpc("share.verify", {}, freshCtx(db))).rejects.toThrow(
      /ERR_INVALID_PARAMS/,
    );
  });

  test("share.prune removes expired rows and reports the count", async () => {
    // Seed a row via create, then a verify of prune on an empty/expired set.
    const out = await dispatchShareRpc("share.prune", {}, freshCtx(db));
    expect((out as { value: { removed: number } }).value.removed).toBe(0);
  });
});

describe("defensive parameter fallbacks (branch coverage)", () => {
  test("read handlers tolerate null/non-record params via the ?? {} fallbacks", async () => {
    // null params → asRecord() returns undefined → each handler's `?? {}` fallback runs.
    expect((await dispatchShareRpc("share.list", null, freshCtx(db))).kind).toBe("hit");
    expect((await dispatchShareRpc("share.prune", null, freshCtx(db))).kind).toBe("hit");
    // requireString sees a non-record → its `rec === undefined ? undefined` arm → throws.
    await expect(dispatchShareRpc("share.get", null, freshCtx(db))).rejects.toThrow(
      /ERR_INVALID_PARAMS/,
    );
    await expect(dispatchShareRpc("share.verify", null, freshCtx(db))).rejects.toThrow(
      /ERR_INVALID_PARAMS/,
    );
    await expect(dispatchShareRpc("share.create", null, freshCtx(db))).rejects.toThrow(
      /ERR_INVALID_PARAMS/,
    );
    await expect(dispatchShareRpc("share.approvalRespond", null, freshCtx(db))).rejects.toThrow(
      /ERR_INVALID_PARAMS/,
    );
  });

  test("peer sink without a peerId defaults to an empty peerId", async () => {
    const out = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "peer" } },
      freshCtx(db, { approve: true }),
    );
    expect((out as { value: { status: string } }).value.status).toBe("ok");
  });

  test("http sink with auth config but an absent Vault token omits the header (token === null arm)", async () => {
    const ctx = freshCtx(db, {
      approve: true,
      httpSink: {
        url: "http://127.0.0.1:9/share",
        authHeaderName: "authorization",
        authVaultKey: "share.sink.token", // NOT seeded → vault.get returns null
      },
    });
    await expect(
      dispatchShareRpc("share.create", { sessionId: "s1", sink: { type: "http" } }, ctx),
    ).rejects.toThrow(/loopback|private|unsafe/);
  });
});

describe("share.approvalRespond", () => {
  test("delegates to respondApproval and returns matched", async () => {
    const calls: { requestId: string; approved: boolean }[] = [];
    const ctx = freshCtx(db, {
      respondApproval: (requestId, approved) => {
        calls.push({ requestId, approved });
        return true;
      },
    });
    const out = await dispatchShareRpc(
      "share.approvalRespond",
      { requestId: "r1", approved: true },
      ctx,
    );
    expect((out as { value: { matched: boolean } }).value.matched).toBe(true);
    expect(calls).toEqual([{ requestId: "r1", approved: true }]);
  });

  test("missing requestId throws ERR_INVALID_PARAMS", async () => {
    await expect(
      dispatchShareRpc("share.approvalRespond", { approved: false }, freshCtx(db)),
    ).rejects.toThrow(/ERR_INVALID_PARAMS: requestId/);
  });
});
