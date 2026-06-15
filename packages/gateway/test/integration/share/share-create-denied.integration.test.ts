/**
 * Phase 6 Slice 8 — Share & Virality production-path HITL authenticity proof (integration layer).
 *
 * This is the closing test for review finding "hitl-authenticity-2": the share.publish HITL entry is
 * inert unless something wires `createShare`'s `requestApproval` to the REAL fail-closed owner
 * consent broker. Here we drive the production `dispatchShareRpc("share.create", …)` path against a
 * real SQLite DB + the real Blake3 audit chain (`appendAuditEntry`), with `requestApproval` bound to
 * a REAL `ShareConsentBroker` (not the prod singleton).
 *
 * The owner answer is driven SYNCHRONOUSLY through the broker's broadcast callback (respond on the
 * next microtask after the request is registered) — deny in the first test, approve in the second.
 * This proves the production routing fail-closes on a deny without relying on an AWAITED `setTimeout`
 * TTL firing, which hangs `bun test` on the Windows leg (see the project's
 * bun-test-unref-timer-hang / windows-buntest-macrotask-timer-hang notes; the broker's own internal
 * TTL safety-net is unit-tested elsewhere). We assert that a denied approval:
 *   (1) returns `{ status: "rejected" }`,
 *   (2) persists + signs NOTHING (no share_records row),
 *   (3) emits exactly one `share.publish` audit row with hitl_status "rejected" and zero "approved",
 *   (4) writes no file at the chosen file-sink path.
 * The complementary approved-path assertion proves the SAME ctx persists + signs + writes the
 * redacted body (no raw email) + returns a contentHash when the broker is answered with approve.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry } from "../../../src/db/audit-chain.ts";
import { verifyAuditChain } from "../../../src/db/audit-verify.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { dispatchShareRpc, type ShareRpcCtx } from "../../../src/ipc/share-rpc.ts";
import { ShareConsentBroker } from "../../../src/share/share-consent-broker.ts";
import { getShareRecord, listShareRecords } from "../../../src/share/share-store.ts";

/** Verify the Blake3 audit chain from genesis over the raw test DB (thin LocalIndex view — only rawDb is read). */
function auditChainOk(database: Database): boolean {
  return verifyAuditChain({ rawDb: database } as unknown as LocalIndex, { fromId: 0 }).ok;
}

function fakeVault() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async () => {},
    listKeys: async () => [...m.keys()],
  };
}

let db: Database;
let tmp: string;

beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  tmp = await mkdtemp(join(tmpdir(), "share-int-"));
});

afterEach(async () => {
  db.close();
  await rm(tmp, { recursive: true, force: true });
});

/**
 * Build the production ShareRpcCtx, binding requestApproval to a FRESH real ShareConsentBroker. The
 * owner answers `opts.answer` synchronously via the broadcast callback (next microtask, after the
 * request promise is registered + the timer cleared on respond) — a large TTL is used only as the
 * never-reached safety net, so no awaited timer fires.
 */
function buildCtx(opts: { answer: boolean }): { ctx: ShareRpcCtx; broker: ShareConsentBroker } {
  const broker = new ShareConsentBroker();
  broker.setBroadcast((_method, params) => {
    const requestId = (params as { requestId?: string }).requestId;
    if (requestId !== undefined) {
      queueMicrotask(() => broker.respond(requestId, opts.answer));
    }
  });
  const ctx: ShareRpcCtx = {
    db,
    vault: fakeVault(),
    label: "int-host",
    now: () => 1000,
    collectSession: async () => ({
      turns: [{ role: "user" as const, text: "leak alice@corp.com please", timestamp: 1 }],
      toolCalls: [],
    }),
    requestApproval: (sessionId, kind, sink, preview, redactionSet) =>
      broker.request({ sessionId, kind, preview, redactionSet, sink }, 60_000),
    recordAudit: (entry) => appendAuditEntry(db, entry),
    respondApproval: (requestId, approved) => broker.respond(requestId, approved),
    httpSink: { url: "" },
  };
  return { ctx, broker };
}

function auditCount(status: string): number {
  return (
    db
      .query(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'share.publish' AND hitl_status = ?",
      )
      .get(status) as { n: number }
  ).n;
}

test("denied approval (real broker) persists + signs nothing and writes no file — fail-closed", async () => {
  const filePath = join(tmp, "should-not-exist.json");
  const { ctx } = buildCtx({ answer: false }); // owner denies through the real broker

  const out = await dispatchShareRpc(
    "share.create",
    { sessionId: "s1", kind: "transcript", sink: { type: "file", path: filePath } },
    ctx,
  );

  // (1) the RPC reports rejected.
  expect((out as { value: { status: string } }).value.status).toBe("rejected");

  // (2) nothing persisted / signed — no share_records row at all.
  expect(listShareRecords(db, { now: 2000, includeExpired: true })).toHaveLength(0);
  expect(getShareRecord(db, "any-hash")).toBeUndefined();

  // (3) exactly one share.publish audit row, hitl_status rejected, zero approved.
  expect(auditCount("rejected")).toBe(1);
  expect(auditCount("approved")).toBe(0);
  // The audit chain is intact (the rejected row hashes onto genesis).
  expect(auditChainOk(db)).toBe(true);

  // (4) no file was written (the Bun.write is skipped on a non-ok result).
  expect(await Bun.file(filePath).exists()).toBe(false);
});

test("approved approval (real broker) persists + signs the redacted body and writes the file", async () => {
  const filePath = join(tmp, "approved.json");
  const { ctx } = buildCtx({ answer: true });

  const out = await dispatchShareRpc(
    "share.create",
    { sessionId: "s1", kind: "transcript", sink: { type: "file", path: filePath } },
    ctx,
  );

  const value = (out as { value: { status: string; contentHash?: string } }).value;
  expect(value.status).toBe("ok");
  expect(typeof value.contentHash).toBe("string");

  // Persisted exactly one signed record.
  const records = listShareRecords(db, { now: 2000 });
  expect(records).toHaveLength(1);
  expect(getShareRecord(db, value.contentHash as string)).toBeDefined();

  // Audit: one approved row, zero rejected; chain intact.
  expect(auditCount("approved")).toBe(1);
  expect(auditCount("rejected")).toBe(0);
  expect(auditChainOk(db)).toBe(true);

  // The written file is the REDACTED body — the raw email never reaches disk.
  const written = await Bun.file(filePath).text();
  expect(written).not.toContain("alice@corp.com");
  expect(written).toContain(value.contentHash as string);
});
