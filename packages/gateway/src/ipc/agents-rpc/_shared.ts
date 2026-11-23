import type { Database } from "bun:sqlite";
import type { SynthesisRunner } from "../../agents/_lib/synthesis-llm.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../../config/nimbus-toml.ts";
import { KnownNamespaceStore } from "../../index/known-namespace-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import type { ServiceConfig } from "../../metrics/dora-config.ts";
import type { AgentLatencyRecorder } from "../../telemetry/agent-latency.ts";
import type { sendFederatedOverWire } from "../lan-client.ts";
import type { BoxKeypair } from "../lan-crypto.ts";
import type { ClientKind } from "../server/client-kind.ts";

export class AgentsRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "AgentsRpcError";
    this.rpcCode = rpcCode;
  }
}

export type AgentsRpcContext = {
  db: Database;
  runner?: SynthesisRunner;
  notify: (method: string, params: unknown) => void;
  configDir?: string;
  index?: LocalIndex;
  selfIdentity?: BoxKeypair;
  sendOverWire?: typeof sendFederatedOverWire;
  /** Who is calling. Server-derived; absent in unit tests and non-socket callers. */
  caller?: { clientId: string; kind: ClientKind };
  /**
   * Telemetry `agent_invocation_latency_p50_ms`/`_p95_ms`: when present, `dispatchAgentsRpc`
   * records the time from a RECOGNISED dispatch to that brief's first `briefReady`/`briefError`
   * (`agents/_lib/brief-latency.ts`). A duration only. Absent records nothing.
   */
  agentLatencyRecorder?: AgentLatencyRecorder;
};

/** Zero keypair used as a degraded-path fallback when federation is not configured. */
const ZERO_IDENTITY: BoxKeypair = {
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(32),
};

export function newSessionId(
  kind:
    | "expert"
    | "impact"
    | "catchup"
    | "changelog"
    | "standup"
    | "oncall"
    | "ghost"
    | "glossary"
    | "conflicts"
    | "huddle"
    | "janitor"
    | "preflight"
    | "why"
    | "decisions"
    | "ownership"
    | "premortem"
    | "negotiate",
): string {
  return `${kind}_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Build the shared context base for the federated read-only agents. Degrades gracefully:
 * - missing index  → fresh LocalIndex on the existing db  (→ "no paired peers" gap)
 * - missing identity → zero keypair                       (→ any wire call fails → per-peer gap)
 * Never throws.
 */
export function federatedAgentBase(ctx: AgentsRpcContext, sessionId: string) {
  const index = ctx.index ?? new LocalIndex(ctx.db);
  const selfIdentity = ctx.selfIdentity ?? ZERO_IDENTITY;
  const store = new KnownNamespaceStore(ctx.db);
  const base = { db: ctx.db, index, selfIdentity, store, notify: ctx.notify, sessionId };
  return {
    ...base,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    // sendOverWire is a test-only DI seam; when omitted, peer-fanout falls back to the real
    // sendFederatedOverWire, so production agents fan out over the wire with no extra wiring.
    ...(ctx.sendOverWire === undefined ? {} : { sendOverWire: ctx.sendOverWire }),
  };
}

/**
 * `[metrics.dora.*]`/`[ci.service.*]` service configs, converted from the loader's `Map` to the
 * `readonly ServiceConfig[]` `emitChangelogBrief` expects (`resolveScope`/`resolveDeployPattern`
 * in `agents/changelog.ts` both `.find()` an array). Resolved HERE, not in the agent, mirroring
 * `handleOwnership`'s root-resolution rule — `agents/changelog.ts` keeps no config-file
 * dependency — and re-read per call so a `[ci.service.*]` edit applies without a gateway restart.
 *
 * DEGRADES rather than throws, the same call `premortemResolveServiceId` makes against the same
 * loader: a malformed block would otherwise take the WHOLE brief down before any of its four
 * lanes ran, since this runs before `emitChangelogBrief`. With no `configDir` — the test/embedded
 * shape — this is the empty array, which `resolveScope`/`resolveDeployPattern` already treat as
 * "no configured services" rather than an error.
 */
export function agentServiceConfigs(
  ctx: AgentsRpcContext,
  method: string,
): readonly ServiceConfig[] {
  const { configDir } = ctx;
  if (configDir === undefined) return [];
  try {
    return [...loadNimbusServiceConfigsFromConfigDir(configDir).values()];
  } catch (err) {
    process.stderr.write(
      `${method}: failed to load [metrics.dora.*]/[ci.service.*] from nimbus.toml ` +
        `(${err instanceof Error ? err.message : String(err)}); service scoping will be ` +
        `unavailable until this is fixed.\n`,
    );
    return [];
  }
}
