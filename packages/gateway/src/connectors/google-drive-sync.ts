import { deleteItemByServiceExternal, upsertIndexedItemForSync } from "../index/item-store.ts";
import { resolvePersonForSync } from "../people/linker.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { fetchGoogleJson } from "./google-sync-shared.ts";
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

export type DriveSyncCursorV1 =
  | { v: 1; phase: "init_list"; t0: string; listToken: string | null }
  | { v: 1; phase: "drain"; changePage: string }
  | { v: 1; phase: "delta"; pageToken: string; deltaPage?: number };

const CURSOR_PREFIX = "nimbus-gdrv1:";
const LIST_PAGE_SIZE = 100;
const CHANGES_PAGE_SIZE = 100;
const SERVICE_ID = "google_drive";

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
  return { v: 1, phase: "delta", pageToken, ...(deltaPage === undefined ? {} : { deltaPage }) };
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
  return resolvePersonForSync(ctx.db, {
    canonicalEmail: email,
    displayName: ownerName ?? email,
  });
}

function upsertDriveFile(ctx: SyncContext, f: DriveFile, now: number): void {
  const id = f.id;
  const name = f.name;
  if (id === undefined || id === "" || name === undefined) {
    return;
  }
  if (f.trashed === true) {
    deleteItemByServiceExternal(ctx.db, SERVICE_ID, id);
    return;
  }
  const mime = f.mimeType ?? "";
  const isFolder = mime === "application/vnd.google-apps.folder";
  const modifiedMs = f.modifiedTime === undefined ? now : Date.parse(f.modifiedTime);
  const safeModified = Number.isFinite(modifiedMs) ? modifiedMs : now;
  const desc = f.description ?? "";
  const previewBase = desc === "" ? name : desc;
  const bodyPreview = previewBase.length > 512 ? previewBase.slice(0, 512) : previewBase;
  const authorId = resolveDriveOwnerAuthorId(ctx, f.owners);
  upsertIndexedItemForSync(ctx, {
    service: SERVICE_ID,
    type: isFolder ? "folder" : "file",
    externalId: id,
    title: name,
    bodyPreview,
    url: f.webViewLink ?? null,
    canonicalUrl: f.webViewLink ?? null,
    modifiedAt: safeModified,
    authorId,
    metadata: {
      mimeType: mime,
      size: f.size,
    },
    pinned: false,
    syncedAt: now,
  });
}

function applyChange(ctx: SyncContext, ch: DriveChange, now: number): "upsert" | "delete" | "skip" {
  if (ch["removed"] === true) {
    const fid = typeof ch["fileId"] === "string" ? ch["fileId"] : "";
    if (fid !== "") {
      deleteItemByServiceExternal(ctx.db, SERVICE_ID, fid);
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
    deleteItemByServiceExternal(ctx.db, SERVICE_ID, id);
    return "delete";
  }
  upsertDriveFile(ctx, file, now);
  return "upsert";
}

function countAppliedDriveChanges(
  ctx: SyncContext,
  changes: DriveChange[],
  now: number,
): { itemsUpserted: number; itemsDeleted: number } {
  let itemsUpserted = 0;
  let itemsDeleted = 0;
  for (const ch of changes) {
    const r = applyChange(ctx, ch, now);
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

function countInitListFiles(files: DriveFile[]): number {
  let n = 0;
  for (const f of files) {
    if (f.id !== undefined && f.id !== "" && f.name !== undefined && f.trashed !== true) {
      n += 1;
    }
  }
  return n;
}

const DELTA_PAGE_LIMIT = 10_000;

async function runDriveChangePage(args: {
  ctx: SyncContext;
  accessToken: string;
  pageToken: string;
  startedAt: number;
  now: number;
  buildNextCursor: (next: string) => string;
  missingNewTokenMessage: string;
}): Promise<SyncResult> {
  const { ctx, accessToken, pageToken, startedAt, now } = args;
  const { data, bytes } = await listChangesPage(ctx, accessToken, pageToken);
  const counts = countAppliedDriveChanges(ctx, data.changes ?? [], now);
  const base = {
    itemsUpserted: counts.itemsUpserted,
    itemsDeleted: counts.itemsDeleted,
    durationMs: Date.now() - startedAt,
    bytesTransferred: bytes,
  };
  const next = data.nextPageToken;
  if (next !== undefined && next !== "") {
    return { ...base, cursor: args.buildNextCursor(next), hasMore: true };
  }
  const newTok = data.newStartPageToken;
  if (typeof newTok !== "string" || newTok === "") {
    throw new Error(args.missingNewTokenMessage);
  }
  return {
    ...base,
    cursor: encodeDriveSyncCursor({ v: 1, phase: "delta", pageToken: newTok }),
    hasMore: false,
  };
}

function runDrivePhaseDrain(
  ctx: SyncContext,
  accessToken: string,
  changePage: string,
  startedAt: number,
  now: number,
): Promise<SyncResult> {
  return runDriveChangePage({
    ctx,
    accessToken,
    pageToken: changePage,
    startedAt,
    now,
    buildNextCursor: (next) => encodeDriveSyncCursor({ v: 1, phase: "drain", changePage: next }),
    missingNewTokenMessage: "Google Drive sync failed: missing newStartPageToken after drain",
  });
}

function runDrivePhaseDelta(
  ctx: SyncContext,
  accessToken: string,
  v1: { pageToken: string; deltaPage?: number },
  startedAt: number,
  now: number,
): Promise<SyncResult> {
  const currentDeltaPage = (v1.deltaPage ?? 0) + 1;
  if (currentDeltaPage > DELTA_PAGE_LIMIT) {
    throw new Error(
      "Google Drive delta sync exceeded page limit — aborting to prevent infinite loop",
    );
  }
  return runDriveChangePage({
    ctx,
    accessToken,
    pageToken: v1.pageToken,
    startedAt,
    now,
    buildNextCursor: (next) =>
      encodeDriveSyncCursor({
        v: 1,
        phase: "delta",
        pageToken: next,
        deltaPage: currentDeltaPage,
      }),
    missingNewTokenMessage: "Google Drive sync failed: missing newStartPageToken",
  });
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
      const now = Date.now();

      let itemsUpserted = 0;
      const itemsDeleted = 0;
      let bytesTransferred = 0;

      const finishInitList = (t0: string, data: DriveListResponse, bytes: number): SyncResult => {
        bytesTransferred += bytes;
        const files = data.files ?? [];
        for (const f of files) {
          if (f.id !== undefined && f.id !== "" && f.name !== undefined && f.trashed !== true) {
            upsertDriveFile(ctx, f, now);
          }
        }
        itemsUpserted += countInitListFiles(files);
        const nextList = data.nextPageToken;
        const hasMoreList = nextList !== undefined && nextList !== "";
        if (hasMoreList) {
          return {
            cursor: encodeDriveSyncCursor({ v: 1, phase: "init_list", t0, listToken: nextList }),
            itemsUpserted,
            itemsDeleted,
            hasMore: true,
            durationMs: Date.now() - startedAt,
            bytesTransferred,
          };
        }
        return {
          cursor: encodeDriveSyncCursor({ v: 1, phase: "drain", changePage: t0 }),
          itemsUpserted,
          itemsDeleted,
          hasMore: true,
          durationMs: Date.now() - startedAt,
          bytesTransferred,
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
          return await runDrivePhaseDrain(ctx, accessToken, v1.changePage, startedAt, now);
        }
        return await runDrivePhaseDelta(ctx, accessToken, v1, startedAt, now);
      }

      const t0 = await getStartPageToken(ctx, accessToken);
      const { data, bytes } = await listFilesPage(ctx, accessToken, listQ, cursor);
      return finishInitList(t0, data, bytes);
    },
  };
}
