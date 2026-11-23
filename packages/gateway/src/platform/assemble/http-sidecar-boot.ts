import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { buildAgentHttpInvoker } from "../../agent-runs/agent-http-invoke.ts";
import { AgentRunController } from "../../agent-runs/agent-run-store.ts";
import type { SynthesisRouter } from "../../agents/_lib/synthesis-llm.ts";
import { createBriefIndexSearch } from "../../briefs/brief-index-search.ts";
import { createBriefLlm } from "../../briefs/brief-llm-adapter.ts";
import { buildRegistry } from "../../briefs/brief-registry.ts";
import { BriefRunController } from "../../briefs/brief-run-store.ts";
import { saveBriefReport } from "../../briefs/brief-save.ts";
import { runSynthesis } from "../../briefs/brief-synthesis.ts";
import type { loadNimbusBriefsFromConfigDir } from "../../config/nimbus-toml.ts";
import { bitbucketFetchOneUrlIsSupported } from "../../connectors/bitbucket-sync.ts";
import { readConnectorSecret } from "../../connectors/connector-vault.ts";
import { githubFetchOneUrlIsSupported } from "../../connectors/github-sync.ts";
import { gitlabFetchOneUrlIsSupported } from "../../connectors/gitlab-sync.ts";
import { jenkinsFetchOneUrlIsSupported } from "../../connectors/jenkins-sync.ts";
import { jiraConfiguredBaseUrl, jiraFetchOneUrlIsSupported } from "../../connectors/jira-sync.ts";
import { recordFetchOutcomeEgress } from "../../egress/outcome-egress.ts";
import { recordSyncEgress } from "../../egress/sync-egress.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import {
  deriveFetchHostMap,
  type FetchableService,
  serviceForHost,
} from "../../sync/fetch-host-boundary.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import { type TargetedFetchOutcome, targetedFetch } from "../../sync/targeted-fetch.ts";
import type { AgentLatencyRecorder } from "../../telemetry/agent-latency.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { HttpSidecarOpts } from "./http-sidecar.ts";

// Research-briefs boot (Spine S1), extracted verbatim from assemblePlatformServices to keep that
// function's cognitive complexity in budget (S3776) — the same reason bootTribalKnowledge above
// exists. This is a BEHAVIOUR-PRESERVING extraction: the `[briefs].enabled` gate moved in here with
// the block it guards, so a disabled install still reaches none of this and the caller still owns
// the unconditional `ipcOpts.briefsEnabled` echo. The three `httpSidecarOpts` seams are assigned on
// the caller's own object, so the wiring order relative to the identity/chatops boots is unchanged.
export function bootBriefsIntoHttpSidecar(deps: {
  briefsToml: ReturnType<typeof loadNimbusBriefsFromConfigDir>;
  llmRouter: Parameters<typeof createBriefLlm>[0];
  localIndex: LocalIndex;
  db: Database;
  scheduleItemEmbedding: ((itemId: string) => void) | undefined;
  httpSidecarOpts: HttpSidecarOpts;
}): void {
  const { briefsToml, llmRouter, localIndex, db, scheduleItemEmbedding, httpSidecarOpts } = deps;
  if (!briefsToml.enabled) {
    return;
  }
  const briefRuns = new BriefRunController({
    nowMs: () => Date.now(),
    ttlMs: briefsToml.ttlMinutes * 60_000,
  });
  const briefLlm = createBriefLlm(llmRouter, briefsToml.preferLocal);
  // The query itself lives in briefs/brief-index-search.ts so a test can reach it — see the
  // docblock there. This wiring is behaviour-identical to the closure it replaced.
  const briefSearch = createBriefIndexSearch(localIndex);
  httpSidecarOpts.briefRuns = briefRuns;
  httpSidecarOpts.briefStartRun = (runId: string): void => {
    const run = briefRuns.get(runId);
    if (run === null) return;
    briefRuns.markRunning(run);
    void (async () => {
      const { registry, indexHits, semanticAvailable, searchFailed } = await buildRegistry(
        run,
        briefSearch,
      );
      const out = await runSynthesis({
        run,
        registry,
        indexHits,
        semanticAvailable,
        searchFailed,
        llm: briefLlm,
      });
      if ("error" in out) briefRuns.fail(run, out.error);
      else briefRuns.finish(run, out.report);
    })().catch(() => briefRuns.fail(run, "internal_error"));
  };
  httpSidecarOpts.briefSave = (runId: string) => {
    const run = briefRuns.get(runId);
    if (run === null) throw new Error("run not found");
    return saveBriefReport(db, run, scheduleItemEmbedding);
  };
}

/**
 * Agents-over-HTTP boot. Mirrors `bootBriefsIntoHttpSidecar`: build the singleton run store and the
 * invoker, then assign both onto the caller's `httpSidecarOpts` so wiring order is unchanged.
 *
 * The context handed to the invoker mirrors `ipc/server/dispatchers.ts` `tryDispatchAgentsRpc` —
 * same db, index, configDir and federation identity. `router` is `llmRegistry.llmRouter`, the SAME
 * instance `ipc/server/dispatchers.ts` reads off `ServerCtx.options.llmRegistry` — both paths hand
 * it to the SAME `buildAgentSynthesisRunner` factory, so an HTTP brief and a socket brief stay the
 * same answer to the same question, under every `[agents].synthesis` mode, by construction.
 *
 * Unlike briefs there is no `[agents].enabled` gate: the agents namespace is already served on the
 * socket unconditionally, and the HTTP surface adds no capability a paired client does not have to
 * be granted explicitly — reaching it requires the `agents` scope, which no legacy token carries
 * and `nimbus clip pair --scopes` must name.
 */
export function bootAgentsIntoHttpSidecar(deps: {
  db: Database;
  localIndex: LocalIndex;
  configDir: string;
  selfIdentity: Parameters<typeof createIpcServer>[0]["federationIdentity"];
  llmRouter: SynthesisRouter;
  httpSidecarOpts: HttpSidecarOpts;
  agentLatencyRecorder?: AgentLatencyRecorder;
}): void {
  const agentRuns = new AgentRunController({ nowMs: () => Date.now() });
  deps.httpSidecarOpts.agentRuns = agentRuns;
  deps.httpSidecarOpts.agentInvoke = buildAgentHttpInvoker({
    db: deps.db,
    runs: agentRuns,
    index: deps.localIndex,
    configDir: deps.configDir,
    router: deps.llmRouter,
    ...(deps.selfIdentity === undefined ? {} : { selfIdentity: deps.selfIdentity }),
    ...(deps.agentLatencyRecorder === undefined
      ? {}
      : { agentLatencyRecorder: deps.agentLatencyRecorder }),
  });
}

/**
 * `POST /v1/items/fetch`'s one `http:` exception source (Task 11): the literal `URL.origin` of a
 * service's own self-hosted origin secret — but ONLY when that origin is itself `http:`.
 *
 * Mirrors `sync/fetch-host-boundary.ts`'s module-private `selfHostedOriginSecret` vault-key mapping
 * (`gitlab` → `api_base`, `jenkins`/`jira` → `base_url`; `bitbucket` has no self-hosted
 * variant, and `github`'s `api_base` is https-only so it never carries an `http:` exception)
 * rather than importing it — that helper is private by design, and this is the one other
 * call site that needs the same mapping. `sync/fetch-host-boundary.ts` is on the "do not modify"
 * list for this task, so a short, obviously-mirrored switch here is the alternative to changing
 * that module's public surface.
 *
 * Returns `new URL(secret).origin`, NEVER the raw secret string: `targeted-fetch.ts` compares
 * against `parsed.origin`, which is always scheme+host+port with no trailing slash and a lowercase
 * host — a raw Vault value with a trailing slash or an uppercase host would never match, silently
 * breaking the exception for an otherwise-legitimate self-hosted `http:` service. Returns `null`
 * for a SaaS-only service, for `github` (its `github.api_base` must be https, so the GitHub
 * targeted-fetch `http:` path is never opened even for a GitHub Enterprise Server), an absent/blank secret, an unparseable one, or one configured over
 * anything but `http:`.
 */
export async function httpOriginFor(
  vault: NimbusVault,
  service: FetchableService,
): Promise<string | null> {
  let raw: string | null;
  switch (service) {
    case "gitlab":
      raw = await readConnectorSecret(vault, "gitlab", "api_base");
      break;
    case "jenkins":
      raw = await readConnectorSecret(vault, "jenkins", "base_url");
      break;
    case "jira":
      raw = await readConnectorSecret(vault, "jira", "base_url");
      break;
    case "github":
    case "bitbucket":
      return null;
  }
  if (raw === null || raw.trim() === "") {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  return parsed.protocol === "http:" ? parsed.origin : null;
}

/** Every `FetchableService` with a possible self-hosted origin secret (Task 11). */
const HTTP_ORIGIN_CANDIDATE_SERVICES: readonly FetchableService[] = ["gitlab", "jenkins", "jira"];

/**
 * Resolved FRESH per call, alongside `deriveFetchHostMap` — never cached — for the same reason:
 * credentials can be revoked while the gateway runs, and a cached boundary would keep authorising
 * an `http:` exception after its credential was removed. A few Vault reads on a route that makes a
 * network request anyway.
 */
async function buildHttpOriginMap(
  vault: NimbusVault,
): Promise<ReadonlyMap<FetchableService, string>> {
  // The candidates' secrets are READ concurrently — the caller already runs this beside two other
  // Vault-reading helpers under one `Promise.all` — and entered in candidate order. A failed read
  // still rejects the whole map, so the fetch fails closed exactly as before.
  const origins = await Promise.all(
    HTTP_ORIGIN_CANDIDATE_SERVICES.map(
      async (service) => [service, await httpOriginFor(vault, service)] as const,
    ),
  );
  const map = new Map<FetchableService, string>();
  for (const [service, origin] of origins) {
    if (origin !== null) {
      map.set(service, origin);
    }
  }
  return map;
}

/**
 * Whether `service`'s `fetchOne` would make an outbound request for `url` — i.e. whether
 * `targetedFetch` should append an egress row before attempting it (I29 Critical 2). Delegates to
 * each connector's own exported, pure, network-free URL-shape parser (never a reimplementation
 * here), so this can never disagree with what `fetchOne` itself would decide.
 *
 * `jiraBaseUrl` — resolved fresh per call by the caller, alongside the host map (see
 * `bootTargetedFetchIntoHttpSidecar`) — lets the `jira` case also apply `fetchOneIssue`'s own
 * base-URL match, so a caller URL whose spelling diverges from the configured `jira.base_url`
 * (e.g. a context path the caller's URL omits) is declined HERE too, before the egress append —
 * otherwise `fetchOneIssue`'s later, correct `unsupported_url` would come one step too late to
 * stop an over-claimed `authorized` row for a call that never left the machine.
 */
function fetchOneUrlIsSupported(
  service: FetchableService,
  url: string,
  jiraBaseUrl: string | null,
): boolean {
  switch (service) {
    case "github":
      return githubFetchOneUrlIsSupported(url);
    case "gitlab":
      return gitlabFetchOneUrlIsSupported(url);
    case "bitbucket":
      return bitbucketFetchOneUrlIsSupported(url);
    case "jenkins":
      return jenkinsFetchOneUrlIsSupported(url);
    case "jira":
      return jiraFetchOneUrlIsSupported(url, jiraBaseUrl);
  }
}

/**
 * IMPORTANT 1 fix: builds the `GET /v1/items/resolve` `fetchable` predicate and assigns it onto
 * the caller's `httpSidecarOpts`. Derives the host map the SAME way `bootTargetedFetchIntoHttpSidecar`
 * does — fresh on every call, never cached — so a revoked credential stops advertising
 * `fetchable` on the very next resolve, not just the next fetch.
 */
export function bootResolveFetchableIntoHttpSidecar(deps: {
  vault: NimbusVault;
  httpSidecarOpts: HttpSidecarOpts;
}): void {
  const { vault } = deps;
  deps.httpSidecarOpts.resolveFetchable = async (): Promise<(host: string) => boolean> => {
    const hostMap = await deriveFetchHostMap(vault);
    return (host: string) => serviceForHost(hostMap, host) !== null;
  };
}

/**
 * Targeted-fetch-on-miss boot (Task 11): builds the `POST /v1/items/fetch` closure and assigns it
 * onto the caller's `httpSidecarOpts`, mirroring `bootAgentsIntoHttpSidecar`'s shape.
 *
 * The host map AND the http-origin map are both derived fresh on EVERY call — never cached at boot
 * — because a credential can be revoked while the gateway runs; a cached boundary would keep
 * authorising a service (or an `http:` exception) after its backing secret was removed.
 * `syncableFor`/`contextFor` read the scheduler's OWN registered connectors and `SyncContext`
 * (Task 10's `syncableFor`/`syncContextFor`), so a targeted fetch shares depth enforcement and the
 * rate-limiter bucket with scheduled syncs rather than constructing a parallel context that could
 * drift from it. `appendEgress` and `sync/scheduler.ts`'s `appendSyncEgress` (wired in
 * `createSchedulerWithMesh`, above) are the two closures THIS FILE builds around the SAME appender,
 * `egress/sync-egress.ts`'s `recordSyncEgress` — never the raw `appendEgressEntry`, which D22(b)
 * confines to `egress/*`. A THIRD closure around the same appender is wired separately, outside
 * this file, by `multimodal/build-media-pass-deps.ts`'s `buildCloudBytesDeps` — and it serves TWO
 * of the class's five appenders, since `media-pass.ts` hands that one closure to both
 * `multimodal/cloud-url-resolver.ts` (the credentialed byte-URL resolve round-trip) and
 * `multimodal/cloud-bytes.ts` (the byte-fetch attempt itself), neither of which is a targeted item
 * fetch. The FIFTH appender, `ipc/connector-rpc-handlers/auth.ts`'s `verifyBeforeStoreWithScopes`,
 * calls `recordSyncEgress` directly rather than through a closure this file assembles.
 */
export function bootTargetedFetchIntoHttpSidecar(deps: {
  db: Database;
  vault: NimbusVault;
  syncScheduler: SyncScheduler;
  httpSidecarOpts: HttpSidecarOpts;
  /** Narrowed to the one method used, as `appendBootMarkerOrWarn` does: this is only ever the
   *  destination for a swallowed outcome-append failure. */
  logger: Pick<Logger, "warn">;
}): void {
  const { db, vault, syncScheduler, logger } = deps;
  // `callerLabel` is threaded, not dropped. A closure taking only `url` stays ASSIGNABLE to the
  // surface's `(url, callerLabel?)` type — TypeScript permits fewer parameters — so omitting it
  // here would typecheck cleanly and silently leave every targeted-fetch row unattributed.
  deps.httpSidecarOpts.fetchItem = async (
    url: string,
    callerLabel?: string,
  ): Promise<TargetedFetchOutcome> => {
    const [hostMap, httpOrigins, jiraBaseUrl] = await Promise.all([
      deriveFetchHostMap(vault),
      buildHttpOriginMap(vault),
      jiraConfiguredBaseUrl(vault),
    ]);
    return targetedFetch(
      {
        hostMap,
        syncableFor: (service) => syncScheduler.syncableFor(service),
        contextFor: (service) => syncScheduler.syncContextFor(service),
        httpOriginFor: (service) => httpOrigins.get(service) ?? null,
        urlIsSupported: (service, u) => fetchOneUrlIsSupported(service, u, jiraBaseUrl),
        appendEgress: (row) => recordSyncEgress(db, { ...row, now: Date.now() }),
        appendOutcome: (row) => recordFetchOutcomeEgress(db, { ...row, now: Date.now() }),
        warn: (err, message) => logger.warn(err, message),
        sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      },
      url,
      callerLabel,
    );
  };
}
