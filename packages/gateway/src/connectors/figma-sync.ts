import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { mapFigmaFileToItem } from "./figma-file-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "figma";
const CURSOR_PREFIX = "nimbus-figma1:";
const BASE = "https://api.figma.com";
// Defensive per-cycle caps. Neither Figma endpoint paginates with a cursor —
// both return the full list — so these bounds are the only safety net against
// a runaway team with thousands of projects/files.
const MAX_PROJECTS = 200;
const MAX_FILES = 2000;

type FigmaCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies FigmaCursorV1);
}

export type FigmaSyncableOptions = {
  ensureFigmaMcpRunning: () => Promise<void>;
};

interface FigmaProject {
  readonly id: string;
  readonly name: string;
}

function figmaGet(ctx: SyncContext, token: string, path: string): Promise<FetchOutcome> {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
}

/** Coerce a Figma project id (string or number) to a string; `""` when neither. */
function projectIdOf(idRaw: unknown): string {
  if (typeof idRaw === "string") {
    return idRaw;
  }
  return typeof idRaw === "number" ? String(idRaw) : "";
}

function extractProjects(parsed: unknown): FigmaProject[] {
  const projects = asRecord(parsed)?.["projects"];
  if (!Array.isArray(projects)) {
    return [];
  }
  const out: FigmaProject[] = [];
  for (const p of projects) {
    const rec = asRecord(p);
    if (rec === undefined) {
      continue;
    }
    const id = projectIdOf(rec["id"]);
    if (id === "") {
      continue;
    }
    out.push({ id, name: stringField(rec, "name") ?? "" });
  }
  return out;
}

function extractFiles(parsed: unknown): unknown[] {
  const files = asRecord(parsed)?.["files"];
  return Array.isArray(files) ? files : [];
}

function upsertFiles(
  ctx: SyncContext,
  files: readonly unknown[],
  projectName: string | null,
  now: number,
  budget: { remaining: number },
): number {
  let upserted = 0;
  for (const f of files) {
    if (budget.remaining <= 0) {
      break;
    }
    const mapped = mapFigmaFileToItem(f, { syncedAt: now, projectName });
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
    budget.remaining -= 1;
  }
  return upserted;
}

export function createFigmaSyncable(options: FigmaSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureFigmaMcpRunning();

      // Both keys must be present for the connector to sync: the OAuth token and
      // the non-secret team id selecting which team's files to index.
      const oauthRaw = await ctx.getSecret("oauth");
      const teamId = (await ctx.getSecret("team_id"))?.trim() ?? "";
      if (oauthRaw === null || oauthRaw === "" || teamId === "") {
        return syncNoopResult(cursor, t0);
      }
      let token: string;
      try {
        token = await ctx.accessToken();
      } catch {
        return syncNoopResult(cursor, t0);
      }
      if (token === "") {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;

      // Level 1: the team's projects. A failure here preserves the incoming
      // cursor (first-page http error) and degrades gracefully.
      const projectsPath = `/v1/teams/${encodeURIComponent(teamId)}/projects`;
      const projectsOutcome = await figmaGet(ctx, token, projectsPath);
      totalBytes += projectsOutcome.bytes;
      if (projectsOutcome.kind !== "ok") {
        return projectsOutcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
      }

      const projects = extractProjects(projectsOutcome.parsed).slice(0, MAX_PROJECTS);

      // Level 2: each project's files, flattened. A mid-walk error keeps what we
      // already upserted and stops without throwing.
      const fileBudget = { remaining: MAX_FILES };
      let totalUpserted = 0;
      for (const project of projects) {
        if (fileBudget.remaining <= 0) {
          break;
        }
        const filesPath = `/v1/projects/${encodeURIComponent(project.id)}/files`;
        const filesOutcome = await figmaGet(ctx, token, filesPath);
        totalBytes += filesOutcome.bytes;
        if (filesOutcome.kind !== "ok") {
          // Skip this project, continue with the rest — partial coverage beats none.
          continue;
        }
        const files = extractFiles(filesOutcome.parsed);
        totalUpserted += upsertFiles(
          ctx,
          files,
          project.name === "" ? null : project.name,
          now,
          fileBudget,
        );
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
