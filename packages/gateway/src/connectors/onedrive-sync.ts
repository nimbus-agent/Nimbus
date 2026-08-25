import { normalizeEmail } from "../people/person-store.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  decodeMicrosoftGraphDeltaCursor,
  encodeMicrosoftGraphDeltaCursor,
  fetchMicrosoftGraphJson,
  type MicrosoftGraphDeltaCursorV1,
  modifiedMsFromIso,
  nextCursorFromODataDeltaLinks,
  parseODataDeltaPage,
} from "./microsoft-graph-sync-shared.ts";

const SERVICE_ID = "onedrive";
const CURSOR_PREFIX = "nimbus-odrv1:";
const GRAPH = "https://graph.microsoft.com/v1.0";
const PAGE_SIZE = 100;

type GraphDriveIdentityUser = {
  displayName?: string;
  email?: string;
  mail?: string;
  userPrincipalName?: string;
};

type DriveItem = {
  id?: string;
  name?: string;
  file?: unknown;
  folder?: unknown;
  webUrl?: string;
  lastModifiedDateTime?: string;
  size?: number;
  deleted?: { state?: string };
  lastModifiedBy?: { user?: GraphDriveIdentityUser };
  "@removed"?: { reason?: string };
};

function graphDriveUserMailbox(user: GraphDriveIdentityUser | undefined): string | undefined {
  if (user === undefined) {
    return undefined;
  }
  for (const k of ["email", "mail", "userPrincipalName"] as const) {
    const v = user[k];
    if (typeof v === "string" && v.includes("@")) {
      return normalizeEmail(v);
    }
  }
  return undefined;
}

export type OneDriveSyncCursorV1 = MicrosoftGraphDeltaCursorV1;

export function encodeOneDriveSyncCursor(c: OneDriveSyncCursorV1): string {
  return encodeMicrosoftGraphDeltaCursor(CURSOR_PREFIX, c);
}

export function decodeOneDriveSyncCursor(raw: string): OneDriveSyncCursorV1 | undefined {
  return decodeMicrosoftGraphDeltaCursor(raw, CURSOR_PREFIX);
}

function upsertDriveItem(ctx: SyncContext, d: DriveItem, now: number): void {
  const id = d.id;
  if (id === undefined || id === "") {
    return;
  }
  const title = typeof d.name === "string" && d.name !== "" ? d.name : `item_${id}`;
  const isFolder = d.folder !== undefined && d.folder !== null;
  const type = isFolder ? "folder" : "file";
  const url = typeof d.webUrl === "string" ? d.webUrl : null;
  const modified = modifiedMsFromIso(d.lastModifiedDateTime, now);
  const meta: Record<string, unknown> = {
    size: d.size,
    mimeType:
      d.file !== null &&
      d.file !== undefined &&
      typeof d.file === "object" &&
      !Array.isArray(d.file)
        ? (d.file as Record<string, unknown>)["mimeType"]
        : undefined,
  };

  const lmUser = d.lastModifiedBy?.user;
  const lmEmail = graphDriveUserMailbox(lmUser);
  const authorId =
    lmEmail === undefined
      ? null
      : ctx.resolvePerson({
          canonicalEmail: lmEmail,
          displayName:
            lmUser?.displayName !== undefined && lmUser.displayName !== ""
              ? lmUser.displayName
              : lmEmail,
        });

  ctx.upsertItem({
    service: SERVICE_ID,
    type,
    externalId: id,
    title: title.length > 512 ? title.slice(0, 512) : title,
    bodyPreview: "",
    url,
    canonicalUrl: url,
    modifiedAt: modified,
    authorId,
    metadata: meta,
    pinned: false,
    syncedAt: now,
  });
}

export type OneDriveSyncableOptions = {
  ensureMicrosoftMcpRunning: () => Promise<void>;
};

export function createOneDriveSyncable(options: OneDriveSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 30 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureMicrosoftMcpRunning();
      const token = await ctx.accessToken();

      let nextUrl: string | null = null;
      if (cursor !== null && cursor !== "") {
        const dec = decodeOneDriveSyncCursor(cursor);
        nextUrl = dec?.nextUrl ?? null;
      }

      const { json, bytes } = await fetchMicrosoftGraphJson(
        ctx,
        token,
        nextUrl,
        `${GRAPH}/me/drive/root/delta?$top=${String(PAGE_SIZE)}`,
        "OneDrive",
      );
      const parsed = parseODataDeltaPage(json);
      const values = (parsed.value ?? []) as DriveItem[];
      const now = Date.now();
      let upserted = 0;
      let deleted = 0;

      for (const item of values) {
        const removed = item["@removed"] !== undefined && item["@removed"] !== null;
        const id = item.id;
        if (removed && id !== undefined && id !== "") {
          ctx.deleteItem(SERVICE_ID, id);
          deleted += 1;
          continue;
        }
        if (item.deleted !== undefined && item.deleted?.state === "deleted") {
          if (id !== undefined && id !== "") {
            ctx.deleteItem(SERVICE_ID, id);
            deleted += 1;
          }
          continue;
        }
        upsertDriveItem(ctx, item, now);
        upserted += 1;
      }

      const { stored, hasMore } = nextCursorFromODataDeltaLinks(parsed, encodeOneDriveSyncCursor);

      return {
        cursor: stored,
        itemsUpserted: upserted,
        itemsDeleted: deleted,
        hasMore,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: bytes,
      };
    },
  };
}
