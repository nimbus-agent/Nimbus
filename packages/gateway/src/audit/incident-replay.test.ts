import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { appendEgressEntry } from "../egress/egress-ledger.ts";
import { pruneEgress } from "../egress/egress-prune.ts";
import { buildRecord } from "../incident/__fixtures__/record-builder.ts";
import { upsertIncidentRecord } from "../incident/incident-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { canonicalJson } from "../util/canonical-json.ts";
import {
  chainVerifiers,
  REPLAY_PROMPT_NOTE,
  REPLAY_PROPOSALS_NOTE,
  replayIncident,
} from "./incident-replay.ts";

let db: Database;
let recordId = "";
const SHA = "b".repeat(64);
const idx = (): LocalIndex => ({ rawDb: db }) as unknown as LocalIndex;
const verify = (): ReturnType<typeof chainVerifiers> => chainVerifiers(idx());

beforeEach(() => {
  db = createMemoryIndexDb();
  const record = buildRecord({ boundService: "payments" });
  const r1 = upsertIncidentRecord(db, {
    record,
    markdown: "# one",
    recordSha256: "s1",
    citedServices: ["pagerduty"],
    nowMs: 1_000,
  });
  recordId = r1.recordId;
  upsertIncidentRecord(db, {
    record: { ...record, trigger: { ...record.trigger, severity: "p2" } },
    markdown: "# two",
    recordSha256: "s2",
    citedServices: ["pagerduty"],
    nowMs: 2_000,
  });
});
afterEach(() => db.close());

const head = (version: number, id = recordId): string =>
  `{"incident":{"id":"${id}","version":${String(version)}}`;

function linkedJson(
  version: number,
  over: { prompt?: string; cut?: boolean; confirm?: string; type?: string; sub?: boolean } = {},
): string {
  const prompt =
    over.prompt === undefined
      ? ""
      : `,"promptSha256":"${SHA}","prompt":${JSON.stringify(over.prompt)}${over.cut === true ? ',"promptCut":true' : ""}`;
  return `${head(version)}${over.sub === true ? ',"subStep":true' : ""}${prompt},"action":{"type":"${over.type ?? "email.send"}"},"answerSource":"human"${over.confirm === undefined ? "" : `,"confirm":"${over.confirm}"`}}`;
}

type Written = { auditId: number; egressId: number };

/** Append one audit row and its egress row at one instant, as the executor does. */
function write(
  at: number,
  type: string,
  hitl: "approved" | "rejected" | "not_required",
  json: string,
  summary: string = json.slice(0, 80),
): Written {
  appendAuditEntry(db, { actionType: type, hitlStatus: hitl, actionJson: json, timestamp: at });
  const auditId = (db.query("SELECT max(id) AS m FROM audit_log").get() as { m: number }).m;
  appendEgressEntry(db, {
    timestamp: at,
    sourceType: "task",
    sourceId: null,
    destination: type.split(".")[0] ?? type,
    method: type,
    payloadSummary: summary,
    hitlStatus: hitl,
    resultStatus: hitl === "rejected" ? "blocked" : "authorized",
  });
  const egressId = (db.query("SELECT max(id) AS m FROM egress_ledger").get() as { m: number }).m;
  return { auditId, egressId };
}

const unlinked = (at: number): Written =>
  write(at, "search.run", "not_required", '{"action":{"type":"search.run"}}');

describe("10.3 the record versions and the linked actions", () => {
  test("record versions with changed-key lists; actions grouped with their sub-steps; the prompt escaped, with the note", () => {
    unlinked(10);
    write(20, "jira.before.read", "not_required", linkedJson(2, { sub: true }));
    const a = write(
      20,
      "email.send",
      "approved",
      linkedJson(2, {
        prompt: "Action requires your approval\n\nType: email.send",
        confirm: "matched",
      }),
    );
    unlinked(30);
    const b = write(
      40,
      "slack.message.post",
      "rejected",
      linkedJson(1, { prompt: "p2", cut: true }),
    );
    const r = replayIncident(db, recordId, verify());

    expect(r.record.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(r.record.versions[0]?.changedKeys).toContain("trigger");
    expect(r.record.versions[1]?.changedKeys).toEqual(["trigger"]);
    expect(r.record.currentVersion).toBe(2);

    expect(r.actions.map((x) => x.auditId)).toEqual([a.auditId, b.auditId]);
    const first = r.actions[0];
    expect(first?.subSteps.map((s) => s.actionType)).toEqual(["jira.before.read"]);
    expect(first?.prompt).toEqual({
      text: "Action requires your approval\n\nType: email.send",
      cut: false,
      sha256: SHA,
      redactedInStored: false,
    });
    expect(first?.confirm).toBe("matched");
    expect(first?.answerSource).toBe("human");
    expect(first?.egress).toMatchObject({
      id: a.egressId,
      resultStatus: "authorized",
      paired: "paired",
    });
    const second = r.actions[1];
    expect(second?.hitlStatus).toBe("rejected");
    expect(second?.prompt?.cut).toBe(true);
    expect(second?.egress).toMatchObject({ resultStatus: "blocked", statusDiffers: false });
    expect(r.notes).toContain(REPLAY_PROMPT_NOTE);
    expect(r.proposals).toEqual({ items: [], note: REPLAY_PROPOSALS_NOTE });
    expect(r.ok).toBe(true);
  });

  test("--json style: the full stored record of each version only when asked for", () => {
    expect(replayIncident(db, recordId, verify()).record.versions[0]).not.toHaveProperty("record");
    const full = replayIncident(db, recordId, verify(), { includeRecords: true });
    expect(full.record.versions[0]).toHaveProperty("record");
  });

  test("a prompt whose stored text was redacted is flagged, and the hash is never claimed to match it", () => {
    write(20, "email.send", "approved", linkedJson(2, { prompt: "token [REDACTED] here" }));
    const r = replayIncident(db, recordId, verify());
    expect(r.actions[0]?.prompt?.redactedInStored).toBe(true);
  });

  test("a link naming a version the record does not have is listed unknown_version; an unknown record is an error", () => {
    write(20, "email.send", "approved", linkedJson(9));
    expect(replayIncident(db, recordId, verify()).actions[0]?.unknownVersion).toBe(true);
    expect(() => replayIncident(db, "inc_ffffffffffffffff", verify())).toThrow(
      /no incident record/,
    );
  });
});

describe("10.4 egress pairing by order within (timestamp, method)", () => {
  test("two same-type rows in one millisecond pair in order", () => {
    const a = write(50, "jira.before.read", "not_required", linkedJson(2, { sub: true }));
    const b = write(50, "jira.before.read", "not_required", linkedJson(2, { sub: true }));
    const c = write(60, "email.send", "approved", linkedJson(2));
    const r = replayIncident(db, recordId, verify());
    const reads = r.actions[0]?.subSteps ?? [];
    expect(reads.map((s) => s.egress?.id)).toEqual([a.egressId, b.egressId]);
    expect(r.actions[0]?.egress?.id).toBe(c.egressId);
    expect(reads.every((s) => s.egress?.paired === "paired")).toBe(true);
  });

  test("an unrelated same-type egress row in the same millisecond makes the pair ambiguous, never hidden", () => {
    const a = write(50, "email.send", "approved", linkedJson(2));
    // another action of the same type at the same instant, not linked
    appendEgressEntry(db, {
      timestamp: 50,
      sourceType: "task",
      sourceId: null,
      destination: "email",
      method: "email.send",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    const r = replayIncident(db, recordId, verify());
    expect(r.actions[0]?.egress).toMatchObject({ id: a.egressId, paired: "ambiguous" });
  });

  test("an UNLINKED pair before the linked one in the same millisecond does not take the linked action's egress row", () => {
    const first = write(50, "email.send", "approved", '{"action":{"type":"email.send"}}');
    const a = write(50, "email.send", "approved", linkedJson(2), head(2));
    const r = replayIncident(db, recordId, verify());
    expect(first.egressId).toBeLessThan(a.egressId);
    // the whole audit bucket (two rows) is aligned with the egress bucket (two rows): the linked row is second
    expect(r.actions[0]?.egress).toMatchObject({
      id: a.egressId,
      paired: "paired",
      summaryMismatch: false,
    });
    expect(r.ok).toBe(true);
  });

  test("a tampered egress summary head is reported summary_mismatch; a flipped status statusDiffers", () => {
    const a = write(50, "email.send", "approved", linkedJson(2), head(2));
    db.run("UPDATE egress_ledger SET payload_summary = ? WHERE id = ?", [
      head(7, "inc_0000000000000000"),
      a.egressId,
    ]);
    let r = replayIncident(db, recordId, verify());
    expect(r.actions[0]?.egress?.summaryMismatch).toBe(true);
    db.run("UPDATE egress_ledger SET result_status = 'blocked' WHERE id = ?", [a.egressId]);
    r = replayIncident(db, recordId, verify());
    expect(r.actions[0]?.egress?.statusDiffers).toBe(true);
  });
});

describe("10.5 the range, stated", () => {
  test("audit runs from the row before the first linked row to the last; egress likewise; counts and anchors are printed", () => {
    unlinked(10);
    unlinked(11);
    const a = write(20, "email.send", "approved", linkedJson(2), head(2));
    unlinked(30);
    const b = write(40, "slack.message.post", "approved", linkedJson(2), head(2));
    const r = replayIncident(db, recordId, verify());
    expect(r.verification.audit).toMatchObject({
      anchorId: a.auditId - 1,
      toId: b.auditId,
      rowsRead: 2,
      ok: true,
      firstBreak: null,
    });
    expect(r.verification.audit?.verifiedRows).toBe(b.auditId - a.auditId + 1);
    expect(r.verification.egress).toMatchObject({
      anchorId: a.egressId - 1,
      toId: b.egressId,
      ok: true,
    });
  });

  test("no paired egress row says so and verifies nothing it did not read", () => {
    appendAuditEntry(db, {
      actionType: "email.send",
      hitlStatus: "approved",
      actionJson: linkedJson(2),
      timestamp: 20,
    });
    const r = replayIncident(db, recordId, verify());
    expect(r.verification.egress).toBeNull();
    expect(r.notes).toContain("No egress rows paired; the egress chain was not verified.");
    expect(r.verification.audit?.ok).toBe(true);
  });

  test("no linked action: no range at all and the note says so", () => {
    unlinked(10);
    const r = replayIncident(db, recordId, verify());
    expect(r.actions).toEqual([]);
    expect(r.verification).toEqual({ audit: null, egress: null });
    expect(r.notes).toContain("No linked actions.");
    expect(r.ok).toBe(true);
  });
});

describe("10.2 the anchor is the greatest id BELOW the first linked row (ids have gaps)", () => {
  test("rows 1, 2, 5, 9 with 5 and 9 linked: anchor 2, not 4, and the range verifies", () => {
    unlinked(10);
    unlinked(11);
    write(20, "email.send", "approved", linkedJson(2), head(2));
    unlinked(25);
    unlinked(26);
    write(40, "email.send", "approved", linkedJson(2), head(2));
    // renumber the chain (the id is not part of any hash): ids 1, 2, 5, 9 for the audit rows read
    db.exec("UPDATE audit_log SET id = id + 100");
    const newIds = [1, 2, 5, 6, 7, 9];
    const olds = (db.query("SELECT id FROM audit_log ORDER BY id").all() as { id: number }[]).map(
      (r) => r.id,
    );
    for (const [i, old] of olds.entries()) {
      db.run("UPDATE audit_log SET id = ? WHERE id = ?", [newIds[i] ?? 0, old]);
    }
    const r = replayIncident(db, recordId, verify());
    expect(r.verification.audit).toMatchObject({ anchorId: 2, toId: 9, ok: true });
  });

  test("a first linked row at the start of the table anchors at 0", () => {
    write(20, "email.send", "approved", linkedJson(2), head(2));
    const r = replayIncident(db, recordId, verify());
    expect(r.verification.audit?.anchorId).toBe(0);
    expect(r.verification.egress?.anchorId).toBe(0);
    expect(r.verification.audit?.ok).toBe(true);
  });

  test("a REAL pruned egress ledger (tombstone and attested boundary) verifies over a range starting at the first survivor", () => {
    unlinked(1);
    unlinked(2);
    unlinked(3);
    const a = write(100, "email.send", "approved", linkedJson(2), head(2));
    const b = write(110, "email.send", "approved", linkedJson(2), head(2));
    const pruned = pruneEgress(db, 50, 200);
    expect(pruned.prunedCount).toBe(3);
    const r = replayIncident(db, recordId, verify());
    expect(r.verification.egress).toMatchObject({ anchorId: 0, toId: b.egressId, ok: true });
    expect(a.egressId).toBeLessThan(b.egressId);
  });
});

describe("10.6 a broken chain is printed, not hidden", () => {
  test("a tampered audit row inside the range reports the first break; the rest is still returned", () => {
    const a = write(20, "email.send", "approved", linkedJson(2), head(2));
    write(30, "slack.message.post", "approved", linkedJson(2), head(2));
    db.run("UPDATE audit_log SET hitl_status = 'rejected' WHERE id = ?", [a.auditId]);
    const r = replayIncident(db, recordId, verify());
    expect(r.ok).toBe(false);
    expect(r.verification.audit).toMatchObject({ ok: false, firstBreak: a.auditId });
    expect(r.actions).toHaveLength(2);
  });
});

describe("10.7 determinism", () => {
  test("two runs on one database serialise to the same bytes", () => {
    write(20, "jira.before.read", "not_required", linkedJson(2, { sub: true }));
    write(20, "email.send", "approved", linkedJson(2, { prompt: "shown" }), head(2));
    unlinked(30);
    write(40, "slack.message.post", "rejected", linkedJson(1), head(1));
    const one = canonicalJson(replayIncident(db, recordId, verify(), { includeRecords: true }));
    const two = canonicalJson(replayIncident(db, recordId, verify(), { includeRecords: true }));
    expect(one).toBe(two);
  });

  test("the range start matters: an anchor one row too late would hide the break before it", () => {
    const pre = unlinked(10);
    write(20, "email.send", "approved", linkedJson(2), head(2));
    // break the row just BEFORE the first linked row: the walk anchored at the stored hash of that row
    // detects the linked row's prev_hash no longer matching nothing, so verify the rule by tampering the
    // PREVIOUS row's stored hash instead (the anchor read) and see the range report the break at the first row
    db.run("UPDATE audit_log SET row_hash = ? WHERE id = ?", ["f".repeat(64), pre.auditId]);
    const r = replayIncident(db, recordId, verify());
    expect(r.verification.audit?.ok).toBe(false);
    expect(r.verification.audit?.firstBreak).toBe(pre.auditId + 1);
  });
});
