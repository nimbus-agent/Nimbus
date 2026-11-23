import type { Database } from "bun:sqlite";
import type { ApiScope } from "../../clips/api-scopes.ts";
import { ingestClip, validateClipInput } from "../../clips/clip-ingest.ts";
import { addApiToken, generateClipToken, verifyApiToken } from "../../clips/clip-token-store.ts";
import { graphAnnotatedDeployment } from "../../deployment/graph-annotated.ts";
import { NamespaceStore } from "../../federation/namespace-store.ts";
import { IdentityStore } from "../../identity/identity-store.ts";
import { buildServiceIdentityResolver } from "../../metrics/service-identity.ts";
import type { HttpWriteRateLimiter } from "../http-rate-limit.ts";
import type { dispatchWriteRoute } from "../http-write-routes.ts";
import { loadServiceConfigs } from "./_shared.ts";
import type { ReadOnlyHttpServerOptions } from "./options.ts";

export type WriteRouteDeps = Parameters<typeof dispatchWriteRoute>[1];
type ScimWriteDeps = NonNullable<WriteRouteDeps["scim"]>;
type PolicyWriteDeps = NonNullable<WriteRouteDeps["policy"]>;

// SCIM provisioning seam — present only when a SCIM bearer resolver is wired.
async function resolveScimWriteDeps(
  writeDb: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<ScimWriteDeps | undefined> {
  if (opts.resolveScimToken === undefined) {
    return undefined;
  }
  return {
    token: await opts.resolveScimToken(),
    store: new NamespaceStore(writeDb),
    identity: new IdentityStore(writeDb),
  };
}

// Policy write surface: present only when an admin token resolver AND an authorPolicy closure are
// both wired. The bearer is the SAME admin token used by /v1/admin/status + /metrics.
async function resolvePolicyWriteDeps(
  opts: ReadOnlyHttpServerOptions,
): Promise<PolicyWriteDeps | undefined> {
  if (opts.authorPolicy === undefined || opts.resolveAdminToken === undefined) {
    return undefined;
  }
  return {
    token: await opts.resolveAdminToken(),
    authorPolicy: opts.authorPolicy,
  };
}

// Agent-invocation write seam — present only when clipsVault, agentRuns AND agentInvoke are all
// wired. verifyToken reuses the same labeled client token map as the web clipper and briefs.
function buildAgentsSeam(opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const runs = opts.agentRuns;
  const invoke = opts.agentInvoke;
  if (clipsVault === undefined || runs === undefined || invoke === undefined) return undefined;
  return { verifyToken: (t: string) => verifyApiToken(clipsVault, t), invoke };
}

// Web-clipper write seam — present only when BOTH clipsVault AND pairingController are wired.
// pairingController is a singleton from assemble.ts (Task 7); http-server never constructs one.
// Capture into locals so TS narrows them inside the closures (avoids non-null assertions).
function buildClipsSeam(writeDb: Database, opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const pairingController = opts.pairingController;
  const scheduleEmbedding = opts.scheduleEmbedding;
  if (clipsVault === undefined || pairingController === undefined) return undefined;
  return {
    pairing: pairingController,
    verifyToken: (t: string) => verifyApiToken(clipsVault, t),
    mintToken: async (label: string, scopes: readonly ApiScope[]): Promise<string> => {
      const token = generateClipToken();
      await addApiToken(clipsVault, label, token, scopes);
      return token;
    },
    ingest: (input: unknown) => ingestClip(writeDb, validateClipInput(input), scheduleEmbedding),
  };
}

// Targeted-fetch write seam — present only when BOTH clipsVault AND fetchItem are wired.
// verifyToken reuses the same labeled clipper token map as the web clipper / agents / briefs
// (clipIngest precedent) — this route never mints or holds its own token.
function buildFetchSeam(opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const fetchItem = opts.fetchItem;
  if (clipsVault === undefined || fetchItem === undefined) return undefined;
  return { verifyToken: (t: string) => verifyApiToken(clipsVault, t), fetchItem };
}

// Research-briefs write seam — present only when clipsVault, briefRuns, briefStartRun, AND
// briefSave are ALL wired. verifyToken reuses the same labeled clipper token map as the web
// clipper (clipIngest precedent) — briefs never mint or hold their own token.
function buildBriefsSeam(opts: ReadOnlyHttpServerOptions) {
  const clipsVault = opts.clipsVault;
  const controller = opts.briefRuns;
  const startRun = opts.briefStartRun;
  const save = opts.briefSave;
  if (
    clipsVault === undefined ||
    controller === undefined ||
    startRun === undefined ||
    save === undefined
  ) {
    return undefined;
  }
  return {
    controller,
    verifyToken: (t: string) => verifyApiToken(clipsVault, t),
    startRun,
    save,
  };
}

// The deployment-annotation bearer token, or "" when that seam is unwired.
async function resolveExpectedToken(opts: ReadOnlyHttpServerOptions): Promise<string> {
  return opts.resolveDeploymentToken === undefined ? "" : await opts.resolveDeploymentToken();
}

// Lazily lists the configured service ids (empty when no config dir is wired).
function resolveKnownServices(opts: ReadOnlyHttpServerOptions): () => readonly string[] {
  return (): readonly string[] => Array.from(loadServiceConfigs(opts).keys());
}

// The Teams events messaging surface, or undefined when that seam is unwired.
async function resolveMessagingSurface(opts: ReadOnlyHttpServerOptions) {
  return opts.resolveTeamsEventsSurface === undefined
    ? undefined
    : await opts.resolveTeamsEventsSurface();
}

/**
 * Graphs a CI-annotated deployment (IC2). The resolver is built lazily per call from the owner's config so
 * an edit is picked up; a malformed or absent config degrades to no resolver (the entity is still written,
 * with a null service, and `nimbus index regraph` repairs it).
 */
function buildGraphDeploymentSeam(
  writeDb: Database,
  opts: ReadOnlyHttpServerOptions,
): (itemId: string) => void {
  return (itemId) => {
    let resolver: ReturnType<typeof buildServiceIdentityResolver> | undefined;
    try {
      resolver = buildServiceIdentityResolver(loadServiceConfigs(opts));
    } catch {
      resolver = undefined;
    }
    graphAnnotatedDeployment(writeDb, itemId, resolver);
  };
}

// Assembles the full I13 dispatcher dependency set. Each write seam (deployment token, SCIM,
// policy, messaging) is resolved independently — a gateway can enable any surface alone.
export async function resolveWriteRouteDeps(
  writeDb: Database,
  rateLimiter: HttpWriteRateLimiter,
  opts: ReadOnlyHttpServerOptions,
): Promise<WriteRouteDeps> {
  const scim = await resolveScimWriteDeps(writeDb, opts);
  const policy = await resolvePolicyWriteDeps(opts);
  const messaging = await resolveMessagingSurface(opts);
  const clips = buildClipsSeam(writeDb, opts);
  const briefs = buildBriefsSeam(opts);
  const agents = buildAgentsSeam(opts);
  const fetchSeam = buildFetchSeam(opts);
  return {
    writeDb,
    expectedToken: await resolveExpectedToken(opts),
    rateLimiter,
    nowMs: opts.nowMs ?? ((): number => Date.now()),
    knownServices: resolveKnownServices(opts),
    graphDeployment: buildGraphDeploymentSeam(writeDb, opts),
    ...(scim === undefined ? {} : { scim }),
    ...(policy === undefined ? {} : { policy }),
    ...(messaging === undefined ? {} : { messaging }),
    ...(clips === undefined ? {} : { clips }),
    ...(briefs === undefined ? {} : { briefs }),
    ...(agents === undefined ? {} : { agents }),
    ...(fetchSeam === undefined ? {} : { fetch: fetchSeam }),
  };
}
