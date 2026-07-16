import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { canonicalizeUrl } from "../clips/clip-ingest.ts";
import { listClipFingerprints, revokeClipToken } from "../clips/clip-token-store.ts";
import type { PairingWindowController } from "../clips/pairing-window.ts";
import { buildItemListSql } from "../index/item-list-query.ts";
import { deleteItemByPrimaryKey } from "../index/item-store.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export interface ClipRpcDeps {
  readonly pairing: PairingWindowController;
  readonly vault: NimbusVault;
  /** Local-index DB handle. Present when the index is wired; absent → list/delete fail-soft. */
  readonly db?: Database;
}

export interface ClipListEntry {
  readonly id: string;
  readonly title: string;
  readonly url: string | null;
  readonly clippedAt: number;
  readonly tags: string[];
  readonly mode: string;
  readonly wordCount: number;
}

type Outcome = { kind: "hit"; value: unknown } | { kind: "miss" };

function asRecord(p: unknown): Record<string, unknown> {
  return p !== null && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(1000, Math.trunc(n));
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function rowToClipEntry(row: Record<string, unknown>): ClipListEntry {
  const meta = parseMetadata(row["metadata"]);
  const tags = Array.isArray(meta["tags"])
    ? (meta["tags"].filter((t) => typeof t === "string") as string[])
    : [];
  return {
    id: String(row["id"]),
    title: typeof row["title"] === "string" ? row["title"] : "",
    url: typeof row["url"] === "string" ? row["url"] : null,
    clippedAt: typeof row["modified_at"] === "number" ? row["modified_at"] : 0,
    tags,
    mode: typeof meta["mode"] === "string" ? meta["mode"] : "",
    wordCount: typeof meta["wordCount"] === "number" ? meta["wordCount"] : 0,
  };
}

function listClips(db: Database, limit: number, tag: string | undefined): ClipListEntry[] {
  let rows: Record<string, unknown>[];
  if (tag === undefined) {
    const { sql, vals } = buildItemListSql({ services: [], types: ["web_clip"], limit });
    rows = db.query(sql).all(...vals) as Record<string, unknown>[];
  } else {
    // Guard json_each with json_valid: json_each raises "malformed JSON" (aborting the whole
    // query) if ANY web_clip row has invalid metadata. Clip ingest always writes valid JSON, but
    // this keeps a tampered/legacy row from crashing the listing — bad JSON → treated as no tags.
    rows = db
      .query(
        "SELECT item.* FROM item, json_each(" +
          "CASE WHEN json_valid(item.metadata) THEN item.metadata ELSE '{\"tags\":[]}' END, " +
          "'$.tags') " +
          "WHERE item.type = 'web_clip' AND json_each.value = ? " +
          "ORDER BY item.modified_at DESC LIMIT ?",
      )
      .all(tag, limit) as Record<string, unknown>[];
  }
  return rows.map(rowToClipEntry);
}

function allClipIds(db: Database): string[] {
  return (db.query("SELECT id FROM item WHERE type = 'web_clip'").all() as { id: string }[]).map(
    (r) => r.id,
  );
}

function clipIdIfExists(db: Database, id: string): string[] {
  const row = db.query("SELECT id FROM item WHERE id = ? AND type = 'web_clip'").get(id);
  return row === null ? [] : [id];
}

function clipIdsByCanonicalUrl(db: Database, canonical: string): string[] {
  return (
    db
      .query("SELECT id FROM item WHERE type = 'web_clip' AND canonical_url = ?")
      .all(canonical) as {
      id: string;
    }[]
  ).map((r) => r.id);
}

function resolveClipIdsToDelete(db: Database, rec: Record<string, unknown>): string[] {
  if (rec["all"] === true) return allClipIds(db);
  const target = typeof rec["target"] === "string" ? rec["target"].trim() : "";
  if (target === "") return [];
  return target.startsWith("nimbus:")
    ? clipIdIfExists(db, target)
    : clipIdsByCanonicalUrl(db, canonicalizeUrl(target));
}

export async function dispatchClipRpc(
  method: string,
  params: unknown,
  deps: ClipRpcDeps,
): Promise<Outcome> {
  const rec = asRecord(params);
  switch (method) {
    case "clip.pair": {
      // Random suffix, NOT a memory-only counter: a counter resets to 0 on gateway restart and a
      // fresh "device-1" would overwrite an existing "device-1" token in the Vault map.
      const label =
        typeof rec["label"] === "string" && rec["label"].length > 0
          ? (rec["label"] as string)
          : `device-${randomBytes(3).toString("hex")}`;
      const { code, expiresAtMs } = deps.pairing.open(label);
      return { kind: "hit", value: { code, expiresAtMs, label } };
    }
    case "clip.status": {
      const devices = await listClipFingerprints(deps.vault);
      return { kind: "hit", value: { devices } };
    }
    case "clip.revoke": {
      const label = typeof rec["label"] === "string" ? (rec["label"] as string) : "";
      if (label === "") return { kind: "hit", value: { revoked: 0 } };
      const revoked = await revokeClipToken(deps.vault, label);
      return { kind: "hit", value: { revoked } };
    }
    case "clip.list": {
      if (deps.db === undefined) return { kind: "hit", value: { clips: [] } };
      const limit = clampLimit(rec["limit"]);
      const tag =
        typeof rec["tag"] === "string" && rec["tag"].length > 0
          ? (rec["tag"] as string)
          : undefined;
      return { kind: "hit", value: { clips: listClips(deps.db, limit, tag) } };
    }
    case "clip.delete": {
      // Do NOT fail-soft to a false success here: a delete that can't reach the index must not
      // report "Deleted 0" (which reads as "nothing matched"). Surface it (spec Error handling).
      if (deps.db === undefined) throw new Error("Clip index unavailable.");
      const ids = resolveClipIdsToDelete(deps.db, rec);
      if (rec["dryRun"] === true) {
        return { kind: "hit", value: { deleted: 0, matched: ids.length } };
      }
      for (const id of ids) deleteItemByPrimaryKey(deps.db, id);
      return { kind: "hit", value: { deleted: ids.length, matched: ids.length } };
    }
    default:
      return { kind: "miss" };
  }
}
