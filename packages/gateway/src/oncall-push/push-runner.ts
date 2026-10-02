import type { Database } from "bun:sqlite";
import { selectIncidentById } from "../agents/_lib/oncall-queries.ts";
import type { OncallIncident } from "../agents/_lib/oncall-types.ts";
import type { NimbusOncallPushToml } from "../config/oncall-push-toml.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { type AgentsRpcContext, AgentsRpcError, dispatchAgentsRpc } from "../ipc/agents-rpc.ts";
import { resolveSeveritySet, selectPushCandidates } from "./push-selector.ts";
import type { BriefOutcome, PushedBriefRow, PushStore } from "./push-store.ts";

export const PUSH_BRIEF_TIMEOUT_MS = 30_000;
const DAY_MS = 86_400_000;
const MAX_DETAIL = 500;

/**
 * `runner` is OMITTED by type: a push dispatch can never carry a synthesis runner, so the brief is
 * always the deterministic render and no unattended push reaches a model (spec § 2.3).
 */
export type PushDispatchContext = Omit<AgentsRpcContext, "caller" | "runner"> & {
  readonly caller: { readonly clientId: string; readonly kind: "push" };
};
export type PushDispatch = (
  method: string,
  params: unknown,
  ctx: PushDispatchContext,
) => Promise<unknown>;
export type PushDelivery = { readonly row: PushedBriefRow; readonly incident: OncallIncident };
export type PushRunSkip = "disabled" | "not_pagerduty" | "identity_unresolved" | "not_reconciled";
export type PushRunSummary = {
  readonly selected: number;
  readonly ok: number;
  readonly failed: number;
  readonly skipped?: PushRunSkip;
};

export class PushRetryRefusedError extends Error {
  constructor(
    readonly code: "ERR_ONCALL_PUSH_NOT_FOUND" | "ERR_ONCALL_PUSH_NOT_FAILED",
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface OncallPushRunnerDeps {
  readonly db: Database;
  readonly store: PushStore;
  readonly config: NimbusOncallPushToml;
  readonly pagerdutyAliases: readonly string[];
  readonly configDir: string;
  readonly index?: LocalIndex;
  readonly resolveSelf: () => Promise<string | null>;
  readonly deliver: (items: readonly PushDelivery[]) => Promise<void>;
  readonly dispatch?: PushDispatch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export interface OncallPushRunner {
  run(serviceId: string): Promise<PushRunSummary>;
  retry(incidentId: string): Promise<PushedBriefRow>;
}

const defaultDispatch: PushDispatch = async (method, params, ctx) => {
  const out = await dispatchAgentsRpc(method, params, ctx);
  if (out.kind === "miss") throw new AgentsRpcError(-32601, `agent method not served: ${method}`);
  return out.value;
};

function clip(s: string): string {
  return s.length > MAX_DETAIL ? `${s.slice(0, MAX_DETAIL)}…` : s;
}
function sessionIdOf(v: unknown): string | undefined {
  if (v === null || typeof v !== "object" || !("sessionId" in v)) return undefined;
  const id: unknown = v.sessionId;
  return typeof id === "string" && id !== "" ? id : undefined;
}
function field(p: unknown, key: string): unknown {
  return p !== null && typeof p === "object" && key in p
    ? (p as Record<string, unknown>)[key]
    : undefined;
}

/** One `agents.oncall` dispatch, awaited through the runner's OWN listener (fleet-invoker's shape). */
function briefIncident(deps: OncallPushRunnerDeps, incidentId: string): Promise<BriefOutcome> {
  const dispatch = deps.dispatch ?? defaultDispatch;
  const timeoutMs = deps.timeoutMs ?? PUSH_BRIEF_TIMEOUT_MS;
  return new Promise<BriefOutcome>((resolve) => {
    let settled = false;
    let expected: string | undefined;
    const pending: Array<{ m: string; p: unknown }> = [];
    const settle = (o: BriefOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(o);
    };
    const timer = setTimeout(
      () =>
        settle({
          status: "failed",
          sessionId: expected ?? null,
          failureCode: `timeout: no brief in ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
    const consider = (m: string, p: unknown): void => {
      if (settled) return;
      if (expected === undefined) {
        pending.push({ m, p });
        return;
      }
      if (sessionIdOf(p) !== expected) return;
      if (m === "oncall.briefReady") {
        const brief = field(p, "brief");
        settle({
          status: "ok",
          sessionId: expected,
          briefMarkdown: typeof brief === "string" ? brief : "",
          briefJson: JSON.stringify(field(p, "findings") ?? {}),
        });
      } else if (m === "oncall.briefError") {
        settle({
          status: "failed",
          sessionId: expected,
          failureCode: `brief_error: ${clip(String(field(p, "error") ?? "unknown"))}`,
        });
      }
    };
    void (async () => {
      try {
        const out = await dispatch(
          "agents.oncall",
          { incidentId },
          {
            db: deps.db,
            notify: consider,
            configDir: deps.configDir,
            ...(deps.index === undefined ? {} : { index: deps.index }),
            // Server-derived: the gateway's own post-sync hook is calling (D28 confines this literal).
            caller: { clientId: "oncall-push", kind: "push" },
          },
        );
        expected = sessionIdOf(out);
        if (expected === undefined) {
          settle({
            status: "failed",
            sessionId: null,
            failureCode: "no_session: agents.oncall returned no sessionId",
          });
          return;
        }
        for (const q of pending.splice(0)) consider(q.m, q.p);
      } catch (e) {
        settle({
          status: "failed",
          sessionId: null,
          failureCode: `refused: ${clip(e instanceof Error ? e.message : String(e))}`,
        });
      }
    })();
  });
}

export function createOncallPushRunner(deps: OncallPushRunnerDeps): OncallPushRunner {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<PushRunSummary> | undefined;
  let rerunRequested = false;
  const retrying = new Map<string, Promise<PushedBriefRow>>();

  async function once(): Promise<PushRunSummary> {
    if (!deps.config.enabled) return { selected: 0, ok: 0, failed: 0, skipped: "disabled" };
    const enabledAt = deps.store.enabledAt();
    if (enabledAt === null) return { selected: 0, ok: 0, failed: 0, skipped: "not_reconciled" };
    const personId = await deps.resolveSelf();
    if (personId === null) return { selected: 0, ok: 0, failed: 0, skipped: "identity_unresolved" };
    deps.store.pruneOlderThan(now() - deps.config.retentionDays * DAY_MS);
    const candidates = selectPushCandidates(deps.db, {
      personId,
      severities: resolveSeveritySet(deps.config, deps.pagerdutyAliases),
      enabledAtMs: enabledAt,
      alreadyPushed: (id) => deps.store.has(id),
    });
    const items: PushDelivery[] = [];
    let ok = 0;
    try {
      for (const incident of candidates) {
        // Defensive: a duplicate candidate within one selection would make `insert` throw on the PK.
        if (deps.store.has(incident.id)) continue;
        const outcome = await briefIncident(deps, incident.id);
        const row = deps.store.insert(incident.id, outcome, now());
        if (row.status === "ok") ok += 1;
        items.push({ row, incident });
      }
    } finally {
      // A row already inserted is never reselected (alreadyPushed) and an ok row refuses retry, so
      // an insert that throws mid-loop must not strand the rows before it undelivered.
      if (items.length > 0) await deps.deliver(items);
    }
    return { selected: candidates.length, ok, failed: items.length - ok };
  }

  async function loop(): Promise<PushRunSummary> {
    try {
      let last = await once();
      while (rerunRequested) {
        rerunRequested = false;
        last = await once();
      }
      return last;
    } finally {
      // Same synchronous step as the final `rerunRequested` check (and the throw path): a run()
      // landing after this sees no in-flight run and starts its own, so no request is lost.
      inFlight = undefined;
      rerunRequested = false;
    }
  }

  async function doRetry(incidentId: string): Promise<PushedBriefRow> {
    const existing = deps.store.get(incidentId);
    if (existing === null)
      throw new PushRetryRefusedError(
        "ERR_ONCALL_PUSH_NOT_FOUND",
        `no pushed brief for ${incidentId}`,
      );
    if (existing.status !== "failed") {
      throw new PushRetryRefusedError(
        "ERR_ONCALL_PUSH_NOT_FAILED",
        `${incidentId} already has a brief; use nimbus oncall --incident ${incidentId}`,
      );
    }
    const outcome = await briefIncident(deps, incidentId);
    let row: PushedBriefRow;
    try {
      row = deps.store.applyRetry(incidentId, outcome, now());
    } catch (e) {
      // A retention prune can delete the row while the brief is being assembled; that is a
      // not-found refusal, not an internal error.
      if (deps.store.get(incidentId) === null) {
        throw new PushRetryRefusedError(
          "ERR_ONCALL_PUSH_NOT_FOUND",
          `pushed brief for ${incidentId} was removed (retention) during the retry`,
        );
      }
      throw e;
    }
    const incident = selectIncidentById(deps.db, incidentId);
    if (row.status === "ok" && incident !== null) await deps.deliver([{ row, incident }]);
    return row;
  }

  return {
    async run(serviceId) {
      if (serviceId !== "pagerduty")
        return { selected: 0, ok: 0, failed: 0, skipped: "not_pagerduty" };
      if (inFlight !== undefined) {
        rerunRequested = true;
        return inFlight;
      }
      inFlight = loop();
      return inFlight;
    },

    retry(incidentId) {
      // Single-flight per incident: the `failed` check and the write are separated by a brief that
      // can take PUSH_BRIEF_TIMEOUT_MS, so two concurrent retries would both pass the check, open
      // two `agents.oncall` sessions, and race their writes. A second caller joins the attempt
      // already running instead.
      const pending = retrying.get(incidentId);
      if (pending !== undefined) return pending;
      const p = doRetry(incidentId).finally(() => retrying.delete(incidentId));
      retrying.set(incidentId, p);
      return p;
    },
  };
}
