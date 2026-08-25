import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapStorybookStoryToItem, parseStorybookIndex } from "./storybook-story-mapping.ts";

// Local-only filesystem connector: indexes the Storybook manifest (index.json /
// stories.json) the user's `storybook build` writes to disk. No network.
const SERVICE_ID = "storybook";
const CURSOR_PREFIX = "nimbus-storybook1:";
const MAX_FILE_BYTES = 16 * 1024 * 1024;
// Candidate manifest filenames, in preference order (v7 first, then legacy v6).
const MANIFEST_NAMES = ["index.json", "stories.json"] as const;

type StorybookCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies StorybookCursorV1);
}

export type StorybookSyncableOptions = {
  ensureStorybookMcpRunning: () => Promise<void>;
};

async function loadDir(ctx: SyncContext): Promise<string | null> {
  const raw = (await ctx.getSecret("dir"))?.trim() ?? "";
  return raw === "" ? null : resolve(raw);
}

interface LoadedManifest {
  readonly parsed: unknown;
  readonly modifiedAtMs: number | null;
}

async function loadManifest(dir: string): Promise<LoadedManifest | null> {
  for (const name of MANIFEST_NAMES) {
    const path = join(dir, name);
    try {
      const buf = await readFile(path);
      if (buf.byteLength > MAX_FILE_BYTES) {
        return null;
      }
      const parsed = JSON.parse(buf.toString("utf8")) as unknown;
      let modifiedAtMs: number | null = null;
      try {
        const info = await stat(path);
        modifiedAtMs = Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
      } catch {
        modifiedAtMs = null;
      }
      return { parsed, modifiedAtMs };
    } catch {
      // Missing/oversized/unparseable — try the next candidate name.
    }
  }
  return null;
}

export function createStorybookSyncable(options: StorybookSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureStorybookMcpRunning();

      const dir = await loadDir(ctx);
      if (dir === null) {
        return syncNoopResult(cursor, t0);
      }

      await ctx.rateLimiter.acquire("filesystem");
      const manifest = await loadManifest(dir);
      if (manifest === null) {
        // No readable manifest yet (Storybook not built) — preserve the cursor.
        return syncPassCursorSuccess(t0, 0, pass1Cursor(), 0);
      }

      const now = Date.now();
      let upserted = 0;
      for (const story of parseStorybookIndex(manifest.parsed)) {
        const mapped = mapStorybookStoryToItem(story, {
          syncedAt: now,
          modifiedAtMs: manifest.modifiedAtMs,
        });
        if (mapped !== null) {
          ctx.upsertItem(mapped);
          upserted += 1;
        }
      }

      return syncPassCursorSuccess(t0, 0, pass1Cursor(), upserted);
    },
  };
}
