import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { API_SCOPES, type ApiScope, isApiScope, LEGACY_SCOPES } from "../clips/api-scopes.ts";
import { listApiTokens, revokeClipToken, setApiTokenScopes } from "../clips/clip-token-store.ts";
import type { PairingWindowController } from "../clips/pairing-window.ts";
import { buildItemListSql } from "../index/item-list-query.ts";
import { deleteItemByPrimaryKey } from "../index/item-store.ts";
import { canonicalizeUrl } from "../util/url-canonical.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

export interface ClipRpcDeps {
  readonly pairing: PairingWindowController;
  readonly vault: NimbusVault;
  /** Local-index DB handle. Present when the index is wired; absent → list/delete fail-soft. */
  readonly db?: Database;
  /**
   * The gateway's loopback HTTP origin (e.g. `http://127.0.0.1:7474`), present only when the
   * read-only HTTP sidecar is running (NIMBUS_HTTP_PORT set). Echoed back by `clip.pair` so the
   * CLI can print the exact URL to paste into the extension. Undefined → the clip surface isn't
   * reachable, and the CLI warns the owner to (re)start with `nimbus serve --port`.
   */
  readonly httpBaseUrl?: string;
  /**
   * The research-briefs [briefs].enabled state (Spine S1), echoed verbatim by `clip.status` so
   * `nimbus clip status` can tell a paired user whether their first brief will 404 — default-off
   * means the feature is invisible otherwise, and clients are IPC-only (no reading nimbus.toml).
   */
  readonly briefsEnabled: boolean;
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

/**
 * Reads an OPERATOR-supplied scope list, rejecting anything unrecognised.
 *
 * Absent (`undefined`) means "I did not specify", and defaults to LEGACY_SCOPES. Everything else
 * is a statement, and a statement that cannot be honoured is refused rather than reinterpreted:
 * `--scopes telepathy` silently becoming `clip,briefs` would hand an operator who asked for
 * something narrow the default set instead — a silent over-grant, which is the exact failure this
 * whole change exists to prevent. An empty array is likewise refused rather than guessed at.
 *
 * NOTE the deliberate asymmetry with `parseEntry` in clip-token-store.ts, which DROPS unknown
 * scopes silently. Different source, different policy: a stored record may come from a newer
 * binary and must degrade closed without failing the load, whereas operator input is a typo and
 * deserves an error naming the valid set.
 */
function readScopes(v: unknown): readonly ApiScope[] {
  if (v === undefined) return LEGACY_SCOPES;
  if (!Array.isArray(v)) {
    throw new Error(`scopes must be an array of: ${API_SCOPES.join(", ")}`);
  }
  const invalid = v.filter((s) => !isApiScope(s));
  if (invalid.length > 0) {
    throw new Error(
      `unknown scope(s): ${invalid.map((s) => String(s)).join(", ")} — valid scopes are: ${API_SCOPES.join(", ")}`,
    );
  }
  if (v.length === 0) {
    throw new Error(`scopes must name at least one of: ${API_SCOPES.join(", ")}`);
  }
  return v as readonly ApiScope[];
}

function handleClipPair(params: unknown, deps: ClipRpcDeps): unknown {
  const rec = asRecord(params);
  // Random suffix, NOT a memory-only counter: a counter resets to 0 on gateway restart and a
  // fresh "device-1" would overwrite an existing "device-1" token in the Vault map.
  const label =
    typeof rec["label"] === "string" && rec["label"].length > 0
      ? (rec["label"] as string)
      : `device-${randomBytes(3).toString("hex")}`;
  const scopes = readScopes(rec["scopes"]);
  const { code, expiresAtMs } = deps.pairing.open(label, scopes);
  return {
    code,
    expiresAtMs,
    label,
    scopes: [...scopes],
    ...(deps.httpBaseUrl === undefined ? {} : { gatewayUrl: deps.httpBaseUrl }),
  };
}

async function handleClipStatus(_params: unknown, deps: ClipRpcDeps): Promise<unknown> {
  const devices = await listApiTokens(deps.vault);
  return { devices, briefsEnabled: deps.briefsEnabled };
}

async function handleClipScopes(params: unknown, deps: ClipRpcDeps): Promise<unknown> {
  const rec = asRecord(params);
  const label = typeof rec["label"] === "string" ? (rec["label"] as string) : "";
  if (label === "") return { updated: false, scopes: [] };
  const scopes = readScopes(rec["scopes"]);
  const updated = await setApiTokenScopes(deps.vault, label, scopes);
  return { updated, scopes: updated ? [...scopes] : [] };
}

async function handleClipRevoke(params: unknown, deps: ClipRpcDeps): Promise<unknown> {
  const rec = asRecord(params);
  const label = typeof rec["label"] === "string" ? (rec["label"] as string) : "";
  if (label === "") return { revoked: 0 };
  const revoked = await revokeClipToken(deps.vault, label);
  return { revoked };
}

function handleClipList(params: unknown, deps: ClipRpcDeps): unknown {
  if (deps.db === undefined) return { clips: [] };
  const rec = asRecord(params);
  const limit = clampLimit(rec["limit"]);
  const tag =
    typeof rec["tag"] === "string" && rec["tag"].length > 0 ? (rec["tag"] as string) : undefined;
  return { clips: listClips(deps.db, limit, tag) };
}

function handleClipDelete(params: unknown, deps: ClipRpcDeps): unknown {
  // Do NOT fail-soft to a false success here: a delete that can't reach the index must not
  // report "Deleted 0" (which reads as "nothing matched"). Surface it (spec Error handling).
  if (deps.db === undefined) throw new Error("Clip index unavailable.");
  const rec = asRecord(params);
  const ids = resolveClipIdsToDelete(deps.db, rec);
  if (rec["dryRun"] === true) {
    return { deleted: 0, matched: ids.length };
  }
  for (const id of ids) deleteItemByPrimaryKey(deps.db, id);
  return { deleted: ids.length, matched: ids.length };
}

const CLIP_RPC_HANDLERS: RpcMethodHandlerMap<ClipRpcDeps> = {
  "clip.pair": handleClipPair,
  "clip.status": handleClipStatus,
  "clip.scopes": handleClipScopes,
  "clip.revoke": handleClipRevoke,
  "clip.list": handleClipList,
  "clip.delete": handleClipDelete,
};

export function dispatchClipRpc(
  method: string,
  params: unknown,
  deps: ClipRpcDeps,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, deps, CLIP_RPC_HANDLERS);
}
