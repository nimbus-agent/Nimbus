import pino from "pino";

import { validateVaultKeyOrThrow } from "../vault/key-format.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  OAUTH_PROVIDERS,
  type OAuthProvider,
  type PKCEResult,
  refreshViaRegistry,
} from "./oauth-registry.ts";
import { resolveOAuthDescriptor } from "./workday-oauth-descriptor.ts";

export type { OAuthProvider, PKCEResult };

export type PKCEFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PKCEOptions {
  clientId: string;
  scopes: string[];
  oauthClientSecret?: string;
  redirectPort?: number;
  portRange?: [number, number];
  provider: OAuthProvider;
  vault: NimbusVault;
  openUrl: (url: string) => Promise<void>;
  fetchImpl?: PKCEFetch;
  onRandomPortFallback?: () => void;
}

const CALLBACK_PATH = "/oauth/callback";

/**
 * `auth/*` wrote no OAuth line at any level (F18 point 4, and F10's secondary finding): a
 * permanent credential failure produced nothing beyond a `sync_state.last_error` string, with no
 * provider, no error code and no response detail anywhere on disk.
 *
 * Provider and error CODE only. `error_description` is provider-controlled text and stays out of
 * the log for the same reason `classifyGoogleCredentialFailure` keeps it out — it reaches the
 * user through the thrown error and the browser page, which are ephemeral, rather than through a
 * file that persists.
 */
const pkceLog = pino({ name: "oauth-pkce", level: process.env["NIMBUS_LOG_LEVEL"] ?? "info" });
const AUTH_TIMEOUT_MS = 5 * 60_000;

function assertValidPort(p: number): void {
  if (!Number.isInteger(p) || p < 1 || p > 65_535) {
    throw new Error("Invalid redirect port");
  }
}

function isAddrInUse(err: unknown): boolean {
  if (typeof err !== "object" || err === null) {
    return false;
  }
  const o = err as { code?: string; message?: string };
  if (o.code === "EADDRINUSE") {
    return true;
  }
  const msg = typeof o.message === "string" ? o.message.toLowerCase() : "";
  return msg.includes("eaddrinuse") || msg.includes("address already in use");
}

function randomUrlSafeString(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCodePoint(b);
  }
  const b64 = btoa(binary);
  return b64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function pkceCodeChallengeS256(codeVerifier: string): Promise<string> {
  const data = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function buildPortSequence(options: PKCEOptions): Array<number | "ephemeral"> {
  const seen = new Set<number>();
  const seq: Array<number | "ephemeral"> = [];

  if (options.redirectPort !== undefined) {
    assertValidPort(options.redirectPort);
    seen.add(options.redirectPort);
    seq.push(options.redirectPort);
  }

  if (options.portRange !== undefined) {
    const [lo, hi] = options.portRange;
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < 1 || hi > 65_535 || lo > hi) {
      throw new Error("Invalid portRange");
    }
    for (let p = lo; p <= hi; p++) {
      if (!seen.has(p)) {
        seen.add(p);
        seq.push(p);
      }
    }
  }

  seq.push("ephemeral");
  return seq;
}

async function persistOAuthTokensToVaultKey(
  vault: NimbusVault,
  vaultKey: string,
  result: PKCEResult,
): Promise<void> {
  validateVaultKeyOrThrow(vaultKey);
  const payload = JSON.stringify({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresAt,
    scopes: result.scopes,
  });
  await vault.set(vaultKey, payload);
}

type OAuthCompletion = { code: string } | { error: string; description?: string };

export function handlePkceCallbackRequest(
  req: Request,
  expectedState: string,
  sink: { value?: OAuthCompletion },
): Response {
  const u = new URL(req.url);
  if (u.pathname !== CALLBACK_PATH) {
    return new Response("Not Found", { status: 404 });
  }
  const err = u.searchParams.get("error");
  if (err !== null && err !== "") {
    // Capture `error_description` too (F18): providers populate it with the human-readable half,
    // and it was never read at all — not even into the sink, so no layer could have shown it.
    const description = u.searchParams.get("error_description");
    sink.value = {
      error: err,
      ...(description === null || description === "" ? {} : { description }),
    };
    // Say WHICH error. This asserted a denial for every code — `access_denied`,
    // `consent_required`, `interaction_required`, `invalid_scope`, `unauthorized_client` and
    // `server_error` all rendered as "Authorization was denied", and only the first one is a
    // denial. The others need different actions from the user, and the page was telling them
    // to take the wrong one.
    const headline =
      err === "access_denied" ? "Authorization was denied." : `Authorization failed: ${err}`;
    const detail =
      description === null || description === ""
        ? ""
        : `
${description}`;
    return new Response(
      `${headline}${detail}
You can close this window.`,
      {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      },
    );
  }
  const code = u.searchParams.get("code");
  const st = u.searchParams.get("state");
  if (code === null || code === "" || st !== expectedState) {
    return new Response("Invalid callback", { status: 400 });
  }
  sink.value = { code };
  return new Response("Signed in. You can close this window.", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function runOnLocalPort(
  options: PKCEOptions,
  bindPort: number,
  fetchFn: PKCEFetch,
): Promise<PKCEResult> {
  const descriptor = resolveOAuthDescriptor(options.provider);
  const usePkce = descriptor.usesPkce;
  const codeVerifier = usePkce ? randomUrlSafeString(32) : undefined;
  const codeChallenge =
    codeVerifier === undefined ? undefined : await pkceCodeChallengeS256(codeVerifier);
  const state = randomUrlSafeString(16);
  const completion: { value?: OAuthCompletion } = {};

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: bindPort,
    fetch(req) {
      return handlePkceCallbackRequest(req, state, completion);
    },
  });
  const redirectUri = `http://127.0.0.1:${String(server.port)}${CALLBACK_PATH}`;
  const authUrl = buildAuthorizeUrl(descriptor, {
    clientId: options.clientId,
    scopes: options.scopes,
    redirectUri,
    state,
    ...(codeChallenge !== undefined && { codeChallenge }),
  });

  const abortTimer = setTimeout(() => {
    completion.value ??= { error: "timeout" };
  }, AUTH_TIMEOUT_MS);

  try {
    await options.openUrl(authUrl.toString());
    while (completion.value === undefined) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const done = completion.value;
    if ("error" in done) {
      // The code was in scope here and thrown away (F18), which is what made every OAuth failure
      // undiagnosable — and what made F11 cost an hour of black-box probing to establish a fact
      // the provider had already stated.
      pkceLog.warn({ provider: options.provider, error: done.error }, "OAuth authorization failed");
      const detail = done.description === undefined ? "" : ` — ${done.description}`;
      throw new Error(`OAuth authorization did not complete: ${done.error}${detail}`);
    }

    const clientSecret = options.oauthClientSecret?.trim();
    const result = await exchangeAuthorizationCode({
      descriptor,
      fetchFn,
      clientId: options.clientId,
      ...(clientSecret !== undefined && clientSecret !== "" && { clientSecret }),
      redirectUri,
      ...(codeVerifier !== undefined && { codeVerifier }),
      authCode: done.code,
      requestedScopes: options.scopes,
    });
    await persistOAuthTokensToVaultKey(options.vault, descriptor.vaultKey, result);
    return result;
  } finally {
    clearTimeout(abortTimer);
    server.stop();
  }
}

export async function runPKCEFlow(options: PKCEOptions): Promise<PKCEResult> {
  const descriptor = resolveOAuthDescriptor(options.provider);
  if (descriptor.clientSecret === "required") {
    const secret = options.oauthClientSecret?.trim();
    if (secret === undefined || secret === "") {
      throw new Error(
        `${options.provider} OAuth requires oauthClientSecret (integration client secret)`,
      );
    }
  }
  const fetchFn: PKCEFetch = options.fetchImpl ?? ((i, init) => globalThis.fetch(i, init));
  const sequence = buildPortSequence(options);

  for (const spec of sequence) {
    if (spec === "ephemeral") {
      options.onRandomPortFallback?.();
    }
    const bindPort = spec === "ephemeral" ? 0 : spec;
    try {
      return await runOnLocalPort(options, bindPort, fetchFn);
    } catch (err) {
      if (spec !== "ephemeral" && isAddrInUse(err)) {
        continue;
      }
      throw err;
    }
  }

  throw new Error("Could not bind a local port for OAuth callback");
}

export interface RefreshAccessTokenContext {
  vault: NimbusVault;
  fetchImpl?: PKCEFetch;
  clientSecret?: string;
  persistVaultKey?: string;
}

export async function refreshAccessToken(
  refreshToken: string,
  provider: OAuthProvider,
  clientId: string,
  ctx: RefreshAccessTokenContext,
): Promise<PKCEResult> {
  return refreshViaRegistry({
    descriptor: resolveOAuthDescriptor(provider),
    refreshToken,
    clientId,
    vault: ctx.vault,
    ...(ctx.clientSecret !== undefined && { clientSecret: ctx.clientSecret }),
    ...(ctx.fetchImpl !== undefined && { fetchFn: ctx.fetchImpl }),
    ...(ctx.persistVaultKey !== undefined && { persistVaultKey: ctx.persistVaultKey }),
  });
}

export async function refreshSlackUserToken(
  refreshToken: string,
  clientId: string,
  ctx: RefreshAccessTokenContext,
): Promise<PKCEResult> {
  return refreshViaRegistry({
    descriptor: OAUTH_PROVIDERS.slack,
    refreshToken,
    clientId,
    vault: ctx.vault,
    ...(ctx.fetchImpl !== undefined && { fetchFn: ctx.fetchImpl }),
  });
}

export async function refreshNotionToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  ctx: RefreshAccessTokenContext,
): Promise<PKCEResult> {
  return refreshViaRegistry({
    descriptor: OAUTH_PROVIDERS.notion,
    refreshToken,
    clientId,
    clientSecret,
    vault: ctx.vault,
    ...(ctx.fetchImpl !== undefined && { fetchFn: ctx.fetchImpl }),
  });
}
