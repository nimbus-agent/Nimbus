import type { AgentHttpInvoker } from "../../agent-runs/agent-http-invoke.ts";
import type { AgentRunController } from "../../agent-runs/agent-run-store.ts";
import type { BriefRunController } from "../../briefs/brief-run-store.ts";
import type { PairingWindowController } from "../../clips/pairing-window.ts";
import type { TargetedFetchOutcome } from "../../sync/targeted-fetch.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { StatusReaders } from "../admin-status-rpc.ts";
import type { PolicyAuthorResult, TeamsEventsSurface } from "../http-write-routes.ts";

export type ReadOnlyHttpServerOptions = {
  readonly configDir?: string;
  readonly nowMs?: () => number;
  readonly resolveDeploymentToken?: () => Promise<string>;
  readonly resolveScimToken?: () => Promise<string>;
  // Observability snapshot (Task 15). When BOTH are present, GET /v1/admin/status (JSON) and
  // GET /metrics (Prometheus text) are served, gated by a constant-time bearer check against
  // resolveAdminToken(). Absent either → the routes 404 (surface not mounted).
  readonly statusReaders?: StatusReaders;
  readonly resolveAdminToken?: () => Promise<string>;
  // Anchor policy write surface (Task 18b). When BOTH are present, PUT /v1/admin/policy is mounted
  // on the I13 write dispatcher (bearer = resolveAdminToken). `authorPolicy` is a policy/-resident
  // closure that validates+signs (Vault-only anchor key)+persists+applies — the route never parses
  // TOML itself (D16). Absent either → the route 404s (surface not mounted).
  readonly authorPolicy?: (toml: string) => Promise<PolicyAuthorResult>;
  // ChatOps Teams inbound surface (Slice 5). When present, POST /v1/messaging/teams/events is
  // mounted on the I13 write dispatcher; auth is the Bot Framework JWT (validated in-route), not a
  // static bearer. The surface (validateBotJwt + onActivity) is built by the ChatOps service.
  readonly resolveTeamsEventsSurface?: () => Promise<TeamsEventsSurface | undefined>;
  // Web-clipper surface (Task 6). When BOTH clipsVault and pairingController are present:
  //   - POST /v1/clips/related (bearer-authed read route) is mounted directly in the fetch handler.
  //   - The clips write seam (POST /v1/clips + POST /v1/clips/pair/confirm) is enabled in the I13
  //     write dispatcher. pairingController is a SINGLETON created at assemble time (Task 7) and
  //     shared with the clip-rpc IPC handler — http-server never constructs one per-request.
  readonly clipsVault?: NimbusVault;
  readonly pairingController?: PairingWindowController;
  // When present, called after each successful clip ingest to schedule embedding generation.
  readonly scheduleEmbedding?: (id: string) => void;
  // Research briefs (Task 12). Absent => every /v1/briefs route 404s. Reuses clipsVault for
  // bearer auth (same labeled clipper token map) — briefRuns alone is not enough to mount the
  // surface.
  readonly briefRuns?: BriefRunController;
  readonly briefStartRun?: (runId: string) => void;
  readonly briefSave?: (runId: string) => { itemId: string };
  // Agents over HTTP. BOTH are required to mount the surface (reads and the write route alike);
  // absent either, every /v1/agents route 404s with a named cause. Reuses clipsVault for bearer
  // auth, exactly as briefs do — agents never mint or hold their own token.
  readonly agentRuns?: AgentRunController;
  readonly agentInvoke?: AgentHttpInvoker;
  // Targeted fetch-on-miss (Task 11). Absent => POST /v1/items/fetch 404s (surface not mounted).
  // Built at assemble time because it needs the scheduler's syncables, its SyncContext and its
  // rate-limiter bucket, plus a Vault-derived fetch-host boundary — the HTTP layer must not reach
  // into connectors or the Vault itself. Reuses clipsVault for bearer auth (clipIngest precedent),
  // under its own `fetch` scope, distinct from `resolve`'s read-only local-index lookup.
  readonly fetchItem?: (url: string) => Promise<TargetedFetchOutcome>;
  // IMPORTANT 1 fix: the `fetchable` predicate `GET /v1/items/resolve` passes to
  // `resolveItemByUrl`. Absent => every resolve answers `fetchable: false` (the same default
  // `resolveItemByUrl` itself falls back to). A CLOSURE, not a raw host map: the map must be
  // derived FRESH on every call (never cached) — a revoked credential must stop advertising
  // `fetchable` immediately — exactly like `fetchItem`'s own host-map derivation above. The HTTP
  // layer never reaches into the Vault itself; assemble time builds this the same way it builds
  // `fetchItem`'s host map.
  readonly resolveFetchable?: () => Promise<(host: string) => boolean>;
};

export type ReadOnlyHttpServerHandle = {
  readonly port: number;
  readonly stop: () => void;
};
