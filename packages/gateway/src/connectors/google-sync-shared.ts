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

/** A non-401 HTTP failure from a Google API, carrying the status so a caller can tell a 429 from a 403. */
export class GoogleHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GoogleHttpError";
  }
}

async function fetchGoogleOk(
  ctx: SyncContext,
  token: string,
  url: string,
  service: string,
  init?: RequestInit,
): Promise<{ text: string; bytes: number }> {
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
    throw new GoogleHttpError(msg, res.status);
  }
  return { text, bytes };
}

export async function fetchGoogleJson(
  ctx: SyncContext,
  token: string,
  url: string,
  service: string,
  init?: RequestInit,
): Promise<{ json: unknown; bytes: number }> {
  const { text, bytes } = await fetchGoogleOk(ctx, token, url, service, init);
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${service} sync failed: invalid JSON`);
  }
  return { json, bytes };
}

const BYTE_ORDER_MARK = String.fromCodePoint(0xfe_ff);

/**
 * A plain-text response through the same rate limiter and 401 handling as `fetchGoogleJson` — the
 * Drive export endpoint (`files/{id}/export?mimeType=text/plain`). Google prefixes that export with
 * a UTF-8 byte-order mark, which is dropped so it never becomes the first character of a body.
 */
export async function fetchGoogleText(
  ctx: SyncContext,
  token: string,
  url: string,
  service: string,
): Promise<{ text: string; bytes: number }> {
  const { text, bytes } = await fetchGoogleOk(ctx, token, url, service);
  return { text: text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text, bytes };
}
