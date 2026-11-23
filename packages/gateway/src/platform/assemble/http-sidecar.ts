import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AgentHttpInvoker } from "../../agent-runs/agent-http-invoke.ts";
import type { AgentRunController } from "../../agent-runs/agent-run-store.ts";
import type { BriefRunController } from "../../briefs/brief-run-store.ts";
import type { PairingWindowController } from "../../clips/pairing-window.ts";
import type { StatusReaders } from "../../ipc/admin-status-rpc.ts";
import { type ReadOnlyHttpServerOptions, startReadOnlyHttpServer } from "../../ipc/http-server.ts";
import type { TeamsEventsSurface } from "../../ipc/http-write-routes.ts";
import { startMetricsServer } from "../../ipc/metrics-server.ts";
import type { AuthorResult } from "../../policy/policy-author.ts";
import type { TargetedFetchOutcome } from "../../sync/targeted-fetch.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { processEnvGet } from "../env-access.ts";
import type { PlatformPaths } from "../paths.ts";

export interface HttpSidecarOpts {
  resolveScimToken?: () => Promise<string>;
  statusReaders?: StatusReaders;
  resolveAdminToken?: () => Promise<string>;
  authorPolicy?: (toml: string) => Promise<AuthorResult>;
  resolveTeamsEventsSurface?: () => Promise<TeamsEventsSurface | undefined>;
  // Web-clipper (Task 7): clipsVault + pairingController + scheduleEmbedding are threaded into
  // ReadOnlyHttpServerOptions. pairingController is the SINGLETON also injected into clip.* IPC.
  clipsVault?: NimbusVault;
  pairingController?: PairingWindowController;
  scheduleEmbedding?: (id: string) => void;
  // Research briefs (Spine S1, Task 13): threaded into ReadOnlyHttpServerOptions the same way.
  briefRuns?: BriefRunController;
  briefStartRun?: (runId: string) => void;
  briefSave?: (runId: string) => { itemId: string };
  // Agents over HTTP: the run store is a SINGLETON — the POST route opens runs in it and the GET
  // route reads them, so they must be the same object.
  agentRuns?: AgentRunController;
  agentInvoke?: AgentHttpInvoker;
  // Targeted fetch-on-miss (Task 11): threaded into ReadOnlyHttpServerOptions the same way.
  fetchItem?: (url: string) => Promise<TargetedFetchOutcome>;
  // IMPORTANT 1 fix: threaded into ReadOnlyHttpServerOptions the same way.
  resolveFetchable?: () => Promise<(host: string) => boolean>;
}

/** Parse a sidecar port from a raw env value: a positive finite integer, else undefined. */
export function parseSidecarPortEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const port = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(port) && port > 0 ? port : undefined;
}

/** Assemble the read-only HTTP server options, spreading only the seams the caller wired. */
function buildReadOnlyHttpServerOpts(
  configDir: string,
  httpOpts: HttpSidecarOpts,
): ReadOnlyHttpServerOptions {
  return {
    configDir,
    ...(httpOpts.resolveScimToken === undefined
      ? {}
      : { resolveScimToken: httpOpts.resolveScimToken }),
    ...(httpOpts.statusReaders === undefined ? {} : { statusReaders: httpOpts.statusReaders }),
    ...(httpOpts.resolveAdminToken === undefined
      ? {}
      : { resolveAdminToken: httpOpts.resolveAdminToken }),
    ...(httpOpts.authorPolicy === undefined ? {} : { authorPolicy: httpOpts.authorPolicy }),
    ...(httpOpts.resolveTeamsEventsSurface === undefined
      ? {}
      : { resolveTeamsEventsSurface: httpOpts.resolveTeamsEventsSurface }),
    ...(httpOpts.clipsVault === undefined ? {} : { clipsVault: httpOpts.clipsVault }),
    ...(httpOpts.pairingController === undefined
      ? {}
      : { pairingController: httpOpts.pairingController }),
    ...(httpOpts.scheduleEmbedding === undefined
      ? {}
      : { scheduleEmbedding: httpOpts.scheduleEmbedding }),
    ...(httpOpts.briefRuns === undefined ? {} : { briefRuns: httpOpts.briefRuns }),
    ...(httpOpts.briefStartRun === undefined ? {} : { briefStartRun: httpOpts.briefStartRun }),
    ...(httpOpts.briefSave === undefined ? {} : { briefSave: httpOpts.briefSave }),
    ...(httpOpts.agentRuns === undefined ? {} : { agentRuns: httpOpts.agentRuns }),
    ...(httpOpts.agentInvoke === undefined ? {} : { agentInvoke: httpOpts.agentInvoke }),
    ...(httpOpts.fetchItem === undefined ? {} : { fetchItem: httpOpts.fetchItem }),
    ...(httpOpts.resolveFetchable === undefined
      ? {}
      : { resolveFetchable: httpOpts.resolveFetchable }),
  };
}

export function collectSidecarsFromEnv(
  db: Database,
  paths: PlatformPaths,
  sidecarStops: Array<() => void>,
  httpOpts: HttpSidecarOpts = {},
): void {
  const httpPort = parseSidecarPortEnv(processEnvGet("NIMBUS_HTTP_PORT"));
  if (httpPort !== undefined) {
    sidecarStops.push(
      startReadOnlyHttpServer(
        join(paths.dataDir, "nimbus.db"),
        httpPort,
        buildReadOnlyHttpServerOpts(paths.configDir, httpOpts),
      ).stop,
    );
  }
  const metricsPort = parseSidecarPortEnv(processEnvGet("NIMBUS_METRICS_PORT"));
  if (metricsPort !== undefined) {
    sidecarStops.push(startMetricsServer(() => db, metricsPort).stop);
  }
}
