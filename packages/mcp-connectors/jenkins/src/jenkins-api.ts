import { encodeBasicAuthHeader } from "../../shared/mcp-tool-kit.ts";
import { stripTrailingSlashes } from "../../shared/strip-trailing-slashes.ts";

export function jenkinsBaseUrl(): string {
  const raw = process.env["JENKINS_BASE_URL"]?.trim() ?? "";
  if (raw === "") {
    throw new Error("JENKINS_BASE_URL is not set");
  }
  return stripTrailingSlashes(raw);
}

export function jenkinsAuthHeader(): string {
  const user = process.env["JENKINS_USERNAME"]?.trim() ?? "";
  const token = process.env["JENKINS_API_TOKEN"]?.trim() ?? "";
  if (user === "" || token === "") {
    throw new Error("JENKINS_USERNAME and JENKINS_API_TOKEN must be set");
  }
  return encodeBasicAuthHeader(user, token);
}

export type JenkinsCrumb = { field: string; value: string };

let crumbCache: JenkinsCrumb | null | undefined;

export function __resetJenkinsCrumbCacheForTests(): void {
  crumbCache = undefined;
}

export async function getJenkinsCrumb(
  base: string,
  authHeader: string,
): Promise<JenkinsCrumb | null> {
  if (crumbCache !== undefined) {
    return crumbCache;
  }
  const res = await fetch(`${base}/crumbIssuer/api/json`, {
    headers: { Authorization: authHeader, Accept: "application/json" },
  });
  if (!res.ok) {
    crumbCache = null;
    return null;
  }
  let parsed: unknown;
  try {
    parsed = (await res.json()) as unknown;
  } catch {
    crumbCache = null;
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    crumbCache = null;
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const crumb = typeof o["crumb"] === "string" ? o["crumb"] : "";
  const field = typeof o["crumbRequestField"] === "string" ? o["crumbRequestField"] : "";
  if (crumb === "" || field === "") {
    crumbCache = null;
    return null;
  }
  crumbCache = { field, value: crumb };
  return crumbCache;
}

export function jobPathFromFullName(fullName: string): string {
  const segs = fullName
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segs.length === 0) {
    throw new Error("job fullName is empty");
  }
  return segs.map((s) => encodeURIComponent(s)).join("/job/");
}

export function jobApiRoot(base: string, fullName: string): string {
  return `${base}/job/${jobPathFromFullName(fullName)}`;
}

export async function jenkinsFetchJson(
  url: string,
  init: RequestInit & { authHeader: string },
): Promise<{ ok: boolean; status: number; text: string; json: unknown }> {
  const { authHeader, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
      ...(rest.headers as Record<string, string>),
    },
  });
  const text = await res.text();
  let parsedBody: unknown = null;
  try {
    parsedBody = JSON.parse(text) as unknown;
  } catch {
    parsedBody = null;
  }
  return { ok: res.ok, status: res.status, text, json: parsedBody };
}

export async function jenkinsPost(
  url: string,
  authHeader: string,
  crumb: JenkinsCrumb | null,
): Promise<{ ok: boolean; status: number; text: string }> {
  const headers: Record<string, string> = {
    Authorization: authHeader,
  };
  if (crumb !== null) {
    headers[crumb.field] = crumb.value;
  }
  const res = await fetch(url, { method: "POST", headers });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
