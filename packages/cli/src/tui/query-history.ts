import { readFile, writeFile } from "node:fs/promises";

import { QUERY_HISTORY_CAP } from "./constants.ts";

interface HistoryFile {
  entries: string[];
}

function isHistoryFile(value: unknown): value is HistoryFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v["entries"])) {
    return false;
  }
  return v["entries"].every((item): item is string => typeof item === "string");
}

export async function readHistory(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isHistoryFile(parsed)) {
    return [];
  }
  return parsed.entries;
}

export async function appendQuery(path: string, query: string): Promise<void> {
  if (query.trim() === "") {
    return;
  }
  const current = await readHistory(path);
  if (current.at(-1) === query) {
    return;
  }
  const next = [...current, query];
  const trimmed = next.length > QUERY_HISTORY_CAP ? next.slice(-QUERY_HISTORY_CAP) : next;
  const body = JSON.stringify({ entries: trimmed });
  await writeFile(path, body, { encoding: "utf-8" });
}
