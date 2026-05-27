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

const STUB = (): never => {
  throw new Error("descriptor hook not yet implemented");
};

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
    buildAuthorizeParams: STUB,
    parseTokenResponse: STUB,
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
    buildAuthorizeParams: STUB,
    parseTokenResponse: STUB,
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
    buildAuthorizeParams: STUB,
    parseTokenResponse: STUB,
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
    buildAuthorizeParams: STUB,
    parseTokenResponse: STUB,
  },
};

export type { NimbusVault };
export { validateVaultKeyOrThrow };
