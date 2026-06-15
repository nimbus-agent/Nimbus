import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { createShare } from "./share-gate.ts";

function fakeVault() {
  const m = new Map<string, string>();
  return {
    get: async (k: string) => m.get(k) ?? null,
    set: async (k: string, v: string) => void m.set(k, v),
    delete: async () => {},
    listKeys: async () => [...m.keys()],
  };
}
const audit: { actionType: string; hitlStatus: string }[] = [];
function deps(approve: boolean, db: Database) {
  return {
    db,
    vault: fakeVault(),
    label: "Asaf",
    now: () => 1000,
    collectSession: () => ({
      turns: [{ role: "user" as const, text: "ping alice@corp.com", timestamp: 1 }],
      toolCalls: [],
    }),
    requestApproval: async () => approve,
    recordAudit: (e: { actionType: string; hitlStatus: string }) => audit.push(e),
  };
}

describe("createShare (I27 gate)", () => {
  test("rejected approval => no file, audit records rejected, nothing persisted", async () => {
    audit.length = 0;
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const r = await createShare(
      { sessionId: "s1", kind: "transcript", sink: { type: "file" } },
      deps(false, db),
    );
    expect(r.status).toBe("rejected");
    expect(audit.at(-1)).toMatchObject({ actionType: "share.publish", hitlStatus: "rejected" });
    expect(db.query("SELECT COUNT(*) AS c FROM share_records").get()).toMatchObject({ c: 0 });
  });
  test("approved => redacted+signed share returned, persisted, audit approved", async () => {
    audit.length = 0;
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const r = await createShare(
      { sessionId: "s1", kind: "transcript", sink: { type: "file" } },
      deps(true, db),
    );
    expect(r.status).toBe("ok");
    expect(JSON.stringify(r.share)).not.toContain("alice@corp.com");
    expect(r.share?.body.redactionSet).toContain("emails");
    expect(audit.at(-1)).toMatchObject({ actionType: "share.publish", hitlStatus: "approved" });
    expect(db.query("SELECT COUNT(*) AS c FROM share_records").get()).toMatchObject({ c: 1 });
  });
});
