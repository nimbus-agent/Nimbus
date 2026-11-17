import type { Database } from "bun:sqlite";

import { verifyAuditChain } from "../db/audit-verify.ts";
import { verifyEgressChain } from "../egress/egress-verify.ts";
import {
  type ActionStep,
  groupSteps,
  type LinkedActionRow,
  linkPrefixFor,
  readLinkedActions,
} from "../incident/action-links.ts";
import { IncidentError } from "../incident/assemble.ts";
import { resolveIncidentRef } from "../incident/incident-id.ts";
import { getById, versionJson, versionsOf } from "../incident/incident-store.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { canonicalJson } from "../util/canonical-json.ts";

/**
 * `nimbus audit replay <incident-id>` (Phase 10 IC4, spec § 5.4): rebuild what happened for one incident record
 * from STORED rows only. The record's versions come from `incident_record_version`; the actions Nimbus took for it
 * come from the audit rows whose first characters are the record's incident link (`incident/action-links.ts`), each
 * with the prompt text the owner was shown, the verdict, the answer source and the typed-confirm outcome, and the
 * egress row written beside it. Both hash chains are verified over the range the rows span, and the result says
 * which range (never a bare "verified").
 *
 * No clock and no random input: two runs on one database serialise to the same bytes (`canonicalJson`). It
 * lives in `audit/` (beside `agent-door-proof.ts`, which does the same job for the agent door) because it reads
 * the egress ledger, which `incident/**` may not import (static D46(a), I57 (a)). It reads and dispatches
 * nothing outward.
 *
 * Stated bounds: a row's stored prompt is credential-redacted and cut at 1,600 escaped characters while its hash
 * is of the text AS SHOWN, so the hash cannot be recomputed from the stored text; the egress summary is not
 * hashed, so pairing is by order within `(timestamp, method)` and the summary head is corroboration only; the
 * verified range starts at the row BEFORE the first linked row, anchored at its stored hash, so a tampered anchor
 * row itself is outside it.
 */

export const REPLAY_PROPOSALS_NOTE = "No proposals are recorded before IC5.";
export const REPLAY_PROMPT_NOTE =
  "The stored prompt text is credential-redacted and may be cut; its hash is of the text as shown to the owner.";

export type ChainCheck = {
  readonly ok: boolean;
  readonly verifiedRows: number;
  readonly brokenAt: number | undefined;
  readonly reason: string | undefined;
};

/** The two chain verifiers over an inclusive id range, injected (production: the audit and egress verifiers). */
export type ReplayVerifiers = {
  readonly audit: (fromId: number, toId: number) => ChainCheck;
  readonly egress: (fromId: number, toId: number) => ChainCheck;
};

export type ReplayVersion = {
  readonly version: number;
  readonly assembledAtMs: number;
  readonly recordSha256: string;
  /** The core keys whose value differs from the previous version (every core key for version 1). */
  readonly changedKeys: readonly string[];
  /** The full stored `record_json` (only when asked for). */
  readonly record?: unknown;
};

export type ReplayEgress = {
  readonly id: number;
  readonly resultStatus: string;
  readonly hitlStatus: string;
  readonly paired: "paired" | "ambiguous";
  /** The summary head does not start with this row's link (the summary is unhashed: corroboration only). */
  readonly summaryMismatch: boolean;
  /** The result status the verdict implies (`blocked` for a rejected row, else `authorized`) is not what the ledger says. */
  readonly statusDiffers: boolean;
};

export type ReplayRow = {
  readonly auditId: number;
  readonly timestamp: number;
  readonly actionType: string;
  readonly hitlStatus: string;
  readonly answerSource: string | null;
  readonly confirm: string | null;
  readonly linkVersion: number;
  readonly unknownVersion: boolean;
  readonly rowTruncated: boolean;
  /** The row as stored: redacted, capped at 4,096 characters. */
  readonly stored: string;
  readonly egress: ReplayEgress | null;
};

export type ReplayStepOut = ReplayRow & {
  readonly prompt: {
    readonly text: string;
    readonly cut: boolean;
    readonly sha256: string;
    readonly redactedInStored: boolean;
  } | null;
  readonly subSteps: readonly ReplayRow[];
};

export type ReplayRange = {
  /** The row before the first one read (its stored hash anchors the walk); 0 when there is none. */
  readonly anchorId: number;
  readonly toId: number;
  readonly rowsRead: number;
  readonly ok: boolean;
  readonly verifiedRows: number;
  readonly firstBreak: number | null;
  readonly reason: string | null;
};

export type ReplayResult = {
  readonly ok: boolean;
  readonly record: {
    readonly id: string;
    readonly triggerItemId: string;
    readonly service: string | null;
    readonly currentVersion: number;
    readonly versions: readonly ReplayVersion[];
  };
  readonly actions: readonly ReplayStepOut[];
  readonly actionsTruncated: boolean;
  readonly proposals: { readonly items: readonly never[]; readonly note: string };
  readonly verification: {
    readonly audit: ReplayRange | null;
    readonly egress: ReplayRange | null;
  };
  readonly notes: readonly string[];
};

/** The production verifiers: the audit and egress chain walks, bounded to the range replay read. */
export function chainVerifiers(idx: LocalIndex): ReplayVerifiers {
  return {
    audit: (fromId, toId) => {
      const r = verifyAuditChain(idx, { fromId, toId });
      return {
        ok: r.ok,
        verifiedRows: r.verifiedRows,
        brokenAt: r.firstBreakAtId,
        reason: r.reason,
      };
    },
    egress: (fromId, toId) => {
      const r = verifyEgressChain(idx.rawDb, fromId, toId);
      return { ok: r.ok, verifiedRows: r.verifiedRows, brokenAt: r.brokenAt, reason: r.reason };
    },
  };
}

const VOLATILE = new Set(["version", "assembledAtMs", "freshness"]);

function changedKeys(
  prev: Record<string, unknown> | null,
  next: Record<string, unknown>,
): string[] {
  const keys = new Set<string>([...Object.keys(next), ...Object.keys(prev ?? {})]);
  return [...keys]
    .filter((k) => !VOLATILE.has(k))
    .filter((k) => prev === null || canonicalJson(prev[k]) !== canonicalJson(next[k]))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function versionsOfRecord(
  db: Database,
  recordId: string,
  includeRecords: boolean,
): ReplayVersion[] {
  let prev: Record<string, unknown> | null = null;
  const out: ReplayVersion[] = [];
  for (const v of versionsOf(db, recordId)) {
    const json = versionJson(db, recordId, v.version) ?? "{}";
    const obj = parseObject(json);
    out.push({
      version: v.version,
      assembledAtMs: v.assembled_at_ms,
      recordSha256: v.record_sha256,
      changedKeys: changedKeys(prev, obj),
      ...(includeRecords ? { record: obj } : {}),
    });
    prev = obj;
  }
  return out;
}

type EgressRow = {
  id: number;
  timestamp: number;
  method: string;
  hitl_status: string;
  result_status: string;
  payload_summary: string;
};

/**
 * Pair each linked audit row with the egress row written beside it: by order within `(timestamp, method)`.
 * The order is taken over the WHOLE audit bucket (every row of that instant and type, linked or not), because
 * the egress bucket holds the egress row of every one of them: aligning only the linked rows would hand an
 * unlinked action's egress row to a linked one written after it.
 */
function pairEgress(db: Database, rows: readonly LinkedActionRow[]): Map<number, ReplayEgress> {
  const out = new Map<number, ReplayEgress>();
  const byKey = new Map<string, LinkedActionRow[]>();
  for (const r of rows) {
    const k = `${String(r.timestamp)}\u0000${r.actionType}`;
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  const read = db.query(
    `SELECT id, timestamp, method, hitl_status, result_status, payload_summary
       FROM egress_ledger WHERE timestamp = ? AND method = ? ORDER BY id ASC`,
  );
  const bucket = db.query(
    "SELECT id FROM audit_log WHERE timestamp = ? AND action_type = ? ORDER BY id ASC",
  );
  for (const list of byKey.values()) {
    const first = list[0];
    if (first === undefined) continue;
    const egress = read.all(first.timestamp, first.actionType) as EgressRow[];
    const auditBucket = (bucket.all(first.timestamp, first.actionType) as { id: number }[]).map(
      (r) => r.id,
    );
    const ambiguous = egress.length !== auditBucket.length;
    for (const audit of list) {
      const e = egress[auditBucket.indexOf(audit.auditId)];
      if (e === undefined) continue;
      const head = `{"incident":{"id":"${audit.link.id}","version":${String(audit.link.version)}}`;
      const expected = audit.hitlStatus === "rejected" ? "blocked" : "authorized";
      out.set(audit.auditId, {
        id: e.id,
        resultStatus: e.result_status,
        hitlStatus: e.hitl_status,
        paired: ambiguous ? "ambiguous" : "paired",
        summaryMismatch: !e.payload_summary.startsWith(head),
        statusDiffers: e.result_status !== expected,
      });
    }
  }
  return out;
}

function rowOut(
  r: LinkedActionRow,
  stored: string,
  versions: ReadonlySet<number>,
  egress: ReadonlyMap<number, ReplayEgress>,
): ReplayRow {
  return {
    auditId: r.auditId,
    timestamp: r.timestamp,
    actionType: r.actionType,
    hitlStatus: r.hitlStatus,
    answerSource: r.answerSource ?? null,
    confirm: r.confirm ?? null,
    linkVersion: r.link.version,
    unknownVersion: !versions.has(r.link.version),
    rowTruncated: r.rowTruncated,
    stored,
    egress: egress.get(r.auditId) ?? null,
  };
}

function stepOut(
  s: ActionStep,
  stored: ReadonlyMap<number, string>,
  versions: ReadonlySet<number>,
  egress: ReadonlyMap<number, ReplayEgress>,
): ReplayStepOut {
  const p = s.gate.prompt;
  return {
    ...rowOut(s.gate, stored.get(s.gate.auditId) ?? "", versions, egress),
    prompt:
      p === undefined
        ? null
        : {
            text: p.text,
            cut: p.cut,
            sha256: p.sha256,
            redactedInStored: p.text.includes("[REDACTED]"),
          },
    subSteps: s.subSteps.map((x) => rowOut(x, stored.get(x.auditId) ?? "", versions, egress)),
  };
}

function precedingId(db: Database, table: "audit_log" | "egress_ledger", firstId: number): number {
  // `table` is one of two literals, never caller data (I9).
  const row = db
    .query(`SELECT id FROM ${table} WHERE id < ? ORDER BY id DESC LIMIT 1`)
    .get(firstId) as { id: number } | null;
  return row === null ? 0 : row.id;
}

function range(
  db: Database,
  table: "audit_log" | "egress_ledger",
  ids: readonly number[],
  verify: (fromId: number, toId: number) => ChainCheck,
): ReplayRange | null {
  if (ids.length === 0) return null;
  const first = Math.min(...ids);
  const last = Math.max(...ids);
  const anchorId = precedingId(db, table, first);
  const r = verify(anchorId, last);
  return {
    anchorId,
    toId: last,
    rowsRead: ids.length,
    ok: r.ok,
    verifiedRows: r.verifiedRows,
    firstBreak: r.brokenAt ?? null,
    reason: r.reason ?? null,
  };
}

/**
 * Replay one incident. `ref` is a record id, a trigger item id or a provider id (`resolveIncidentRef`); an
 * unknown or ambiguous one throws {@link IncidentError} (`ERR_INCIDENT_NOT_FOUND`).
 */
export function replayIncident(
  db: Database,
  ref: string,
  verify: ReplayVerifiers,
  opts: { readonly includeRecords?: boolean } = {},
): ReplayResult {
  const resolved = resolveIncidentRef(db, ref);
  if (resolved.kind !== "record") {
    throw new IncidentError("ERR_INCIDENT_NOT_FOUND", "no incident record has that id");
  }
  const row = getById(db, resolved.recordId);
  if (row === null)
    throw new IncidentError("ERR_INCIDENT_NOT_FOUND", "no incident record has that id");

  const versions = versionsOfRecord(db, row.id, opts.includeRecords === true);
  const known = new Set(versions.map((v) => v.version));
  const linked = readLinkedActions(db, row.id);

  const prefix = linkPrefixFor(row.id);
  const storedById = new Map<number, string>();
  if (prefix !== undefined && linked.rows.length > 0) {
    const read = db.query("SELECT action_json FROM audit_log WHERE id = ?");
    for (const r of linked.rows) {
      const s = read.get(r.auditId) as { action_json: string } | null;
      storedById.set(r.auditId, s?.action_json ?? "");
    }
  }
  const egress = pairEgress(db, linked.rows);
  const actions = groupSteps(linked.rows).map((s) => stepOut(s, storedById, known, egress));

  const auditIds = linked.rows.map((r) => r.auditId);
  const egressIds = [...egress.values()].map((e) => e.id);
  const auditRange = range(db, "audit_log", auditIds, verify.audit);
  const egressRange = range(db, "egress_ledger", egressIds, verify.egress);

  const notes: string[] = [];
  if (linked.rows.length === 0) notes.push("No linked actions.");
  if (linked.truncated)
    notes.push("More linked rows exist than were read; the first 5,000 are shown.");
  if (linked.rows.length > 0 && egressRange === null) {
    notes.push("No egress rows paired; the egress chain was not verified.");
  }
  if (actions.some((a) => a.prompt !== null)) notes.push(REPLAY_PROMPT_NOTE);
  if (actions.some((a) => a.unknownVersion)) {
    notes.push("An action names a record version that is not stored (pruned).");
  }

  return {
    ok: (auditRange?.ok ?? true) && (egressRange?.ok ?? true),
    record: {
      id: row.id,
      triggerItemId: row.trigger_item_id,
      service: row.service,
      currentVersion: row.version,
      versions,
    },
    actions,
    actionsTruncated: linked.truncated,
    proposals: { items: [], note: REPLAY_PROPOSALS_NOTE },
    verification: { audit: auditRange, egress: egressRange },
    notes,
  };
}
