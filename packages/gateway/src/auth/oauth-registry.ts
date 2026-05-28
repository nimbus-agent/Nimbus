import { validateVaultKeyOrThrow } from "../vault/key-format.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export type OAuthProvider = "google" | "microsoft" | "slack" | "notion";

export interface PKCEResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export type RegistryFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface AuthorizeArgs {
  clientId: string;
  scopes: string[];
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

type ClientSecretMode = "none" | "optional" | "required";

export interface OAuthProviderDescriptor {
  id: OAuthProvider;
  vaultKey: string;
  authorizeUrl: string;
  tokenUrl: string;
  usesPkce: boolean;
  clientSecret: ClientSecretMode;
  secretPlacement: "body" | "basic_header";
  bodyFormat: "form" | "json";
  tokenHeaders?: Readonly<Record<string, string>>;
  mirrorPerService: boolean;
  buildAuthorizeParams(a: AuthorizeArgs): Record<string, string>;
  parseTokenResponse(json: unknown, requestedScopes: string[]): PKCEResult;
  isTokenSuccess?(json: unknown, httpOk: boolean): boolean;
}

type OAuthTokenJson = {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
};

function parseExpiresInSeconds(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number.parseInt(raw, 10);
  return Number.NaN;
}

function scopesFromTokenResponse(scopeField: string | undefined, requested: string[]): string[] {
  if (scopeField !== undefined && scopeField.trim() !== "") {
    return scopeField.split(/\s+/).filter((s) => s.length > 0);
  }
  return requested;
}

/** Standard OAuth2 form-token response → PKCEResult (google/microsoft/zoom). */
export function parseStandardTokenResponse(json: unknown, requested: string[]): PKCEResult {
  if (json === null || typeof json !== "object") {
    throw new Error("Token response was not valid JSON");
  }
  const o = json as OAuthTokenJson;
  const access = o.access_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new Error("Token response missing access_token");
  }
  const expiresIn = parseExpiresInSeconds(o.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn < 0) {
    throw new Error("Token response missing expires_in");
  }
  const refresh = o.refresh_token;
  const scope = typeof o.scope === "string" ? o.scope : undefined;
  return {
    accessToken: access,
    refreshToken: typeof refresh === "string" ? refresh : "",
    expiresAt: Date.now() + Math.floor(expiresIn * 1000),
    scopes: scopesFromTokenResponse(scope, requested),
  };
}

export function parseSlackTokenResponse(json: unknown, requested: string[]): PKCEResult {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Invalid Slack OAuth response");
  }
  const au = (json as Record<string, unknown>)["authed_user"];
  if (au === null || typeof au !== "object" || Array.isArray(au)) {
    throw new Error("Slack OAuth response missing authed_user");
  }
  const user = au as Record<string, unknown>;
  const access = user["access_token"];
  if (typeof access !== "string" || access === "") {
    throw new Error("Slack user access token missing");
  }
  const refresh = user["refresh_token"];
  const refreshTok = typeof refresh === "string" && refresh !== "" ? refresh : "";
  if (refreshTok === "") {
    throw new Error(
      "Slack refresh token missing; enable token rotation on the Slack app and re-authorize",
    );
  }
  const expIn = user["expires_in"];
  let expiresSec = Number.NaN;
  if (typeof expIn === "number" && Number.isFinite(expIn)) expiresSec = expIn;
  else if (typeof expIn === "string") expiresSec = Number.parseInt(expIn, 10);
  const safeExpires = Number.isFinite(expiresSec) && expiresSec > 0 ? expiresSec : 43_200;
  const scopeStr = user["scope"];
  const scopes =
    typeof scopeStr === "string" && scopeStr.trim() !== ""
      ? scopeStr
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : requested;
  return {
    accessToken: access,
    refreshToken: refreshTok,
    expiresAt: Date.now() + Math.floor(safeExpires * 1000),
    scopes,
  };
}

export function parseNotionTokenResponse(json: unknown, requested: string[]): PKCEResult {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Notion token response invalid");
  }
  const o = json as { access_token?: unknown; refresh_token?: unknown };
  const access = o.access_token;
  if (typeof access !== "string" || access === "") {
    throw new Error("Notion token response missing access_token");
  }
  const refresh = o.refresh_token;
  const refreshStr = typeof refresh === "string" && refresh !== "" ? refresh : "";
  return {
    accessToken: access,
    refreshToken: refreshStr,
    expiresAt: Date.now() + 86_400 * 1000,
    scopes: requested,
  };
}

export const OAUTH_PROVIDERS: Record<OAuthProvider, OAuthProviderDescriptor> = {
  google: {
    id: "google",
    vaultKey: "google.oauth",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    usesPkce: true,
    clientSecret: "optional",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: true,
    buildAuthorizeParams: (a) => ({
      client_id: a.clientId,
      redirect_uri: a.redirectUri,
      response_type: "code",
      scope: a.scopes.join(" "),
      state: a.state,
      ...(a.codeChallenge !== undefined
        ? { code_challenge: a.codeChallenge, code_challenge_method: "S256" }
        : {}),
      access_type: "offline",
      prompt: "consent",
    }),
    parseTokenResponse: parseStandardTokenResponse,
  },
  microsoft: {
    id: "microsoft",
    vaultKey: "microsoft.oauth",
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    usesPkce: true,
    clientSecret: "none",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: true,
    buildAuthorizeParams: (a) => ({
      client_id: a.clientId,
      redirect_uri: a.redirectUri,
      response_type: "code",
      scope: a.scopes.join(" "),
      state: a.state,
      ...(a.codeChallenge !== undefined
        ? { code_challenge: a.codeChallenge, code_challenge_method: "S256" }
        : {}),
    }),
    parseTokenResponse: parseStandardTokenResponse,
  },
  slack: {
    id: "slack",
    vaultKey: "slack.oauth",
    authorizeUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    usesPkce: true,
    clientSecret: "none",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: (a) => ({
      client_id: a.clientId,
      user_scope: a.scopes.join(","),
      redirect_uri: a.redirectUri,
      state: a.state,
      scope: "",
      ...(a.codeChallenge !== undefined
        ? { code_challenge: a.codeChallenge, code_challenge_method: "S256" }
        : {}),
    }),
    parseTokenResponse: parseSlackTokenResponse,
    isTokenSuccess: (json) =>
      json !== null && typeof json === "object" && (json as { ok?: unknown }).ok === true,
  },
  notion: {
    id: "notion",
    vaultKey: "notion.oauth",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "basic_header",
    bodyFormat: "json",
    tokenHeaders: { "Notion-Version": "2022-06-28" },
    mirrorPerService: false,
    buildAuthorizeParams: (a) => ({
      client_id: a.clientId,
      redirect_uri: a.redirectUri,
      response_type: "code",
      owner: "user",
      state: a.state,
    }),
    parseTokenResponse: parseNotionTokenResponse,
  },
};

export type { NimbusVault };
export { validateVaultKeyOrThrow };
