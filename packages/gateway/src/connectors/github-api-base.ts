// packages/gateway/src/connectors/github-api-base.ts

import { isLoopbackHost } from "../llm/base-url-locality.ts";

/**
 * The ONE place a GitHub Enterprise Server API base is validated and a stored one is resolved.
 *
 * The PAT is sent to this host on every request, and the connector itself accepts an `http:` base
 * with no credential, path or host checks, so the gateway is the only place those rules can be
 * enforced. Every refusal reason is fixed text that never echoes the input: the value is
 * Vault-stored and error text reaches logs and IPC.
 */

export const GITHUB_DEFAULT_REST_ROOT = "https://api.github.com";
export const GITHUB_DEFAULT_WEB_ORIGIN = "https://github.com";

export type NormalisedGithubApiBase =
  | { readonly ok: true; readonly base: string; readonly host: string }
  | { readonly ok: false; readonly reason: string };

const REASON_EMPTY = "the GitHub Enterprise Server URL is empty";
const REASON_SYNTAX = "the GitHub Enterprise Server URL is not a valid URL";
const REASON_HTTPS = "the GitHub Enterprise Server URL must use https";
const REASON_CREDENTIALS = "the GitHub Enterprise Server URL must not contain credentials";
const REASON_QUERY = "the GitHub Enterprise Server URL must not contain a query or fragment";
const REASON_PATH = "the GitHub Enterprise Server URL path must be empty or /api/v3";
const REASON_IPV6 = "an IPv6 literal is not supported as a GitHub Enterprise Server host";
const REASON_LOCAL = "a loopback, unspecified or link-local host is not allowed";
const REASON_SAAS = "that is the default GitHub API; omit the base to use github.com";
const REASON_GHE_COM = "GHE.com (data residency) is not supported";

// ASCII control characters and whitespace anywhere in the value.
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_OR_SPACE = /[\u0000- \u007f]/;

function isUnspecifiedOrLinkLocal(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (m === null) return false;
  // 0.0.0.0/8 ("this network", incl. 0.0.0.0) and 169.254.0.0/16 (link-local, cloud metadata).
  return Number.parseInt(m[1] ?? "", 10) === 0 || (m[1] === "169" && m[2] === "254");
}

/** `localhost` and any `*.localhost` name (RFC 6761: always loopback). */
function isLocalhostName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

function canonicalHost(hostname: string): string {
  let h = hostname.toLowerCase();
  while (h.endsWith(".")) {
    h = h.slice(0, -1);
  }
  return h;
}

function refuseHost(host: string): string | null {
  if (host === "") return REASON_SYNTAX;
  if (host.startsWith("[")) return REASON_IPV6;
  if (isLoopbackHost(host) || isLocalhostName(host) || isUnspecifiedOrLinkLocal(host)) {
    return REASON_LOCAL;
  }
  if (host === "github.com" || host === "api.github.com") return REASON_SAAS;
  if (host.endsWith(".ghe.com")) return REASON_GHE_COM;
  return null;
}

/**
 * Accepts `https://ghe.example.com[:port]` with an optional `/` or `/api/v3[/]` path and returns
 * the canonical `https://<host>[:port]/api/v3`. The host is canonicalised (lower-cased, trailing
 * dots stripped, IDN as punycode by the WHATWG parser) BEFORE any host refusal runs, so the
 * refusal and the sandbox network grant see the same string.
 */
export function normaliseGithubApiBase(raw: string): NormalisedGithubApiBase {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: REASON_EMPTY };
  if (CONTROL_OR_SPACE.test(trimmed)) return { ok: false, reason: REASON_SYNTAX };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: REASON_SYNTAX };
  }
  if (url.protocol !== "https:") return { ok: false, reason: REASON_HTTPS };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: REASON_CREDENTIALS };
  }
  if (trimmed.includes("?") || trimmed.includes("#")) return { ok: false, reason: REASON_QUERY };
  if (url.pathname !== "/" && url.pathname !== "/api/v3" && url.pathname !== "/api/v3/") {
    return { ok: false, reason: REASON_PATH };
  }
  const hostname = canonicalHost(url.hostname);
  const refusal = refuseHost(hostname);
  if (refusal !== null) return { ok: false, reason: refusal };
  const host = url.port === "" ? hostname : `${hostname}:${url.port}`;
  return { ok: true, base: `https://${host}/api/v3`, host };
}

export type ResolvedGithubBase =
  | {
      readonly ok: true;
      /** The REST root requests are made against (no trailing slash). */
      readonly restRoot: string;
      /** The origin the instance's web URLs (`html_url`) live on. */
      readonly webOrigin: string;
      /** The GHES `host[:port]`, or `null` for github.com. */
      readonly host: string | null;
    }
  | { readonly ok: false };

/** The usable arm of {@link ResolvedGithubBase}. */
export type ValidGithubBase = Extract<ResolvedGithubBase, { ok: true }>;

/** github.com, for callers (and tests) that need the default as a value. */
export const GITHUB_DOTCOM_BASE: ValidGithubBase = {
  ok: true,
  restRoot: GITHUB_DEFAULT_REST_ROOT,
  webOrigin: GITHUB_DEFAULT_WEB_ORIGIN,
  host: null,
};

/**
 * Resolves the stored `github.api_base`. ABSENT (null/undefined) means github.com. PRESENT but
 * not valid FAILS CLOSED (`ok: false`): the PAT stored beside a GHES base is an enterprise
 * credential, so a bad base must never fall back to api.github.com. Every consumer uses this
 * helper; none calls `normaliseGithubApiBase` with a default of its own.
 */
export function resolveGithubBase(raw: string | null | undefined): ResolvedGithubBase {
  if (raw === null || raw === undefined) {
    return {
      ok: true,
      restRoot: GITHUB_DEFAULT_REST_ROOT,
      webOrigin: GITHUB_DEFAULT_WEB_ORIGIN,
      host: null,
    };
  }
  const n = normaliseGithubApiBase(raw);
  if (!n.ok) return { ok: false };
  return {
    ok: true,
    restRoot: n.base,
    webOrigin: `https://${n.host}`,
    host: n.host,
  };
}

export type GithubCredentialPair =
  | {
      readonly kind: "ok";
      /** The stored PAT, or `null` when none is stored (the caller treats that as unconfigured). */
      readonly pat: string | null;
      readonly base: ValidGithubBase;
    }
  /** The stored base is present but invalid (fail closed; never api.github.com). */
  | { readonly kind: "invalid" }
  /** The stored base changed while the pair was being read; make no request this pass. */
  | { readonly kind: "unstable" };

/**
 * The ONE reader of a GitHub credential PAIR (`github.pat` + `github.api_base`). Every reader that
 * sends the PAT somewhere (sync, fetchOne, github-actions sync, the connector spawn) uses it.
 *
 * Why the order is base, PAT, base again: a re-auth (`connectorAuthGithub`) deletes the PAT, writes
 * the new base, and writes the new PAT LAST. So a NEW PAT can only be observed once the new base is
 * already stored. If a reader sees the same base string before and after reading the PAT, no
 * re-auth finished between the two base reads, and the PAT it holds therefore belongs to that base
 * (an old PAT is read only while the old base is still stored; a new one only after the new base).
 * If the two base reads differ, a re-auth landed in the window and the pair may be mismatched, so
 * the result is `unstable`: the reader makes no request this pass and the next pass retries.
 * `getSecret` is called with `"api_base"` and `"pat"`; an empty-string value is passed through.
 */
export async function readGithubCredentialPair(
  getSecret: (key: "pat" | "api_base") => Promise<string | null | undefined>,
): Promise<GithubCredentialPair> {
  const baseBefore = (await getSecret("api_base")) ?? null;
  const pat = (await getSecret("pat")) ?? null;
  const baseAfter = (await getSecret("api_base")) ?? null;
  if (baseBefore !== baseAfter) return { kind: "unstable" };
  const base = resolveGithubBase(baseBefore);
  if (!base.ok) return { kind: "invalid" };
  return { kind: "ok", pat, base };
}
