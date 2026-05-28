import type { SyncContext } from "../sync/types.ts";
import { UnauthenticatedError } from "../sync/types.ts";
import { asUnknownObjectRecord } from "./json-unknown.ts";

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function formatGoogleHttpError(status: number, bodyText: string, service: string): string {
  const base = `${service} sync failed: ${String(status)}`;
  const trimmed = bodyText.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    if (trimmed === "") {
      return base;
    }
    const oneLine = trimmed.replaceAll(/\s+/g, " ");
    return `${base} — ${truncate(oneLine, 160)}`;
  }
  const top = asUnknownObjectRecord(parsed);
  const errObj = top["error"];
  if (typeof errObj !== "object" || errObj === null || Array.isArray(errObj)) {
    const oneLine = trimmed.replaceAll(/\s+/g, " ");
    if (oneLine === "") return base;
    return `${base} — ${truncate(oneLine, 160)}`;
  }
  const er = errObj as Record<string, unknown>;
  const msg = er["message"];
  if (typeof msg === "string" && msg.trim() !== "") {
    const oneLine = msg.trim().replaceAll(/\s+/g, " ");
    return `${base} — ${truncate(oneLine, 240)}`;
  }
  return base;
}

export async function fetchGoogleJson(
  ctx: SyncContext,
  token: string,
  url: string,
  service: string,
  init?: RequestInit,
): Promise<{ json: unknown; bytes: number }> {
  await ctx.rateLimiter.acquire("google");
  const merged = new Headers({ Authorization: `Bearer ${token}` });
  if (init?.headers !== undefined) {
    for (const [k, v] of new Headers(init.headers)) {
      merged.set(k, v);
    }
  }
  const res = await fetch(url, { ...init, headers: merged });
  const text = await res.text();
  const bytes = Buffer.byteLength(text, "utf8");
  if (!res.ok) {
    const msg = formatGoogleHttpError(res.status, text, service);
    if (res.status === 401) {
      throw new UnauthenticatedError(msg);
    }
    throw new Error(msg);
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${service} sync failed: invalid JSON`);
  }
  return { json, bytes };
}
