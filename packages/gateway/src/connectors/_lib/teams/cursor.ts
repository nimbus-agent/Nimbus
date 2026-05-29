import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "../../nimbus-json-cursor.ts";

export const TEAMS_CURSOR_PREFIX = "nimbus-tms1:";

export type TeamsSyncCursorV1 = {
  v: 1;
  phase: "teams" | "channels" | "messages";
  teams: { id: string }[];
  teamsNext: string | null;
  channelTeamIdx: number;
  channelsByTeam: Record<string, string[]>;
  chanNext: string | null;
  pairs: { teamId: string; channelId: string }[];
  pairIdx: number;
  deltaByKey: Record<string, string | null>;
};

export function initialCursor(): TeamsSyncCursorV1 {
  return {
    v: 1,
    phase: "teams",
    teams: [],
    teamsNext: null,
    channelTeamIdx: 0,
    channelsByTeam: {},
    chanNext: null,
    pairs: [],
    pairIdx: 0,
    deltaByKey: {},
  };
}

function teamsCursorTeamsEntriesOk(teams: unknown): boolean {
  if (!Array.isArray(teams)) {
    return false;
  }
  for (const t of teams) {
    if (t === null || typeof t !== "object" || Array.isArray(t)) {
      return false;
    }
    const tr = t as Record<string, unknown>;
    if (typeof tr["id"] !== "string" || tr["id"] === "") {
      return false;
    }
  }
  return true;
}

function teamsCursorPairsEntriesOk(pairs: unknown): boolean {
  if (!Array.isArray(pairs)) {
    return false;
  }
  for (const p of pairs) {
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      return false;
    }
    const pr = p as Record<string, unknown>;
    if (typeof pr["teamId"] !== "string" || typeof pr["channelId"] !== "string") {
      return false;
    }
  }
  return true;
}

function teamsCursorDeltaValuesOk(deltaByKey: unknown): boolean {
  if (deltaByKey === null || typeof deltaByKey !== "object" || Array.isArray(deltaByKey)) {
    return false;
  }
  for (const v of Object.values(deltaByKey as Record<string, unknown>)) {
    if (v !== null && typeof v !== "string") {
      return false;
    }
  }
  return true;
}

function isTeamsCursorV1(o: unknown): o is TeamsSyncCursorV1 {
  if (o === null || typeof o !== "object" || Array.isArray(o)) {
    return false;
  }
  const r = o as Record<string, unknown>;
  if (r["v"] !== 1) {
    return false;
  }
  const phase = r["phase"];
  if (phase !== "teams" && phase !== "channels" && phase !== "messages") {
    return false;
  }
  if (!teamsCursorTeamsEntriesOk(r["teams"])) {
    return false;
  }
  const teamsNext = r["teamsNext"];
  if (teamsNext !== null && typeof teamsNext !== "string") {
    return false;
  }
  const channelTeamIdx = r["channelTeamIdx"];
  if (
    typeof channelTeamIdx !== "number" ||
    !Number.isInteger(channelTeamIdx) ||
    channelTeamIdx < 0
  ) {
    return false;
  }
  const channelsByTeam = r["channelsByTeam"];
  if (
    channelsByTeam === null ||
    typeof channelsByTeam !== "object" ||
    Array.isArray(channelsByTeam)
  ) {
    return false;
  }
  const chanNext = r["chanNext"];
  if (chanNext !== null && typeof chanNext !== "string") {
    return false;
  }
  if (!teamsCursorPairsEntriesOk(r["pairs"])) {
    return false;
  }
  const pairIdx = r["pairIdx"];
  if (typeof pairIdx !== "number" || !Number.isInteger(pairIdx) || pairIdx < 0) {
    return false;
  }
  return teamsCursorDeltaValuesOk(r["deltaByKey"]);
}

export function parseCursor(raw: string | null): TeamsSyncCursorV1 {
  if (raw === null || raw === "") {
    return initialCursor();
  }
  const o = decodeNimbusJsonCursorPayload(raw, TEAMS_CURSOR_PREFIX);
  if (isTeamsCursorV1(o)) {
    return o;
  }
  return initialCursor();
}

export function encodeTeamsSyncCursor(c: TeamsSyncCursorV1): string {
  return encodeNimbusJsonCursor(TEAMS_CURSOR_PREFIX, c);
}

export function decodeTeamsSyncCursor(raw: string): TeamsSyncCursorV1 | undefined {
  const o = decodeNimbusJsonCursorPayload(raw, TEAMS_CURSOR_PREFIX);
  return isTeamsCursorV1(o) ? o : undefined;
}
