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

/** RFC 7230 `token`: the only characters an HTTP header field name may contain. */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Whether `name` is safe to use as a header field name.
 *
 * The crumb field name is chosen by the REMOTE Jenkins (`crumbRequestField` in the crumb-issuer
 * response), so it is attacker-controlled input on a compromised or hostile server — and it lands
 * in a computed property write. Two things are refused:
 *
 *  - anything that is not an RFC 7230 token, which is what stops a name carrying `:` or CR/LF from
 *    injecting extra headers into an authenticated POST;
 *  - `__proto__` / `constructor` / `prototype`, which reach `Object.prototype` through a computed
 *    assignment rather than creating an own property.
 *
 * No real crumb field is named any of those, so nothing legitimate is lost.
 */
export function isSafeHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower === "__proto__" || lower === "constructor" || lower === "prototype") {
    return false;
  }
  return HEADER_NAME_RE.test(name);
}

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
  // A field name the crumb cannot legally carry is treated exactly like a missing one: no crumb.
  // The POST then goes out without it and Jenkins answers 403, which is the safe outcome — far
  // better than letting the server name an arbitrary header on our authenticated request.
  if (crumb === "" || !isSafeHeaderName(field)) {
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
  // Guarded again at the sink, not only where the crumb is parsed: this function is exported and
  // takes the crumb as an argument, so the write below must be safe for any caller, not only for
  // one that went through `getJenkinsCrumb`.
  if (crumb !== null && isSafeHeaderName(crumb.field)) {
    headers[crumb.field] = crumb.value;
  }
  const res = await fetch(url, { method: "POST", headers });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text };
}
