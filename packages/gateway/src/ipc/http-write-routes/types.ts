import type { Database } from "bun:sqlite";
import type { AgentHttpInvoker } from "../../agent-runs/agent-http-invoke.ts";
import type { BriefRunController } from "../../briefs/brief-run-store.ts";
import type { ApiScope } from "../../clips/api-scopes.ts";
import type { PairingWindowController } from "../../clips/pairing-window.ts";
import type { NamespaceStore } from "../../federation/namespace-store.ts";
import type { IdentityStore } from "../../identity/identity-store.ts";
import type { TargetedFetchOutcome } from "../../sync/targeted-fetch.ts";
import type { HttpWriteRateLimiter } from "../http-rate-limit.ts";

/** SCIM seam — present only when the SCIM provisioning surface is enabled for this server. */
export interface ScimWriteSurface {
  readonly token: string;
  readonly store: NamespaceStore;
  readonly identity: IdentityStore;
}

/** Result of the anchor policy author closure (mirrors policy/policy-author.ts AuthorResult). */
export type PolicyAuthorResult =
  | { ok: true; bundle: { toml: string; sig: string }; org: string; version: number }
  | { ok: false; error: string };

/**
 * Anchor policy write seam — present only when the admin policy surface is enabled. `authorPolicy`
 * validates+signs (Vault-only anchor key)+persists+applies the submitted org-policy TOML; it lives
 * under `policy/` so D16 (parsePolicyToml import scoping) is respected — this route never parses TOML.
 */
export interface PolicyWriteSurface {
  readonly token: string;
  readonly authorPolicy: (toml: string) => Promise<PolicyAuthorResult>;
}

/**
 * ChatOps Teams inbound seam — present only when the ChatOps Teams surface is enabled. Auth is a
 * Bot Framework JWT (validated in-route against the Bot Framework JWKS), NOT a static bearer; the
 * `validateBotJwt` closure reuses the identity JWKS-cache + RS256 verifier and checks `aud ===
 * teamsBotAppId`. `onActivity` hands the raw activity to the ChatOps service (normalize → route).
 */
export interface TeamsEventsSurface {
  readonly teamsBotAppId: string;
  readonly validateBotJwt: (authorizationHeader: string | null, nowMs: number) => Promise<boolean>;
  readonly onActivity: (activity: unknown) => Promise<void>;
}

/**
 * Web-clipper seam — present only when the clip surface is enabled. Token verification and minting
 * are injected so this route layer never touches the Vault or token store directly.
 */
export interface ClipsWriteSurface {
  readonly pairing: PairingWindowController;
  readonly verifyToken: (
    presented: string,
  ) => Promise<{ label: string; scopes: readonly ApiScope[] } | null>;
  /** Mints with the scopes the OWNER put on the pairing window — never caller-supplied. */
  readonly mintToken: (label: string, scopes: readonly ApiScope[]) => Promise<string>;
  readonly ingest: (input: unknown) => { id: string; status: "created" | "updated" };
}

/**
 * Research-briefs seam — present only when the briefs surface is enabled. `verifyToken` reuses the
 * same labeled clipper token map as `ClipsWriteSurface` (clipIngest precedent: verified in-route,
 * not via a static bearer). `startRun` kicks off synthesis fire-and-forget, resolving as soon as the
 * run is marked running; `save` persists the finished report as an indexed item.
 */
export interface BriefsWriteSurface {
  readonly controller: BriefRunController;
  readonly verifyToken: (
    presented: string,
  ) => Promise<{ label: string; scopes: readonly ApiScope[] } | null>;
  /** Kicks off synthesis fire-and-forget; resolves as soon as the run is marked running. */
  readonly startRun: (runId: string) => void;
  readonly save: (runId: string) => { itemId: string };
}

/**
 * Agent-invocation seam — present only when the agents surface is enabled. `verifyToken` reuses the
 * same labeled client token map as `ClipsWriteSurface` / `BriefsWriteSurface` (clipIngest
 * precedent: verified in-route, not via a static bearer). `invoke` is the closure built in
 * `agent-runs/agent-http-invoke.ts`, which reaches agents through `dispatchAgentsRpc` and therefore
 * through the egress append.
 */
export interface AgentsWriteSurface {
  readonly verifyToken: (
    presented: string,
  ) => Promise<{ label: string; scopes: readonly ApiScope[] } | null>;
  readonly invoke: AgentHttpInvoker;
}

/**
 * Targeted-fetch write seam — present only when BOTH the labeled clipper token map AND `fetchItem`
 * are wired. `verifyToken` reuses the same labeled clipper token map as `AgentsWriteSurface` /
 * `BriefsWriteSurface` (clipIngest precedent: verified in-route, not via a static bearer).
 * `fetchItem` is the `targetedFetch` closure built at assemble time (Task 10's orchestrator chained
 * behind Task 7's host boundary) — this route layer never touches a connector, the Vault, or the
 * fetch-host boundary directly.
 */
export interface FetchWriteSurface {
  readonly verifyToken: (
    presented: string,
  ) => Promise<{ label: string; scopes: readonly ApiScope[] } | null>;
  readonly fetchItem: (url: string, callerLabel?: string) => Promise<TargetedFetchOutcome>;
}

export interface WriteRouteContext {
  readonly writeDb: Database;
  readonly expectedToken: string;
  readonly rateLimiter: HttpWriteRateLimiter;
  readonly nowMs: () => number;
  readonly deployEnvironments?: readonly string[];
  /** Graphs a CI-annotated deployment after it is stored (IC2); optional and fail-soft. */
  readonly graphDeployment?: (itemId: string) => void;
  readonly knownServices: () => readonly string[];
  readonly scim?: ScimWriteSurface;
  readonly policy?: PolicyWriteSurface;
  readonly messaging?: TeamsEventsSurface;
  readonly clips?: ClipsWriteSurface;
  readonly briefs?: BriefsWriteSurface;
  readonly agents?: AgentsWriteSurface;
  readonly fetch?: FetchWriteSurface;
}

export type RouteKind =
  | "deployment"
  | "scim"
  | "policy"
  | "teamsEvents"
  | "clipIngest"
  | "clipPairConfirm"
  | "briefCreate"
  | "briefSource"
  | "briefRun"
  | "briefSave"
  | "agentInvoke"
  | "itemsFetch";

export interface ResolvedRoute {
  readonly key: string;
  readonly kind: RouteKind;
  readonly expectedToken: string;
  readonly disabledHint: string;
  readonly rejectAction: string;
  readonly hasBody: boolean;
  /** Request-body cap for THIS route (see MAX_BODY_BYTES_DEFAULT / MAX_BODY_BYTES_ARTICLE). */
  readonly maxBodyBytes: number;
  /**
   * Requests per rate-limit window for THIS route (see MAX_REQUESTS_PER_WINDOW_DEFAULT /
   * MAX_REQUESTS_PER_WINDOW_CLIP). Tightens the server-configured limit; never loosens it.
   */
  readonly maxRequestsPerWindow: number;
  readonly id?: string;
}
