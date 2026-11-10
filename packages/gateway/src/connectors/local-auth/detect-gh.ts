import { join } from "node:path";

import { JSON_SCHEMA, load } from "js-yaml";

import { normaliseGithubApiBase } from "../github-api-base.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";
import type { GhFinding } from "./local-auth-types.ts";

export const GITHUB_DOTCOM = "github.com";

/**
 * The GitHub Enterprise Server API base a `hosts.yml` host name would be connected as, through the
 * SAME validator `--api-base` uses. A `hosts.yml` key is data from a file, so it must be exactly a
 * bare host: anything the validator normalises into something else (a path, a scheme, a
 * trailing dot, an upper-case spelling) is refused rather than trusted.
 */
export function ghesBaseForHost(
  host: string,
): { readonly ok: true; readonly base: string } | { readonly ok: false; readonly reason: string } {
  const n = normaliseGithubApiBase(`https://${host}`);
  if (!n.ok) return n;
  if (n.host !== host.toLowerCase()) {
    return { ok: false, reason: "the host is not a plain GitHub Enterprise Server host name" };
  }
  return { ok: true, base: n.base };
}

function nonEmpty(v: string | undefined): v is string {
  return v !== undefined && v.trim() !== "";
}

/** gh's own order: GH_CONFIG_DIR, XDG_CONFIG_HOME/gh, %AppData%\GitHub CLI (Windows), ~/.config/gh. */
export function ghConfigDir(deps: LocalAuthHostDeps): string {
  const explicit = deps.env["GH_CONFIG_DIR"];
  if (nonEmpty(explicit)) return explicit;
  const xdg = deps.env["XDG_CONFIG_HOME"];
  if (nonEmpty(xdg)) return join(xdg, "gh");
  const appData = deps.env["APPDATA"];
  if (deps.platform === "win32" && nonEmpty(appData)) return join(appData, "GitHub CLI");
  return join(deps.homeDir, ".config", "gh");
}

export interface GhHostEntry {
  readonly host: string;
  readonly accounts: readonly string[];
  readonly activeAccount: string | null;
  readonly multiAccount: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * `hosts.yml` → per-host account NAMES. Reads only `user` and the keys of `users`; an
 * `oauth_token` field (legacy plaintext storage) is never copied into the result.
 */
export function parseGhHosts(text: string): GhHostEntry[] {
  let doc: unknown;
  try {
    doc = load(text, { schema: JSON_SCHEMA });
  } catch {
    return [];
  }
  if (!isRecord(doc)) return [];
  const out: GhHostEntry[] = [];
  for (const [hostName, raw] of Object.entries(doc)) {
    if (!isRecord(raw)) continue;
    const user = raw["user"];
    const active = typeof user === "string" && user.trim() !== "" ? user.trim() : null;
    const users = raw["users"];
    const multi = isRecord(users);
    // Multi-account hosts list every account under `users:`; single-account ones name one `user:`.
    const singleAccount = active === null ? [] : [active];
    const accounts = multi ? Object.keys(users) : singleAccount;
    out.push({ host: hostName, accounts, activeAccount: active, multiAccount: multi });
  }
  return out;
}

function blank(status: GhFinding["status"], reason: string, alreadyConfigured: boolean): GhFinding {
  return {
    source: "gh",
    host: GITHUB_DOTCOM,
    accounts: [],
    activeAccount: null,
    multiAccount: false,
    status,
    reason,
    alreadyConfigured,
  };
}

/**
 * Local-only: reads `hosts.yml`, spawns NOTHING. (`gh auth status` would validate the token
 * against the GitHub API — an egress detection must not make.)
 */
export function detectGh(deps: LocalAuthHostDeps, alreadyConfigured: boolean): GhFinding[] {
  if (!deps.which("gh")) {
    return [blank("cli_not_found", "gh is not installed (not found on PATH)", alreadyConfigured)];
  }
  const path = join(ghConfigDir(deps), "hosts.yml");
  const text = deps.readFile(path);
  const entries = text === null ? [] : parseGhHosts(text);
  if (entries.length === 0) {
    return [
      blank(
        "not_logged_in",
        `gh has no login recorded in ${path} — run: gh auth login`,
        alreadyConfigured,
      ),
    ];
  }
  return entries.map((e): GhFinding => {
    const base = {
      source: "gh" as const,
      host: e.host,
      accounts: e.accounts,
      activeAccount: e.activeAccount,
      multiAccount: e.multiAccount,
    };
    if (e.host !== GITHUB_DOTCOM) {
      const ghes = ghesBaseForHost(e.host);
      if (!ghes.ok) {
        return { ...base, status: "unsupported", reason: ghes.reason, alreadyConfigured: false };
      }
      if (e.accounts.length === 0) {
        return {
          ...base,
          status: "not_logged_in",
          reason: `gh lists ${e.host} with no account — run: gh auth login --hostname ${e.host}`,
          alreadyConfigured,
        };
      }
      return { ...base, status: "available", alreadyConfigured };
    }
    if (e.accounts.length === 0) {
      return {
        ...base,
        status: "not_logged_in",
        reason: "gh lists github.com with no account — run: gh auth login",
        alreadyConfigured,
      };
    }
    return { ...base, status: "available", alreadyConfigured };
  });
}
