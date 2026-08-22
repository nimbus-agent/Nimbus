import { validateVaultKeyOrThrow } from "../vault/key-format.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { parseStoredOAuthTokens } from "./oauth-vault-payload.ts";

export type OAuthProvider =
  | "google"
  | "microsoft"
  | "slack"
  | "notion"
  | "zoom"
  | "hubspot"
  | "miro"
  | "canva"
  | "figma"
  | "salesforce"
  | "mendeley"
  | "workday";

export interface PKCEResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  /**
   * Per-tenant API host discovered at OAuth time (Salesforce's `instance_url`).
   * Optional and undefined for every provider with a fixed SaaS API host.
   */
  instanceUrl?: string;
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
  /**
   * Set when `buildAuthorizeParams` asks the provider for offline access — i.e. this provider
   * is expected to return a `refresh_token` on the AUTHORIZATION-CODE exchange, and a stored
   * credential without one can never be refreshed.
   *
   * `revokeUrl` is where the user has to go to make the provider issue a new one. It is not
   * decoration: Google re-issues a refresh token only after the prior grant is revoked, so
   * "run `nimbus connector auth` again" — the obvious instruction — is precisely the one that
   * does not work, and the user in the F10 report re-authed repeatedly to no effect.
   *
   * A provider that never requests offline access leaves this unset; requiring a refresh token
   * of it would invent a failure. `offline-refresh-token.test.ts` derives the expected value
   * from `buildAuthorizeParams` so the two cannot drift.
   */
  offlineAccess?: { readonly revokeUrl: string };
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

function parseSlackTokenResponse(json: unknown, requested: string[]): PKCEResult {
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

function parseNotionTokenResponse(json: unknown, requested: string[]): PKCEResult {
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

// Default Salesforce access-token lifetime when the token response omits
// `expires_in`. Salesforce does NOT return `expires_in`; its actual session
// timeout is org-configured and frequently short. A conservative 30-minute
// window means the registry's proactive single-flight refresh (REFRESH_MARGIN
// 120 s) renews the access token roughly every sync cycle using the long-lived
// refresh token — robust against short org session timeouts.
const SALESFORCE_DEFAULT_EXPIRY_MS = 30 * 60 * 1000;

function parseSalesforceTokenResponse(json: unknown, requested: string[]): PKCEResult {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("Salesforce token response invalid");
  }
  const o = json as Record<string, unknown>;
  const access = o["access_token"];
  if (typeof access !== "string" || access === "") {
    throw new Error("Salesforce token response missing access_token");
  }
  const refresh = o["refresh_token"];
  const refreshStr = typeof refresh === "string" ? refresh : "";
  // instance_url is the per-tenant API host (e.g. https://acme.my.salesforce.com)
  // and is REQUIRED for Salesforce — every request targets it.
  const instance = o["instance_url"];
  if (typeof instance !== "string" || instance === "") {
    throw new Error("Salesforce token response missing instance_url");
  }
  // Salesforce omits expires_in; synthesize a conservative window if absent.
  const expiresIn = parseExpiresInSeconds(o["expires_in"]);
  const expiresAt =
    Number.isFinite(expiresIn) && expiresIn > 0
      ? Date.now() + Math.floor(expiresIn * 1000)
      : Date.now() + SALESFORCE_DEFAULT_EXPIRY_MS;
  const scopeRaw = o["scope"];
  const scope = typeof scopeRaw === "string" ? scopeRaw : undefined;
  return {
    accessToken: access,
    refreshToken: refreshStr,
    expiresAt,
    scopes: scopesFromTokenResponse(scope, requested),
    instanceUrl: instance,
  };
}

/** Common `response_type=code` authorize params shared by every standard OAuth provider. */
export function standardAuthorizeParams(a: AuthorizeArgs): Record<string, string> {
  return {
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    response_type: "code",
    scope: a.scopes.join(" "),
    state: a.state,
  };
}

/** {@link standardAuthorizeParams} plus the PKCE S256 challenge when one was generated. */
function pkceAuthorizeParams(a: AuthorizeArgs): Record<string, string> {
  return {
    ...standardAuthorizeParams(a),
    ...(a.codeChallenge === undefined
      ? {}
      : { code_challenge: a.codeChallenge, code_challenge_method: "S256" }),
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
    offlineAccess: { revokeUrl: "https://myaccount.google.com/permissions" },
    buildAuthorizeParams: (a) => ({
      ...pkceAuthorizeParams(a),
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
    buildAuthorizeParams: pkceAuthorizeParams,
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
      ...(a.codeChallenge === undefined
        ? {}
        : { code_challenge: a.codeChallenge, code_challenge_method: "S256" }),
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
  zoom: {
    id: "zoom",
    vaultKey: "zoom.oauth",
    authorizeUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    usesPkce: true,
    clientSecret: "required",
    secretPlacement: "basic_header",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: pkceAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  },
  hubspot: {
    id: "hubspot",
    vaultKey: "hubspot.oauth",
    authorizeUrl: "https://app.hubspot.com/oauth/authorize",
    tokenUrl: "https://api.hubapi.com/oauth/v1/token",
    // HubSpot uses the standard authorization-code flow (NOT PKCE) with the
    // client_id + client_secret form-encoded into the token-exchange BODY.
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: standardAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  },
  miro: {
    id: "miro",
    vaultKey: "miro.oauth",
    authorizeUrl: "https://miro.com/oauth/authorize",
    tokenUrl: "https://api.miro.com/v1/oauth/token",
    // Miro uses the standard authorization-code flow (NOT PKCE) with the
    // client_id + client_secret form-encoded into the token-exchange BODY.
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: standardAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  },
  canva: {
    id: "canva",
    vaultKey: "canva.oauth",
    authorizeUrl: "https://www.canva.com/api/oauth/authorize",
    tokenUrl: "https://api.canva.com/rest/v1/oauth/token",
    // Canva uses the authorization-code flow WITH PKCE; the token endpoint
    // authenticates the client via HTTP Basic auth (base64(client_id:client_secret))
    // alongside the PKCE code_verifier. Same descriptor shape as Zoom.
    usesPkce: true,
    clientSecret: "required",
    secretPlacement: "basic_header",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: pkceAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  },
  figma: {
    id: "figma",
    vaultKey: "figma.oauth",
    authorizeUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    // Figma uses the standard authorization-code flow (NOT PKCE) with the
    // client_id + client_secret form-encoded into the token-exchange BODY.
    // Same descriptor shape as Miro/HubSpot.
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: standardAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  },
  salesforce: {
    id: "salesforce",
    vaultKey: "salesforce.oauth",
    authorizeUrl: "https://login.salesforce.com/services/oauth2/authorize",
    tokenUrl: "https://login.salesforce.com/services/oauth2/token",
    // Salesforce uses the authorization-code flow WITH PKCE; the token endpoint
    // takes the client_id + client_secret form-encoded in the request BODY.
    // The token response returns a per-tenant `instance_url` (captured into the
    // stored blob) and notably OMITS `expires_in` (see parseSalesforceTokenResponse).
    usesPkce: true,
    clientSecret: "required",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: pkceAuthorizeParams,
    parseTokenResponse: parseSalesforceTokenResponse,
  },
  mendeley: {
    id: "mendeley",
    vaultKey: "mendeley.oauth",
    authorizeUrl: "https://api.mendeley.com/oauth/authorize",
    tokenUrl: "https://api.mendeley.com/oauth/token",
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "basic_header",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: standardAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  },
  workday: {
    id: "workday",
    vaultKey: "workday.oauth",
    // Placeholder URLs — Workday endpoints are tenant-specific; the real
    // descriptor is built per-request by makeWorkdayDescriptor / resolveOAuthDescriptor.
    authorizeUrl: "https://workday.invalid/ccx/oauth2/authorize",
    tokenUrl: "https://workday.invalid/ccx/oauth2/token",
    usesPkce: false,
    clientSecret: "required",
    secretPlacement: "body",
    bodyFormat: "form",
    mirrorPerService: false,
    buildAuthorizeParams: standardAuthorizeParams,
    parseTokenResponse: parseStandardTokenResponse,
  },
};

export function buildAuthorizeUrl(d: OAuthProviderDescriptor, a: AuthorizeArgs): URL {
  const url = new URL(d.authorizeUrl);
  for (const [k, v] of Object.entries(d.buildAuthorizeParams(a))) {
    url.searchParams.set(k, v);
  }
  return url;
}

function tokenErrorSummary(json: unknown): string | undefined {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  const err = o["error"];
  if (typeof err !== "string" || err.length === 0) return undefined;
  const desc = o["error_description"];
  return typeof desc === "string" && desc.trim() !== "" ? `${err}: ${desc.trim()}` : err;
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const credentials = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

interface TokenRequest {
  descriptor: OAuthProviderDescriptor;
  fetchFn: RegistryFetch;
  clientId: string;
  clientSecret?: string;
  grant: Record<string, string>;
  requestedScopes: string[];
}

async function postToken(req: TokenRequest): Promise<PKCEResult> {
  const d = req.descriptor;
  const headers: Record<string, string> = { ...d.tokenHeaders };
  const fields: Record<string, string> = { client_id: req.clientId, ...req.grant };

  if (
    d.secretPlacement === "basic_header" &&
    req.clientSecret !== undefined &&
    req.clientSecret !== ""
  ) {
    headers["Authorization"] = basicAuthHeader(req.clientId, req.clientSecret);
  } else if (
    d.secretPlacement === "body" &&
    req.clientSecret !== undefined &&
    req.clientSecret !== ""
  ) {
    fields["client_secret"] = req.clientSecret;
  }

  let body: string;
  if (d.bodyFormat === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(fields);
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) p.set(k, v);
    body = p.toString();
  }

  const res = await req.fetchFn(d.tokenUrl, { method: "POST", headers, body });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Token endpoint returned non-JSON");
  }
  const httpOk = res.ok;
  const success = d.isTokenSuccess ? d.isTokenSuccess(parsed, httpOk) : httpOk;
  if (!success) {
    const hint = tokenErrorSummary(parsed);
    throw new Error(
      hint === undefined ? "Token exchange failed" : `Token exchange failed (${hint})`,
    );
  }
  return d.parseTokenResponse(parsed, req.requestedScopes);
}

export interface ExchangeArgs {
  descriptor: OAuthProviderDescriptor;
  fetchFn: RegistryFetch;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  codeVerifier?: string;
  authCode: string;
  requestedScopes: string[];
}

export async function exchangeAuthorizationCode(a: ExchangeArgs): Promise<PKCEResult> {
  const grant: Record<string, string> = {
    grant_type: "authorization_code",
    code: a.authCode,
    redirect_uri: a.redirectUri,
  };
  if (a.descriptor.usesPkce && a.codeVerifier !== undefined) {
    grant["code_verifier"] = a.codeVerifier;
  }
  const result = await postToken({
    descriptor: a.descriptor,
    fetchFn: a.fetchFn,
    clientId: a.clientId,
    ...(a.clientSecret !== undefined && { clientSecret: a.clientSecret }),
    grant,
    requestedScopes: a.requestedScopes,
  });
  // Fail the exchange rather than persist a credential that can never be refreshed.
  //
  // `parseStandardTokenResponse` coerces an absent `refresh_token` to `""` — deliberately, and
  // it must keep doing so, because a REFRESH response omits the field and `refreshViaRegistry`
  // reads that `""` as "keep the token I already have". But on the AUTHORIZATION-CODE exchange
  // there is no token to keep: `access_token` and `expires_in` both throw when absent, and
  // `refresh_token` degrading to `""` here was the one silent path. It produced a stored
  // credential whose every later refresh sends an empty token and gets `invalid_grant: Bad
  // Request` back forever, after the CLI reported the auth as successful.
  const offline = a.descriptor.offlineAccess;
  if (offline !== undefined && result.refreshToken === "") {
    throw new Error(
      `${a.descriptor.id} returned no refresh token, so this credential could never be refreshed — nothing was stored. ` +
        `Revoke Nimbus's access at ${offline.revokeUrl} and run the auth command again; ` +
        `re-running it WITHOUT revoking returns the same response, because the provider only issues a refresh token on a fresh grant.`,
    );
  }
  return result;
}

async function persistTokens(vault: NimbusVault, vaultKey: string, r: PKCEResult): Promise<void> {
  validateVaultKeyOrThrow(vaultKey);
  await vault.set(
    vaultKey,
    JSON.stringify({
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: r.expiresAt,
      scopes: r.scopes,
      // Conditional spread: only providers that discovered a per-tenant host
      // (Salesforce) carry `instanceUrl`. Every other provider's persisted
      // payload stays byte-identical to before this field existed.
      ...(r.instanceUrl !== undefined && r.instanceUrl !== ""
        ? { instanceUrl: r.instanceUrl }
        : {}),
    }),
  );
}

export interface RefreshArgs {
  descriptor: OAuthProviderDescriptor;
  refreshToken: string;
  clientId: string;
  vault: NimbusVault;
  clientSecret?: string;
  fetchFn?: RegistryFetch;
  persistVaultKey?: string;
}

export async function refreshViaRegistry(a: RefreshArgs): Promise<PKCEResult> {
  const fetchFn: RegistryFetch = a.fetchFn ?? ((i, init) => globalThis.fetch(i, init));
  const partial = await postToken({
    descriptor: a.descriptor,
    fetchFn,
    clientId: a.clientId,
    ...(a.clientSecret !== undefined && { clientSecret: a.clientSecret }),
    grant: { grant_type: "refresh_token", refresh_token: a.refreshToken },
    requestedScopes: [],
  });
  const result: PKCEResult = {
    ...partial,
    refreshToken: partial.refreshToken === "" ? a.refreshToken : partial.refreshToken,
  };
  const key =
    a.persistVaultKey !== undefined && a.persistVaultKey.trim() !== ""
      ? a.persistVaultKey.trim()
      : a.descriptor.vaultKey;
  await persistTokens(a.vault, key, result);
  return result;
}

const REFRESH_MARGIN_MS = 120_000;
const inFlightRefresh = new Map<string, Promise<string>>();

export interface GetValidArgs {
  descriptor: OAuthProviderDescriptor;
  vault: NimbusVault;
  clientId: string;
  clientSecret?: string;
  vaultKey?: string;
  notConfiguredError?: string;
  parseErrors?: Parameters<typeof parseStoredOAuthTokens>[1];
  emptyClientIdError?: string;
  fetchFn?: RegistryFetch;
}

export async function getValidVaultAccessToken(a: GetValidArgs): Promise<string> {
  const vaultKey = a.vaultKey ?? a.descriptor.vaultKey;
  const raw = await a.vault.get(vaultKey);
  if (raw === null || raw === "") {
    throw new Error(a.notConfiguredError ?? `${a.descriptor.id} OAuth not configured`);
  }
  const parseErrors = a.parseErrors ?? {
    invalidJson: `Invalid ${vaultKey} vault payload`,
    invalidPayload: `Invalid ${vaultKey} vault payload`,
    missingAccess: `Missing ${a.descriptor.id} access token`,
    missingRefresh: `Missing ${a.descriptor.id} refresh token`,
    missingExpiry: "Missing token expiry",
  };
  const parsed = parseStoredOAuthTokens(raw, parseErrors);
  if (parsed.expiresAt > Date.now() + REFRESH_MARGIN_MS) {
    return parsed.accessToken;
  }
  if (a.clientId === "") {
    throw new Error(
      a.emptyClientIdError ?? `Missing client id for ${a.descriptor.id} token refresh`,
    );
  }
  const existing = inFlightRefresh.get(vaultKey);
  if (existing !== undefined) return existing;
  const p = (async () => {
    const next = await refreshViaRegistry({
      descriptor: a.descriptor,
      refreshToken: parsed.refreshToken,
      clientId: a.clientId,
      vault: a.vault,
      ...(a.clientSecret !== undefined && { clientSecret: a.clientSecret }),
      ...(a.vaultKey !== undefined && { persistVaultKey: a.vaultKey }),
      ...(a.fetchFn !== undefined && { fetchFn: a.fetchFn }),
    });
    return next.accessToken;
  })().finally(() => {
    inFlightRefresh.delete(vaultKey);
  });
  inFlightRefresh.set(vaultKey, p);
  return p;
}
