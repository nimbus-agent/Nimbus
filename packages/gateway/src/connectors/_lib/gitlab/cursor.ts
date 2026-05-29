import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "../../nimbus-json-cursor.ts";

const CURSOR_PREFIX = "nimbus-glab1:";

export type GitlabSyncCursorV2 = {
  v: 2;
  after: string;
  page: number;
  pipelines: Record<string, number>;
};

function parsePipelineCursorMap(raw: unknown): Record<string, number> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = Math.floor(v);
    }
  }
  return out;
}

export function encodeGitlabCursor(c: GitlabSyncCursorV2): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

export function decodeGitlabCursor(raw: string | null): GitlabSyncCursorV2 | null {
  if (raw === null || raw === "") {
    return null;
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (parsed === undefined) {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const rec = parsed as Record<string, unknown>;
  const after = rec["after"];
  const page = rec["page"];
  if (typeof after !== "string" || after === "") {
    return null;
  }
  const p = typeof page === "number" && Number.isInteger(page) && page >= 1 ? page : 1;
  if (rec["v"] === 2) {
    return { v: 2, after, page: p, pipelines: parsePipelineCursorMap(rec["pipelines"]) };
  }
  return { v: 2, after, page: p, pipelines: {} };
}
