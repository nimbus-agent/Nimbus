import { encodeBasicAuthHeader } from "./mcp-tool-kit.ts";
import { stripTrailingSlashes } from "./strip-trailing-slashes.ts";

export function normalizeRequiredSiteBaseUrl(raw: string, emptyMessage: string): string {
  const t = stripTrailingSlashes(raw);
  if (t === "") {
    throw new Error(emptyMessage);
  }
  return t.startsWith("http") ? t : `https://${t}`;
}

export function requireTrimmedEnv(name: string, notSetMessage: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(notSetMessage);
  }
  return v.trim();
}

export async function fetchAtlassianBasicAuthJsonText(
  url: string,
  email: string,
  token: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: encodeBasicAuthHeader(email, token),
  };
  if (init?.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      ...headers,
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
