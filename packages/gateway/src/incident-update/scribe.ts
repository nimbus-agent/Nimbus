import type { Database } from "bun:sqlite";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * The incident scribe (Phase 10 IC9b, incident-engine spec § 5.9). With `[incident.scribe] enabled = true`,
 * every new version of an incident record (the engine's `incident.assembled` signal) QUEUES a stakeholder update
 * draft and shows ONE counts-only notification; it never posts, dispatches, requests or calls a model.
 *
 * The queue is a directory, `<dataDir>/incident-drafts/`, of one small JSON file per queued version holding
 * `{ recordId, version, queuedAtMs }` and NOTHING else: no title and no draft text. The draft is rendered when the
 * owner reads it (`nimbus incident update <id> --version N`), from the stored record version, which is
 * deterministic. So the queue holds no indexed text on disk, and an owner erasure, which deletes the record and its
 * versions (I57 (a)), also removes the draft: a listing drops, and deletes the file of, any entry whose record
 * or version is gone. A record id is checked against the engine's own shape before it becomes a path.
 */

export const SCRIBE_DIR = "incident-drafts";
export const SCRIBE_QUEUE_MAX = 200;
/** At most one notification per this long; drafts queued meanwhile are counted in the next one. */
export const SCRIBE_NOTIFY_INTERVAL_MS = 10 * 60_000;

const RECORD_ID_RE = /^inc_[0-9a-f]{16}$/;
const FILE_RE = /^(inc_[0-9a-f]{16})\.v([1-9][0-9]{0,8})\.json$/;

export type QueuedDraft = {
  readonly recordId: string;
  readonly version: number;
  readonly queuedAtMs: number;
};

export type ScribeDeps = {
  readonly dataDir: string;
  /** Read on every signal, so an edited nimbus.toml applies without a restart. */
  readonly enabled: () => boolean;
  readonly now: () => number;
  /** The `incident.updateDrafted` gateway event: ids and a count only. */
  readonly emit: (payload: { recordId: string; version: number; queued: number }) => void;
  /** The counts-only OS notification (`showIgnoringFailure`); never rejects. */
  readonly notify: (title: string, body: string) => Promise<void>;
  readonly logger: { warn(obj: unknown, msg?: string): void };
};

export interface IncidentScribe {
  /** The engine's signal for a created or updated record. Never throws. */
  onAssembled(p: { readonly recordId: string; readonly version: number }): void;
}

function dirOf(dataDir: string): string {
  return join(dataDir, SCRIBE_DIR);
}

function fileName(recordId: string, version: number): string {
  return `${recordId}.v${String(version)}.json`;
}

function readEntries(dir: string): QueuedDraft[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: QueuedDraft[] = [];
  for (const name of names) {
    const m = FILE_RE.exec(name);
    if (m === null) continue;
    let queuedAtMs: number;
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
      const q =
        parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)["queuedAtMs"]
          : undefined;
      queuedAtMs = typeof q === "number" && Number.isFinite(q) ? q : statSync(join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    out.push({ recordId: m[1] as string, version: Number(m[2]), queuedAtMs });
  }
  // Newest first; ties broken by id and version so the order is total.
  out.sort(
    (a, b) =>
      b.queuedAtMs - a.queuedAtMs ||
      (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0) ||
      b.version - a.version,
  );
  return out;
}

function removeEntry(dir: string, e: QueuedDraft): void {
  try {
    rmSync(join(dir, fileName(e.recordId, e.version)), { force: true });
  } catch {
    // A file that cannot be removed now is tried again at the next listing.
  }
}

export function createIncidentScribe(deps: ScribeDeps): IncidentScribe {
  let lastNotifyMs: number | undefined;
  let pendingSinceNotify = 0;

  function queue(recordId: string, version: number): number {
    const dir = dirOf(deps.dataDir);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, fileName(recordId, version));
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, JSON.stringify({ recordId, version, queuedAtMs: deps.now() }));
    renameSync(tmp, target);
    const entries = readEntries(dir);
    for (const old of entries.slice(SCRIBE_QUEUE_MAX)) removeEntry(dir, old);
    return Math.min(entries.length, SCRIBE_QUEUE_MAX);
  }

  return {
    onAssembled(p) {
      try {
        if (!deps.enabled()) return;
        if (!RECORD_ID_RE.test(p.recordId) || !Number.isSafeInteger(p.version) || p.version < 1) {
          return;
        }
        const queued = queue(p.recordId, p.version);
        try {
          deps.emit({ recordId: p.recordId, version: p.version, queued });
        } catch {
          // An observer must not fail the scribe.
        }
        pendingSinceNotify += 1;
        const at = deps.now();
        if (lastNotifyMs !== undefined && at - lastNotifyMs < SCRIBE_NOTIFY_INTERVAL_MS) return;
        lastNotifyMs = at;
        const drafted = pendingSinceNotify;
        pendingSinceNotify = 0;
        void deps.notify(
          "Nimbus incident update drafted",
          `${String(drafted)} new draft${drafted === 1 ? "" : "s"}, ${String(queued)} waiting: nimbus incident update --queued`,
        );
      } catch (err) {
        deps.logger.warn({ err: String(err) }, "incident scribe: queueing a draft failed");
      }
    },
  };
}

/**
 * The queued drafts, newest first. Drops (and deletes the file of) any entry whose record or version is no
 * longer stored, so an erased record leaves nothing behind. READS the two record tables only.
 */
export function listQueuedDrafts(db: Database, dataDir: string): QueuedDraft[] {
  const dir = dirOf(dataDir);
  const current = db.query("SELECT version FROM incident_record WHERE id = ?");
  const older = db.query(
    "SELECT 1 AS ok FROM incident_record_version WHERE record_id = ? AND version = ?",
  );
  const live: QueuedDraft[] = [];
  try {
    for (const e of readEntries(dir)) {
      const row = current.get(e.recordId) as { version: number } | null;
      const exists =
        row !== null && (row.version === e.version || older.get(e.recordId, e.version) !== null);
      if (exists) live.push(e);
      else removeEntry(dir, e);
    }
  } finally {
    current.finalize();
    older.finalize();
  }
  return live;
}
