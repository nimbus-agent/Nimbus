import type { Database } from "bun:sqlite";

import { selectExtensionVersion } from "../../automation/extension-store.ts";
import { declaredNetworkFor } from "./declared-network.ts";
import { type FindingRow, observationFindings } from "./observation-findings.ts";
import {
  type ObservationRow,
  readExtensionAudit,
  readNoticeAt,
  recordNotice,
} from "./observation-store.ts";

/**
 * The once-a-day OS notification when observation finds an extension went beyond what it
 * declared (project 6, PR 6b-3). At most ONE notification per extension and version per
 * {@link NOTICE_INTERVAL_MS}, whatever the number of findings, and only for the version that is
 * installed now. The rate state is V82 `extension_observation_notice`, written BEFORE the send is
 * awaited, so a slow or failing notification service can never cause a second one. Evidence only:
 * nothing here changes enforcement, a grant, a score or an approval, and nothing leaves the machine.
 * No config key turns it off; tests inject `notify`.
 */

export const NOTICE_INTERVAL_MS = 24 * 3_600_000;

type Os = "linux" | "darwin" | "win32";

/**
 * What a notice needs to know about an extension version's findings. `newestLastSeen` is the
 * newest `last_seen` among the finding rows: a finding still active after the last notice can
 * notify again (`first_seen` never moves once a row exists, so it cannot drive a repeat).
 */
export type NoticeFinding = { os: Os; count: number; newestLastSeen: number };

export type TouchedVersion = { extensionId: string; version: string };

export type ObservationNotifierDeps = {
  db: Database;
  now: () => number;
  /** `showIgnoringFailure` bound to the notification service; a throw or rejection is swallowed anyway. */
  notify: (title: string, body: string) => Promise<void>;
  findingsFor: (extensionId: string, version: string) => NoticeFinding | null;
  log?: (line: string) => void;
};

export type ObservationNotifier = {
  /** Never rejects. */
  afterIngest(touched: readonly TouchedVersion[]): Promise<void>;
};

/** The exact notification text. On Linux the lookup was refused, so nothing was reached. */
export function noticeText(id: string, os: Os, count: number): { title: string; body: string } {
  if (os === "linux") {
    return {
      title: `Nimbus: ${id} was refused an undeclared network lookup`,
      body: `${String(count)} undeclared name(s) were looked up and refused. Run nimbus extension audit ${id}.`,
    };
  }
  // Off Linux an unmatched address may still be a declared host's rotated address: never "undeclared".
  return {
    title: `Nimbus: ${id} connected to an address not matched to a declared host`,
    body: `${String(count)} address(es) could not be matched to a declared host. Run nimbus extension audit ${id}.`,
  };
}

function toFindingRow(r: ObservationRow): FindingRow {
  return { destination: r.destination, port: r.port, count: r.count };
}

/** A NUL-joined key: neither part can contain NUL, so two pairs never collide. */
function rowKey(a: string, b: string | number): string {
  return `${a}\u0000${String(b)}`;
}

/**
 * The production `findingsFor`: the version's stored rows through `observationFindings`, the same
 * rule `extension.audit` reports, with the declared hosts from the verified installed manifest (the
 * run grant's only when the manifest cannot be read): a host the owner removed by narrowing (I52)
 * is still declared, so the child trying it is not an undeclared finding.
 */
export function observationFindingsFor(
  db: Database,
  extensionId: string,
  version: string,
): NoticeFinding | null {
  const { coverage, rows } = readExtensionAudit(db, extensionId, version);
  if (coverage === undefined) return null;
  const declared = declaredNetworkFor(db, extensionId, version).entries;
  const refused = rows.filter((r) => r.outcome === "refused");
  const unmatched = rows.filter((r) => r.outcome === "unmatched");
  const finding = observationFindings({
    os: coverage.os,
    declared,
    refused: refused.map(toFindingRow),
    unmatched: unmatched.map(toFindingRow),
  });
  if (finding === null) return null;
  let findingRows = unmatched;
  if (finding.kind === "refused-undeclared") {
    const keys = new Set((finding.destinations ?? []).map((d) => rowKey(d.destination, d.port)));
    findingRows = refused.filter((r) => keys.has(rowKey(r.destination, r.port)));
  }
  const newestLastSeen = findingRows.reduce((max, r) => Math.max(max, r.last_seen), 0);
  return { os: coverage.os, count: finding.count, newestLastSeen };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether this version is due a notice now; `undefined` when it is not. */
function dueNotice(
  deps: ObservationNotifierDeps,
  t: TouchedVersion,
  nowMs: number,
): NoticeFinding | undefined {
  // A late window from a superseded (or removed) version never notifies.
  if (selectExtensionVersion(deps.db, t.extensionId) !== t.version) return undefined;
  const finding = deps.findingsFor(t.extensionId, t.version);
  if (finding === null) return undefined;
  const last = readNoticeAt(deps.db, t.extensionId, t.version);
  if (last === undefined) return finding;
  if (finding.newestLastSeen <= last || nowMs - last < NOTICE_INTERVAL_MS) return undefined;
  return finding;
}

/**
 * Decides and records every notice synchronously, before any send is awaited: an overlapping call
 * then finds the row, and a slow or failing service cannot cause a second notice.
 */
function recordDueNotices(
  deps: ObservationNotifierDeps,
  touched: readonly TouchedVersion[],
  nowMs: number,
  log: (line: string) => void,
): Array<{ title: string; body: string }> {
  const sends: Array<{ title: string; body: string }> = [];
  for (const t of touched) {
    try {
      const finding = dueNotice(deps, t, nowMs);
      if (finding === undefined) continue;
      recordNotice(deps.db, t.extensionId, t.version, nowMs);
      sends.push(noticeText(t.extensionId, finding.os, finding.count));
    } catch (e) {
      log(`observation: notice check failed for ${t.extensionId}: ${errorText(e)}`);
    }
  }
  return sends;
}

export function createObservationNotifier(deps: ObservationNotifierDeps): ObservationNotifier {
  const log = deps.log ?? ((): void => {});
  return {
    async afterIngest(touched) {
      const sends = recordDueNotices(deps, touched, deps.now(), log);
      for (const s of sends) {
        try {
          await deps.notify(s.title, s.body); // NOSONAR S9382: one notification at a time
        } catch {
          // `showIgnoringFailure` never rejects; this guards a notify that does.
        }
      }
    },
  };
}
