import { BODY_MAX_PROSE } from "../index/body-caps.ts";
import { itemPrimaryKey } from "../index/item-key.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { UnauthenticatedError } from "../sync/types.ts";
import { fetchGoogleJson, fetchGoogleText, GoogleHttpError } from "./google-sync-shared.ts";
import { asUnknownObjectRecord } from "./json-unknown.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

type DriveFileOwner = {
  displayName?: string;
  emailAddress?: string;
};

type DriveFile = {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  webViewLink?: string;
  size?: string;
  description?: string;
  trashed?: boolean;
  owners?: DriveFileOwner[];
};

type DriveListResponse = {
  nextPageToken?: string;
  files?: DriveFile[];
};

type DriveChange = {
  fileId?: string;
  removed?: boolean;
  file?: DriveFile;
};

type DriveChangesListResponse = {
  nextPageToken?: string;
  newStartPageToken?: string;
  changes?: DriveChange[];
};

type DriveStartTokenResponse = {
  startPageToken?: string;
};

type IndexDepth = "metadata_only" | "summary" | "full";

/**
 * The one-time re-list of Google Docs that rewrites existing `file` rows as `doc` with text (the
 * changes feed only ever shows files that changed). `listToken` is where the re-list resumes;
 * `doneAt` is the index depth it last completed under, so a depth change re-arms it. An ABSENT
 * field means "not started" — every cursor written before Docs had text reads that way, which is
 * what makes an upgraded install re-list once.
 */
export type DriveDocsRelist = { listToken: string | null } | { doneAt: IndexDepth };

export type DriveSyncCursorV1 =
  | { v: 1; phase: "init_list"; t0: string; listToken: string | null }
  | { v: 1; phase: "drain"; changePage: string }
  | {
      v: 1;
      phase: "delta";
      pageToken: string;
      deltaPage?: number;
      docs?: DriveDocsRelist;
    };

const CURSOR_PREFIX = "nimbus-gdrv1:";
const LIST_PAGE_SIZE = 100;
const CHANGES_PAGE_SIZE = 100;
const SERVICE_ID = "google_drive";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const GOOGLE_DOC_MIME = "application/vnd.google-apps.document";
/**
 * Docs exported per `sync()` call. A list or changes page holds at most 100 files, so this binds
 * only when a changes page and the one-time re-list share a call; the re-list never starts a page
 * it cannot finish within what is left (see `runDocsRelist`).
 */
export const DOC_EXPORTS_PER_SYNC = 200;
/**
 * Re-list pages per `sync()` call. The export budget alone does not bound the re-list: a page of Docs
 * whose text is already current spends nothing, so a large Drive would otherwise be listed end to
 * end inside one call.
 */
export const DOCS_RELIST_PAGES_PER_SYNC = 5;
const DOCS_RELIST_QUERY = `mimeType = '${GOOGLE_DOC_MIME}' and trashed = false`;
const DEPTHS: ReadonlySet<string> = new Set(["metadata_only", "summary", "full"]);

function parseDriveList(json: unknown): DriveListResponse {
  return asUnknownObjectRecord(json);
}

function parseDriveChanges(json: unknown): DriveChangesListResponse {
  return asUnknownObjectRecord(json);
}

function parseStartToken(json: unknown): DriveStartTokenResponse {
  return asUnknownObjectRecord(json);
}

export function encodeDriveSyncCursor(c: DriveSyncCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeDriveInitListPayload(r: Record<string, unknown>): DriveSyncCursorV1 | undefined {
  const t0 = r["t0"];
  const listToken = r["listToken"];
  if (typeof t0 !== "string" || t0 === "") {
    return undefined;
  }
  if (listToken !== null && typeof listToken !== "string") {
    return undefined;
  }
  return { v: 1, phase: "init_list", t0, listToken };
}

function decodeDriveDrainPayload(r: Record<string, unknown>): DriveSyncCursorV1 | undefined {
  const changePage = r["changePage"];
  if (typeof changePage !== "string" || changePage === "") {
    return undefined;
  }
  return { v: 1, phase: "drain", changePage };
}

function decodeDriveDeltaPayload(r: Record<string, unknown>): DriveSyncCursorV1 | undefined {
  const pageToken = r["pageToken"];
  if (typeof pageToken !== "string" || pageToken === "") {
    return undefined;
  }
  const rawDeltaPage = r["deltaPage"];
  const deltaPage = typeof rawDeltaPage === "number" ? rawDeltaPage : undefined;
  const docs = decodeDocsRelist(r["docs"]);
  return {
    v: 1,
    phase: "delta",
    pageToken,
    ...(deltaPage === undefined ? {} : { deltaPage }),
    ...(docs === undefined ? {} : { docs }),
  };
}

/** An unreadable `docs` value decodes as absent, i.e. the re-list runs again — the safe direction. */
function decodeDocsRelist(raw: unknown): DriveDocsRelist | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const doneAt = r["doneAt"];
  if (typeof doneAt === "string" && DEPTHS.has(doneAt)) {
    return { doneAt: doneAt as IndexDepth };
  }
  const listToken = r["listToken"];
  if (listToken === null || (typeof listToken === "string" && listToken !== "")) {
    return { listToken };
  }
  return undefined;
}

export function decodeDriveSyncCursor(raw: string): DriveSyncCursorV1 | undefined {
  const o = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (o == null || typeof o !== "object" || Array.isArray(o)) {
    return undefined;
  }
  const r = o as Record<string, unknown>;
  if (r["v"] !== 1) {
    return undefined;
  }
  const phase = r["phase"];
  if (phase === "init_list") {
    return decodeDriveInitListPayload(r);
  }
  if (phase === "drain") {
    return decodeDriveDrainPayload(r);
  }
  if (phase === "delta") {
    return decodeDriveDeltaPayload(r);
  }
  return undefined;
}

function listQueryForInitial(sinceIso: string): string {
  return `trashed = false and modifiedTime > '${sinceIso}'`;
}

function resolveDriveOwnerAuthorId(
  ctx: SyncContext,
  owners: DriveFileOwner[] | undefined,
): string | null {
  if (!Array.isArray(owners) || owners.length === 0) {
    return null;
  }
  const o = owners[0];
  if (o === undefined) {
    return null;
  }
  const email =
    typeof o.emailAddress === "string" && o.emailAddress !== "" ? o.emailAddress : undefined;
  const ownerName =
    typeof o.displayName === "string" && o.displayName !== "" ? o.displayName : undefined;
  if (email === undefined) {
    return null;
  }
  return ctx.resolvePerson({
    canonicalEmail: email,
    displayName: ownerName ?? email,
  });
}

/** What one `sync()` call may still spend on Doc exports, and what it spent. */
type DocExportBudget = {
  left: number;
  bytes: number;
  /**
   * A Doc in this call was written WITHOUT text for a reason a later re-list can fix (the budget ran
   * out, or the export failed transiently). The caller re-arms the re-list.
   */
  rearm: boolean;
};

function newDocExportBudget(): DocExportBudget {
  return { left: DOC_EXPORTS_PER_SYNC, bytes: 0, rearm: false };
}

type DocText =
  | { outcome: "complete" | "capped"; text: string }
  | { outcome: "errored"; transient: boolean }
  | { outcome: "skipped" };

async function exportDocText(
  ctx: SyncContext,
  accessToken: string,
  fileId: string,
  budget: DocExportBudget,
): Promise<DocText> {
  if (budget.left <= 0) {
    return { outcome: "skipped" };
  }
  budget.left -= 1;
  const url = new URL(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/export`,
  );
  url.searchParams.set("mimeType", "text/plain");
  try {
    const { text, bytes } = await fetchGoogleText(ctx, accessToken, url.toString(), "Google Drive");
    budget.bytes += bytes;
    return { outcome: text.length > BODY_MAX_PROSE ? "capped" : "complete", text };
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      throw err;
    }
    // A 403 (export-size limit, export not allowed) or 404 will not change on a retry; a 429 or a
    // 5xx may. Either way ONE Doc's export never fails the whole sync.
    const status = err instanceof GoogleHttpError ? err.status : 0;
    const transient = status === 0 || status === 429 || status >= 500;
    ctx.logger.warn({ fileId, status }, "google drive: doc export failed; indexed without text");
    return { outcome: "errored", transient };
  }
}

type DriveWriteDeps = {
  ctx: SyncContext;
  accessToken: string;
  budget: DocExportBudget;
  now: number;
};

function isCurrentDoc(ctx: SyncContext, id: string, modifiedAt: number): boolean {
  const prior = ctx.bodyFetchState(itemPrimaryKey(SERVICE_ID, id));
  return (
    prior !== null && prior.bodyFetch !== null && prior.hasBody && prior.modifiedAt === modifiedAt
  );
}

/**
 * Writes one Drive file. Returns false when nothing was written: a missing id or name, a trashed
 * file (deleted instead), or a Doc whose stored text is already this revision's.
 */
async function writeDriveFile(deps: DriveWriteDeps, f: DriveFile): Promise<boolean> {
  const { ctx, now } = deps;
  const id = f.id;
  const name = f.name;
  if (id === undefined || id === "" || name === undefined) {
    return false;
  }
  if (f.trashed === true) {
    ctx.deleteItem(SERVICE_ID, id);
    return false;
  }
  const mime = f.mimeType ?? "";
  const modifiedMs = f.modifiedTime === undefined ? now : Date.parse(f.modifiedTime);
  const safeModified = Number.isFinite(modifiedMs) ? modifiedMs : now;
  const desc = f.description ?? "";
  const previewBase = desc === "" ? name : desc;
  const bodyPreview = previewBase.length > 512 ? previewBase.slice(0, 512) : previewBase;
  // `service` and `type` stay on each write's own literal: the index-lane census reads a writer as
  // an object literal carrying both (scripts/structure-audit/lane-census/writer-emissions.ts).
  const base = {
    externalId: id,
    title: name,
    url: f.webViewLink ?? null,
    canonicalUrl: f.webViewLink ?? null,
    modifiedAt: safeModified,
    pinned: false,
    syncedAt: now,
  };
  if (mime !== GOOGLE_DOC_MIME) {
    ctx.upsertItem({
      ...base,
      service: SERVICE_ID,
      type: mime === FOLDER_MIME ? "folder" : "file",
      bodyPreview,
      authorId: resolveDriveOwnerAuthorId(ctx, f.owners),
      metadata: { mimeType: mime, size: f.size },
    });
    return true;
  }
  // A Doc. The item id is service + Drive id, never the type, so this upsert re-types the `file`
  // row an older sync wrote for the same Doc, in place.
  if (isCurrentDoc(ctx, id, safeModified)) {
    return false;
  }
  // Nothing would be stored at metadata_only (the depth chokepoint drops the body), so fetch nothing.
  const fetched: DocText =
    ctx.depth === "metadata_only"
      ? { outcome: "skipped" }
      : await exportDocText(ctx, deps.accessToken, id, deps.budget);
  if (
    (fetched.outcome === "skipped" && ctx.depth !== "metadata_only") ||
    (fetched.outcome === "errored" && fetched.transient)
  ) {
    deps.budget.rearm = true;
  }
  const metadata: Record<string, unknown> = { mimeType: mime, size: f.size };
  // The verdict is recorded only at `full`: a `summary` body is cut to 512 characters, and a
  // verdict there would stop the Doc being exported again once the owner deepens to `full`.
  if ((fetched.outcome === "complete" || fetched.outcome === "capped") && ctx.depth === "full") {
    metadata["bodyFetch"] = fetched.outcome;
  }
  const bodyInput =
    fetched.outcome === "complete" || fetched.outcome === "capped"
      ? { body: fetched.text, bodyTruncated: fetched.outcome === "capped" }
      : { bodyPreview };
  ctx.upsertItem({
    ...base,
    service: SERVICE_ID,
    type: "doc",
    ...bodyInput,
    authorId: resolveDriveOwnerAuthorId(ctx, f.owners),
    metadata,
  });
  return true;
}

async function applyChange(
  deps: DriveWriteDeps,
  ch: DriveChange,
): Promise<"upsert" | "delete" | "skip"> {
  const { ctx } = deps;
  if (ch["removed"] === true) {
    const fid = typeof ch["fileId"] === "string" ? ch["fileId"] : "";
    if (fid !== "") {
      ctx.deleteItem(SERVICE_ID, fid);
      return "delete";
    }
    return "skip";
  }
  const file = ch["file"];
  if (file === undefined) {
    return "skip";
  }
  const id = file.id;
  if (id === undefined || id === "") {
    return "skip";
  }
  if (file.trashed === true) {
    ctx.deleteItem(SERVICE_ID, id);
    return "delete";
  }
  return (await writeDriveFile(deps, file)) ? "upsert" : "skip";
}

async function countAppliedDriveChanges(
  deps: DriveWriteDeps,
  changes: DriveChange[],
): Promise<{ itemsUpserted: number; itemsDeleted: number }> {
  let itemsUpserted = 0;
  let itemsDeleted = 0;
  for (const ch of changes) {
    const r = await applyChange(deps, ch);
    if (r === "upsert") {
      itemsUpserted += 1;
    } else if (r === "delete") {
      itemsDeleted += 1;
    }
  }
  return { itemsUpserted, itemsDeleted };
}

function driveFetchJson(
  ctx: SyncContext,
  accessToken: string,
  url: string,
): Promise<{ json: unknown; bytes: number }> {
  return fetchGoogleJson(ctx, accessToken, url, "Google Drive");
}

async function getStartPageToken(ctx: SyncContext, accessToken: string): Promise<string> {
  const url = new URL("https://www.googleapis.com/drive/v3/changes/startPageToken");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("fields", "startPageToken");
  const { json } = await driveFetchJson(ctx, accessToken, url.toString());
  const t = parseStartToken(json)["startPageToken"];
  if (typeof t !== "string" || t === "") {
    throw new Error("Google Drive sync failed: missing startPageToken");
  }
  return t;
}

async function listFilesPage(
  ctx: SyncContext,
  accessToken: string,
  q: string,
  pageToken: string | undefined,
): Promise<{ data: DriveListResponse; bytes: number }> {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("pageSize", String(LIST_PAGE_SIZE));
  url.searchParams.set(
    "fields",
    "nextPageToken, files(id, name, mimeType, modifiedTime, webViewLink, size, description, trashed, owners(emailAddress, displayName))",
  );
  url.searchParams.set("q", q);
  if (pageToken !== undefined && pageToken !== "") {
    url.searchParams.set("pageToken", pageToken);
  }
  const { json, bytes } = await driveFetchJson(ctx, accessToken, url.toString());
  return { data: parseDriveList(json), bytes };
}

async function listChangesPage(
  ctx: SyncContext,
  accessToken: string,
  pageToken: string,
): Promise<{ data: DriveChangesListResponse; bytes: number }> {
  const url = new URL("https://www.googleapis.com/drive/v3/changes");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("pageSize", String(CHANGES_PAGE_SIZE));
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set(
    "fields",
    "nextPageToken,newStartPageToken,changes(removed,fileId,file(id,name,mimeType,modifiedTime,webViewLink,size,description,trashed,owners(emailAddress,displayName)))",
  );
  const { json, bytes } = await driveFetchJson(ctx, accessToken, url.toString());
  return { data: parseDriveChanges(json), bytes };
}

const DELTA_PAGE_LIMIT = 10_000;

/**
 * Whether a Doc the re-list found is one this connector would have indexed anyway: already in the
 * index (as a `file` row from before Docs had text, or a `doc` row), or modified inside the initial
 * sync window. The re-list exists to rewrite rows, not to widen what Drive indexes, so a Doc older
 * than the window that was never indexed stays out.
 */
function inDocsRelistScope(ctx: SyncContext, f: DriveFile, sinceMs: number): boolean {
  const id = f.id;
  if (id === undefined || id === "") {
    return false;
  }
  if (ctx.itemExists(itemPrimaryKey(SERVICE_ID, id))) {
    return true;
  }
  const modifiedMs = f.modifiedTime === undefined ? Number.NaN : Date.parse(f.modifiedTime);
  return Number.isFinite(modifiedMs) && modifiedMs > sinceMs;
}

/**
 * Advances the one-time Docs re-list. It never starts a page the export budget cannot finish: the
 * only resume point Drive gives is the NEXT page's token, so a page abandoned halfway would lose
 * its remaining Docs. A transient export failure inside the re-list is not re-armed (a Doc that
 * keeps failing would otherwise re-list the whole Drive on every sync); that Doc gets its text on
 * its next edit, on a depth change, or when the cursor is cleared.
 */
async function runDocsRelist(
  deps: DriveWriteDeps,
  listToken: string | null,
  sinceMs: number,
): Promise<{ docs: DriveDocsRelist; itemsUpserted: number; bytes: number }> {
  const { ctx } = deps;
  let token = listToken;
  let itemsUpserted = 0;
  let bytes = 0;
  const rearmBefore = deps.budget.rearm;
  for (
    let page = 0;
    page < DOCS_RELIST_PAGES_PER_SYNC && deps.budget.left >= LIST_PAGE_SIZE;
    page += 1
  ) {
    const { data, bytes: pageBytes } = await listFilesPage(
      ctx,
      deps.accessToken,
      DOCS_RELIST_QUERY,
      token ?? undefined,
    );
    bytes += pageBytes;
    for (const f of data.files ?? []) {
      if (inDocsRelistScope(ctx, f, sinceMs) && (await writeDriveFile(deps, f))) {
        itemsUpserted += 1;
      }
    }
    const next = data.nextPageToken;
    if (next === undefined || next === "") {
      deps.budget.rearm = rearmBefore;
      return { docs: { doneAt: ctx.depth }, itemsUpserted, bytes };
    }
    token = next;
  }
  deps.budget.rearm = rearmBefore;
  return { docs: { listToken: token }, itemsUpserted, bytes };
}

/** The re-list's state once a changes page is applied: restarted by a re-arm or a depth change. */
function docsRelistAfterPage(
  docs: DriveDocsRelist | undefined,
  rearm: boolean,
  depth: IndexDepth,
): DriveDocsRelist {
  if (rearm || docs === undefined) {
    return { listToken: null };
  }
  if ("doneAt" in docs) {
    return docs.doneAt === depth ? docs : { listToken: null };
  }
  return docs;
}

async function runDrivePhaseDrain(
  deps: DriveWriteDeps,
  changePage: string,
  startedAt: number,
): Promise<SyncResult> {
  const { data, bytes } = await listChangesPage(deps.ctx, deps.accessToken, changePage);
  const counts = await countAppliedDriveChanges(deps, data.changes ?? []);
  const base = {
    itemsUpserted: counts.itemsUpserted,
    itemsDeleted: counts.itemsDeleted,
    durationMs: Date.now() - startedAt,
    bytesTransferred: bytes + deps.budget.bytes,
  };
  const next = data.nextPageToken;
  if (next !== undefined && next !== "") {
    return {
      ...base,
      cursor: encodeDriveSyncCursor({ v: 1, phase: "drain", changePage: next }),
      hasMore: true,
    };
  }
  const newTok = data.newStartPageToken;
  if (typeof newTok !== "string" || newTok === "") {
    throw new Error("Google Drive sync failed: missing newStartPageToken after drain");
  }
  // No `docs` field: the first delta call runs the re-list, which also picks up any Doc this
  // initial sync had to write without text.
  return {
    ...base,
    cursor: encodeDriveSyncCursor({ v: 1, phase: "delta", pageToken: newTok }),
    hasMore: false,
  };
}

async function runDrivePhaseDelta(
  deps: DriveWriteDeps,
  v1: { pageToken: string; deltaPage?: number; docs?: DriveDocsRelist },
  startedAt: number,
  sinceMs: number,
): Promise<SyncResult> {
  const currentDeltaPage = (v1.deltaPage ?? 0) + 1;
  if (currentDeltaPage > DELTA_PAGE_LIMIT) {
    throw new Error(
      "Google Drive delta sync exceeded page limit — aborting to prevent infinite loop",
    );
  }
  const { data, bytes } = await listChangesPage(deps.ctx, deps.accessToken, v1.pageToken);
  const counts = await countAppliedDriveChanges(deps, data.changes ?? []);
  const docs = docsRelistAfterPage(v1.docs, deps.budget.rearm, deps.ctx.depth);
  const next = data.nextPageToken;
  if (next !== undefined && next !== "") {
    return {
      itemsUpserted: counts.itemsUpserted,
      itemsDeleted: counts.itemsDeleted,
      durationMs: Date.now() - startedAt,
      bytesTransferred: bytes + deps.budget.bytes,
      cursor: encodeDriveSyncCursor({
        v: 1,
        phase: "delta",
        pageToken: next,
        deltaPage: currentDeltaPage,
        docs,
      }),
      hasMore: true,
    };
  }
  const newTok = data.newStartPageToken;
  if (typeof newTok !== "string" || newTok === "") {
    throw new Error("Google Drive sync failed: missing newStartPageToken");
  }
  // Caught up with the changes feed, so the call's remaining budget goes to the re-list.
  const relist =
    "listToken" in docs
      ? await runDocsRelist(deps, docs.listToken, sinceMs)
      : { docs, itemsUpserted: 0, bytes: 0 };
  return {
    itemsUpserted: counts.itemsUpserted + relist.itemsUpserted,
    itemsDeleted: counts.itemsDeleted,
    durationMs: Date.now() - startedAt,
    bytesTransferred: bytes + relist.bytes + deps.budget.bytes,
    cursor: encodeDriveSyncCursor({ v: 1, phase: "delta", pageToken: newTok, docs: relist.docs }),
    hasMore: "listToken" in relist.docs,
  };
}

export type GoogleDriveSyncableOptions = {
  ensureGoogleDriveRunning: () => Promise<void>;
};

export function createGoogleDriveSyncable(options: GoogleDriveSyncableOptions): Syncable {
  const ensure = options.ensureGoogleDriveRunning;
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 30 * 60 * 1000,
    initialSyncDepthDays,

    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      await ensure();
      const startedAt = Date.now();
      const accessToken = await ctx.accessToken();

      const sinceMs = Date.now() - initialSyncDepthDays * 86_400_000;
      const sinceIso = new Date(sinceMs).toISOString();
      const listQ = listQueryForInitial(sinceIso);
      const deps: DriveWriteDeps = {
        ctx,
        accessToken,
        budget: newDocExportBudget(),
        now: Date.now(),
      };

      const finishInitList = async (
        t0: string,
        data: DriveListResponse,
        bytes: number,
      ): Promise<SyncResult> => {
        let itemsUpserted = 0;
        for (const f of data.files ?? []) {
          if (await writeDriveFile(deps, f)) {
            itemsUpserted += 1;
          }
        }
        const nextList = data.nextPageToken;
        const hasMoreList = nextList !== undefined && nextList !== "";
        return {
          cursor: hasMoreList
            ? encodeDriveSyncCursor({ v: 1, phase: "init_list", t0, listToken: nextList })
            : encodeDriveSyncCursor({ v: 1, phase: "drain", changePage: t0 }),
          itemsUpserted,
          itemsDeleted: 0,
          hasMore: true,
          durationMs: Date.now() - startedAt,
          bytesTransferred: bytes + deps.budget.bytes,
        };
      };

      if (cursor === null || cursor === "") {
        const t0 = await getStartPageToken(ctx, accessToken);
        const { data, bytes } = await listFilesPage(ctx, accessToken, listQ, undefined);
        return finishInitList(t0, data, bytes);
      }

      if (cursor.startsWith(CURSOR_PREFIX)) {
        const v1 = decodeDriveSyncCursor(cursor);
        if (v1 === undefined) {
          throw new Error("Google Drive sync: corrupt cursor");
        }
        if (v1.phase === "init_list") {
          const { data, bytes } = await listFilesPage(
            ctx,
            accessToken,
            listQ,
            v1.listToken ?? undefined,
          );
          return finishInitList(v1.t0, data, bytes);
        }
        if (v1.phase === "drain") {
          return await runDrivePhaseDrain(deps, v1.changePage, startedAt);
        }
        return await runDrivePhaseDelta(deps, v1, startedAt, sinceMs);
      }

      const t0 = await getStartPageToken(ctx, accessToken);
      const { data, bytes } = await listFilesPage(ctx, accessToken, listQ, cursor);
      return finishInitList(t0, data, bytes);
    },
  };
}
