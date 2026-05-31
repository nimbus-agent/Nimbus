import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";
import {
  isItemLinkedGraphType,
  upsertGraphEntity,
  upsertGraphRelation,
} from "./relationship-graph.ts";

export type IndexedItemGraphInput = {
  id: string;
  service: string;
  type: string;
  title: string;
  authorId: string | null;
  metadata: Record<string, unknown>;
};

function stringField(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function repoPathFromMetadata(meta: Record<string, unknown>): string | undefined {
  return stringField(meta, "repo") ?? stringField(meta, "project");
}

function clearRelationsTouchingEntity(db: Database, entityId: string): void {
  dbRun(db, "DELETE FROM graph_relation WHERE from_id = ? OR to_id = ?", [entityId, entityId]);
}

function personDisplayName(db: Database, personId: string): string | null {
  const row = db.query("SELECT display_name FROM person WHERE id = ?").get(personId) as
    | { display_name: string | null }
    | null
    | undefined;
  const trimmed = row?.display_name?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : null;
}

function syncPrGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const repoFull = repoPathFromMetadata(row.metadata);
  const prEntityId = upsertGraphEntity(db, {
    type: "pr",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { repo: repoFull },
  });
  clearRelationsTouchingEntity(db, prEntityId);

  if (repoFull !== undefined) {
    const repoExt = `${row.service}:${repoFull}`;
    const repoId = upsertGraphEntity(db, {
      type: "repo",
      externalId: repoExt,
      label: repoFull,
      service: row.service,
    });
    upsertGraphRelation(db, prEntityId, repoId, "targets", now);
  }

  if (row.authorId !== null && row.authorId !== "") {
    const label =
      personDisplayName(db, row.authorId) ?? stringField(row.metadata, "user") ?? row.authorId;
    const personEntityId = upsertGraphEntity(db, {
      type: "person",
      externalId: row.authorId,
      label,
      service: row.service,
    });
    upsertGraphRelation(db, personEntityId, prEntityId, "authored", now);
  }

  const merged = row.metadata["merged"] === true;
  const mergeSha = stringField(row.metadata, "merge_commit_sha");
  if (merged && mergeSha !== undefined && mergeSha.length > 0) {
    const commitEntityId = upsertGraphEntity(db, {
      type: "commit",
      externalId: `${row.service}:${mergeSha}`,
      label: mergeSha.slice(0, 12),
      service: row.service,
      metadata: { sha: mergeSha },
    });
    upsertGraphRelation(db, prEntityId, commitEntityId, "merged_as", now);
  }
}

function syncIssueGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const repoFull = repoPathFromMetadata(row.metadata);
  const issueEntityId = upsertGraphEntity(db, {
    type: "issue",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { repo: repoFull },
  });
  clearRelationsTouchingEntity(db, issueEntityId);

  if (repoFull !== undefined) {
    const repoExt = `${row.service}:${repoFull}`;
    const repoId = upsertGraphEntity(db, {
      type: "repo",
      externalId: repoExt,
      label: repoFull,
      service: row.service,
    });
    upsertGraphRelation(db, issueEntityId, repoId, "belongs_to", now);
  }

  if (row.authorId !== null && row.authorId !== "") {
    const label =
      personDisplayName(db, row.authorId) ?? stringField(row.metadata, "user") ?? row.authorId;
    const personEntityId = upsertGraphEntity(db, {
      type: "person",
      externalId: row.authorId,
      label,
      service: row.service,
    });
    upsertGraphRelation(db, personEntityId, issueEntityId, "opened", now);
  }
}

function syncGitCommitGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const repoRoot = stringField(row.metadata, "repoRoot");
  const sha = stringField(row.metadata, "sha");
  if (sha === undefined) {
    return;
  }
  const commitEntityId = upsertGraphEntity(db, {
    type: "commit",
    externalId: `${row.service}:${sha}`,
    label: row.title,
    service: row.service,
    metadata: { sha, repoRoot: repoRoot ?? null },
  });
  clearRelationsTouchingEntity(db, commitEntityId);
  if (repoRoot !== undefined) {
    const wsExt = `filesystem:${repoRoot}`;
    const wsId = upsertGraphEntity(db, {
      type: "workspace",
      externalId: wsExt,
      label: repoRoot,
      service: "filesystem",
    });
    upsertGraphRelation(db, commitEntityId, wsId, "in_repo", now);
  }
}

function syncDependencyGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const repoRoot = stringField(row.metadata, "repoRoot");
  const pkg = stringField(row.metadata, "packageName");
  const ver = stringField(row.metadata, "version");
  if (pkg === undefined || ver === undefined) {
    return;
  }
  const depEntityId = upsertGraphEntity(db, {
    type: "package",
    externalId: `npm:${pkg}@${ver}`,
    label: `${pkg}@${ver}`,
    service: row.service,
    metadata: { packageName: pkg, version: ver },
  });
  clearRelationsTouchingEntity(db, depEntityId);
  if (repoRoot !== undefined) {
    const wsExt = `filesystem:${repoRoot}`;
    const wsId = upsertGraphEntity(db, {
      type: "workspace",
      externalId: wsExt,
      label: repoRoot,
      service: "filesystem",
    });
    upsertGraphRelation(db, wsId, depEntityId, "depends_on", now);
  }
}

function syncApiEndpointGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const serviceName = stringField(row.metadata, "service_name") ?? "unknown";
  const apiEndpointEntityId = upsertGraphEntity(db, {
    type: "api_endpoint",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { service_name: serviceName },
  });
  clearRelationsTouchingEntity(db, apiEndpointEntityId);

  const serviceExtId = `openapi:service:${serviceName}`;
  const serviceEntityId = upsertGraphEntity(db, {
    type: "service",
    externalId: serviceExtId,
    label: serviceName,
    service: row.service,
  });
  upsertGraphRelation(db, apiEndpointEntityId, serviceEntityId, "targets", now);
}

function syncObsidianNoteGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const vaultId = stringField(row.metadata, "vault_id") ?? "unknown";
  const noteEntityId = upsertGraphEntity(db, {
    type: "obsidian_note",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: { vault_id: vaultId },
  });
  clearRelationsTouchingEntity(db, noteEntityId);

  const resolved = row.metadata["resolved_wikilink_ids"];
  if (Array.isArray(resolved)) {
    for (const target of resolved) {
      if (typeof target !== "string" || target === "") {
        continue;
      }
      const tgt = db
        .query("SELECT id FROM graph_entity WHERE type = 'obsidian_note' AND external_id = ?")
        .get(target) as { id: string } | null;
      if (tgt === null) {
        continue;
      }
      upsertGraphRelation(db, noteEntityId, tgt.id, "backlinks", now);
    }
  }
}

function syncCodeSymbolGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const file = stringField(row.metadata, "file");
  const name = stringField(row.metadata, "name");
  const repoRoot = stringField(row.metadata, "repoRoot");
  if (file === undefined || name === undefined) {
    return;
  }
  const symId = upsertGraphEntity(db, {
    type: "symbol",
    externalId: row.id,
    label: `${name} — ${file}`,
    service: row.service,
    metadata: { file, name, repoRoot: repoRoot ?? null },
  });
  clearRelationsTouchingEntity(db, symId);
  if (repoRoot !== undefined) {
    const fileExt = `file:${repoRoot}:${file}`;
    const fileEntityId = upsertGraphEntity(db, {
      type: "source_file",
      externalId: fileExt,
      label: file,
      service: "filesystem",
    });
    upsertGraphRelation(db, symId, fileEntityId, "defined_in", now);
    const wsExt = `filesystem:${repoRoot}`;
    const wsId = upsertGraphEntity(db, {
      type: "workspace",
      externalId: wsExt,
      label: repoRoot,
      service: "filesystem",
    });
    upsertGraphRelation(db, fileEntityId, wsId, "in_repo", now);
  }
}

function syncMessageGraph(db: Database, row: IndexedItemGraphInput, now: number): void {
  const msgEntityId = upsertGraphEntity(db, {
    type: "message",
    externalId: row.id,
    label: row.title,
    service: row.service,
    metadata: {},
  });
  clearRelationsTouchingEntity(db, msgEntityId);

  if (row.authorId !== null && row.authorId !== "") {
    const label =
      personDisplayName(db, row.authorId) ?? stringField(row.metadata, "user") ?? row.authorId;
    const personEntityId = upsertGraphEntity(db, {
      type: "person",
      externalId: row.authorId,
      label,
      service: row.service,
    });
    upsertGraphRelation(db, personEntityId, msgEntityId, "posted", now);
  }

  const channel = stringField(row.metadata, "channel");
  if (channel !== undefined) {
    const chExt = `${row.service}:${channel}`;
    const chId = upsertGraphEntity(db, {
      type: "channel",
      externalId: chExt,
      label: channel,
      service: row.service,
    });
    upsertGraphRelation(db, msgEntityId, chId, "belongs_to", now);
  }
}

export function syncGraphFromIndexedItem(db: Database, row: IndexedItemGraphInput): void {
  if (readIndexedUserVersion(db) < 7) {
    return;
  }
  if (!isItemLinkedGraphType(row.type)) {
    return;
  }

  const now = Date.now();

  if (row.type === "pr") {
    syncPrGraph(db, row, now);
    return;
  }
  if (row.type === "issue") {
    syncIssueGraph(db, row, now);
    return;
  }
  if (row.type === "message") {
    syncMessageGraph(db, row, now);
    return;
  }
  if (row.type === "git_commit") {
    syncGitCommitGraph(db, row, now);
    return;
  }
  if (row.type === "dependency") {
    syncDependencyGraph(db, row, now);
    return;
  }
  if (row.type === "api_endpoint") {
    syncApiEndpointGraph(db, row, now);
    return;
  }
  if (row.type === "code_symbol") {
    syncCodeSymbolGraph(db, row, now);
    return;
  }
  if (row.type === "obsidian_note") {
    syncObsidianNoteGraph(db, row, now);
  }
}
