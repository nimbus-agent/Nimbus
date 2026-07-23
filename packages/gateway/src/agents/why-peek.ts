import type { Database } from "bun:sqlite";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { type BlameSpawn, ensureBlameLine } from "./_lib/blame-on-demand.ts";
import { resolveWhySubject } from "./_lib/why-subject.ts";
import type { WhyInput, WhyPeek } from "./_lib/why-types.ts";

export type WhyPeekDeps = {
  db: Database;
  roots: readonly NimbusFilesystemRootToml[];
  spawn?: BlameSpawn;
  exists?: (p: string) => boolean;
};

const SHA_PORTION = "substr(external_id, instr(external_id, ':') + 1)";

function commitSubjectFor(
  db: Database,
  sha: string,
  repoRoot: string,
): { id: string; label: string } | null {
  return db
    .query(
      `SELECT id, label FROM graph_entity
        WHERE type = 'commit' AND ${SHA_PORTION} = ?
        ORDER BY CASE WHEN json_extract(metadata, '$.repoRoot') = ? THEN 0 ELSE 1 END, id ASC
        LIMIT 1`,
    )
    .get(sha, repoRoot) as { id: string; label: string } | null;
}

function prForSha(
  db: Database,
  sha: string,
): { entityId: string; number: number | null; title: string; url: string | null } | null {
  const row = db
    .query(
      `SELECT p.id AS entity_id,
              CAST(json_extract(i.metadata, '$.number') AS INTEGER) AS number,
              i.title AS title,
              i.url   AS url
         FROM graph_relation r
         JOIN graph_entity c ON c.id = r.to_id  AND c.type = 'commit'
         JOIN graph_entity p ON p.id = r.from_id AND p.type = 'pr'
         JOIN item i ON i.id = p.external_id
        WHERE r.type = 'merged_as'
          AND substr(c.external_id, instr(c.external_id, ':') + 1) = ?
        LIMIT 1`,
    )
    .get(sha) as {
    entity_id: string;
    number: number | null;
    title: string;
    url: string | null;
  } | null;
  return row === null
    ? null
    : { entityId: row.entity_id, number: row.number, title: row.title, url: row.url };
}

function ticketForPr(
  db: Database,
  prEntityId: string,
): { entityId: string; key: string; title: string; url: string | null } | null {
  const row = db
    .query(
      `SELECT ie.id AS entity_id, i.external_id AS key, i.title AS title, i.url AS url
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'pr'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'issue'
         JOIN item i ON i.id = ie.external_id
        WHERE r.from_id = ? AND r.type = 'resolves'
        LIMIT 1`,
    )
    .get(prEntityId) as {
    entity_id: string;
    key: string;
    title: string;
    url: string | null;
  } | null;
  return row === null
    ? null
    : { entityId: row.entity_id, key: row.key, title: row.title, url: row.url };
}

function computeHasMore(
  db: Database,
  targetIds: readonly string[],
  subject: { repoRoot: string; filePath: string },
): boolean {
  if (targetIds.length > 0) {
    const ph = targetIds.map(() => "?").join(", ");
    const m = db
      .query(`SELECT 1 FROM graph_relation WHERE to_id IN (${ph}) AND type = 'mentions' LIMIT 1`)
      .get(...targetIds);
    if (m !== null) return true;
  }
  const dep = db
    .query(
      `SELECT 1 FROM graph_relation r
        WHERE r.type = 'depends_on'
          AND r.to_id IN (
            SELECT id FROM graph_entity
             WHERE type = 'symbol'
               AND json_extract(metadata, '$.file') = ?
               AND json_extract(metadata, '$.repoRoot') = ?
          )
        LIMIT 1`,
    )
    .get(subject.filePath, subject.repoRoot);
  if (dep !== null) return true;
  return (
    db.query("SELECT 1 FROM graph_relation WHERE type = 'correlates_with' LIMIT 1").get() !== null
  );
}

export async function runWhyPeek(input: WhyInput, deps: WhyPeekDeps): Promise<WhyPeek> {
  const { db, roots, spawn, exists } = deps;
  const whySubject = resolveWhySubject(db, roots, input, exists);

  if (whySubject === null || whySubject.lineNo === null) {
    return {
      subject: null,
      author: null,
      authorEmail: null,
      commitSha: null,
      committedAt: null,
      commitSubject: null,
      pr: null,
      ticket: null,
      hasMore: false,
    };
  }

  const { repoRoot, filePath, lineNo } = whySubject;
  const blame = await ensureBlameLine(db, { repoRoot, filePath }, lineNo, spawn);

  let commitSubject: string | null = null;
  let pr: { number: number | null; title: string; url: string | null } | null = null;
  let ticket: { key: string; title: string; url: string | null } | null = null;
  const targetIds: string[] = [];

  if (blame !== null) {
    const commitEntity = commitSubjectFor(db, blame.commitSha, repoRoot);
    if (commitEntity !== null) {
      commitSubject = commitEntity.label;
      targetIds.push(commitEntity.id);
    }

    const prRow = prForSha(db, blame.commitSha);
    if (prRow !== null) {
      pr = { number: prRow.number, title: prRow.title, url: prRow.url };
      targetIds.push(prRow.entityId);

      const ticketRow = ticketForPr(db, prRow.entityId);
      if (ticketRow !== null) {
        ticket = { key: ticketRow.key, title: ticketRow.title, url: ticketRow.url };
        targetIds.push(ticketRow.entityId);
      }
    }
  }

  const hasMore = computeHasMore(db, targetIds, { repoRoot, filePath });

  return {
    subject: { repoRoot, filePath, lineNo },
    author: blame?.authorName ?? null,
    authorEmail: blame?.authorEmail ?? null,
    commitSha: blame?.commitSha ?? null,
    committedAt: blame?.authorTimeMs ?? null,
    commitSubject,
    pr,
    ticket,
    hasMore,
  };
}
