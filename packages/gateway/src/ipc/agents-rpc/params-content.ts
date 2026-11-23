import type { DecisionsInput } from "../../agents/_lib/decisions-types.ts";
import type { GlossaryInput } from "../../agents/_lib/glossary-types.ts";
import type { PremortemInput } from "../../agents/_lib/premortem-types.ts";
import type { WhyInput, WhyRefInput } from "../../agents/_lib/why-types.ts";
import { AgentsRpcError } from "./_shared.ts";
import { MAX_REF_LEN, MAX_SERVICE_LEN, MIN_REF_LEN } from "./limits.ts";
import { optionalPositiveInteger, requireUrlArm } from "./params-common.ts";

export function requireWhyRefParams(params: unknown): WhyRefInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.why requires { ref: string, line?: number }");
  }
  const p = params as { ref?: unknown; line?: unknown };
  if (typeof p.ref !== "string") {
    throw new AgentsRpcError(-32602, `ref must be a non-empty string up to ${MAX_REF_LEN} chars`);
  }
  const trimmed = p.ref.trim();
  if (trimmed.length < MIN_REF_LEN || trimmed.length > MAX_REF_LEN) {
    throw new AgentsRpcError(-32602, `ref must be a non-empty string up to ${MAX_REF_LEN} chars`);
  }
  const line = optionalPositiveInteger(p.line, "line");
  return { ref: trimmed, ...(line === undefined ? {} : { line }) };
}

const WHY_ARMS_MESSAGE = "agents.why requires exactly one of { ref }, { prUrl } or { itemUrl }";

export function requireWhyParams(params: unknown): WhyInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, WHY_ARMS_MESSAGE);
  }
  const p = params as { ref?: unknown; prUrl?: unknown; itemUrl?: unknown };
  // A COUNT, not the `hasRef === hasPrUrl` equality this replaced: that trick reads
  // "exactly one" only while there are exactly two arms, and silently starts meaning
  // "an odd number" at three. Counting says what it means at any arity.
  const supplied = [p.ref, p.prUrl, p.itemUrl].filter((v) => v !== undefined).length;
  if (supplied !== 1) {
    throw new AgentsRpcError(-32602, WHY_ARMS_MESSAGE);
  }
  if (p.itemUrl !== undefined) {
    return { itemUrl: requireUrlArm(p.itemUrl, "itemUrl") };
  }
  if (p.prUrl !== undefined) {
    return { prUrl: requireUrlArm(p.prUrl, "prUrl") };
  }
  return requireWhyRefParams(params);
}

export function requireGlossaryParams(params: unknown): GlossaryInput {
  if (params === null || typeof params !== "object") return {};
  const p = params as { term?: unknown; limit?: unknown };
  if (p.term !== undefined && typeof p.term !== "string") {
    throw new AgentsRpcError(-32602, "term must be a string");
  }
  const limit = optionalPositiveInteger(p.limit, "limit");
  return {
    ...(p.term === undefined ? {} : { term: p.term }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function requireDecisionsParams(params: unknown): DecisionsInput {
  if (params === null || params === undefined) return {};
  if (typeof params !== "object") {
    throw new AgentsRpcError(-32602, "params must be an object");
  }
  const p = params as {
    sinceMs?: unknown;
    minConfidence?: unknown;
    service?: unknown;
    explain?: unknown;
    limit?: unknown;
  };
  if (
    p.sinceMs !== undefined &&
    (typeof p.sinceMs !== "number" || !Number.isInteger(p.sinceMs) || p.sinceMs < 0)
  ) {
    throw new AgentsRpcError(-32602, "sinceMs must be a non-negative integer");
  }
  if (
    p.minConfidence !== undefined &&
    (typeof p.minConfidence !== "number" || p.minConfidence < 0 || p.minConfidence > 1)
  ) {
    throw new AgentsRpcError(-32602, "minConfidence must be between 0 and 1");
  }
  if (p.service !== undefined && typeof p.service !== "string") {
    throw new AgentsRpcError(-32602, "service must be a string");
  }
  const limit = optionalPositiveInteger(p.limit, "limit");
  return {
    ...(p.sinceMs === undefined ? {} : { sinceMs: p.sinceMs as number }),
    ...(p.minConfidence === undefined ? {} : { minConfidence: p.minConfidence as number }),
    ...(p.service === undefined ? {} : { service: p.service as string }),
    ...(p.explain === true ? { explain: true } : {}),
    ...(limit === undefined ? {} : { limit }),
  };
}

/**
 * `services` (array, matching the CLI's repeatable `--service`) overrides derivation entirely —
 * see `agents/premortem.ts`'s `runPremortem`. `repropose` backs `nimbus pre-mortem <ref>
 * --repropose` (Task 5): clears this epic's watcher-proposal tombstones before the proposal path
 * runs. Both optional; omitting `services` lets the agent derive affected services itself.
 */
/**
 * Cap on `services`, which the per-entry 64-char bound does not provide.
 *
 * `agents.premortem` is the one renderer-callable agent that WRITES: every accepted service
 * becomes a `watcher` row plus a `premortem_watcher_proposal` tombstone. Without a length bound a
 * single call could ask for an unbounded number of both. 32 is comfortably above any real epic —
 * `affectedServicesForEpic` derives one service per distinct repo the epic's child PRs touch.
 */
const MAX_PREMORTEM_SERVICES = 32;

/**
 * The `epicRef` string, validated and trimmed.
 *
 * Both the type check and the length check raise the SAME message on purpose:
 * from the caller's side "you sent a number" and "you sent an empty string" are
 * the same mistake — the ref is not a usable reference — and splitting the
 * wording would imply a distinction the handler does not act on.
 */
export function requireEpicRef(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new AgentsRpcError(
      -32602,
      `epicRef must be a non-empty string up to ${MAX_REF_LEN} chars`,
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length < MIN_REF_LEN || trimmed.length > MAX_REF_LEN) {
    throw new AgentsRpcError(
      -32602,
      `epicRef must be a non-empty string up to ${MAX_REF_LEN} chars`,
    );
  }
  return trimmed;
}

/**
 * The optional `services` override, or `undefined` when absent.
 *
 * Every rejection is a hard error rather than a filter: a caller who names five
 * services and gets three silently dropped would read the resulting brief as
 * covering all five. The count cap is enforced BEFORE the per-entry walk so a
 * caller cannot make the gateway iterate an arbitrarily long array to discover
 * it was too long.
 */
export function readServiceOverrides(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new AgentsRpcError(-32602, "services must be an array of strings");
  }
  if (raw.length > MAX_PREMORTEM_SERVICES) {
    throw new AgentsRpcError(-32602, `services accepts at most ${MAX_PREMORTEM_SERVICES} entries`);
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string" || v.trim().length === 0 || v.length > MAX_SERVICE_LEN) {
      throw new AgentsRpcError(
        -32602,
        `each service must be a non-empty string up to ${MAX_SERVICE_LEN} chars`,
      );
    }
    out.push(v.trim());
  }
  return out;
}

export function requirePremortemParams(params: unknown): PremortemInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.premortem requires { epicRef: string }");
  }
  const p = params as { epicRef?: unknown; services?: unknown; repropose?: unknown };
  const epicRef = requireEpicRef(p.epicRef);
  const serviceOverrides = readServiceOverrides(p.services);
  if (p.repropose !== undefined && typeof p.repropose !== "boolean") {
    throw new AgentsRpcError(-32602, "repropose must be a boolean");
  }
  return {
    epicRef,
    ...(serviceOverrides === undefined ? {} : { serviceOverrides }),
    ...(p.repropose === true ? { repropose: true } : {}),
  };
}
