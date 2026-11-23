import { AgentsRpcError } from "./_shared.ts";
import { parseNamespaces } from "./file-param.ts";
import { MAX_FILE_LEN, MAX_SERVICE_LEN, MAX_SINCE_MS, MIN_FILE_LEN } from "./limits.ts";

const MIN_TOPIC_LEN = 1;
const MAX_TOPIC_LEN = 1024;
const MAX_LIMIT = 25;

const MIN_DEPTH = 1;
const MAX_IMPACT_DEPTH = 5;

const MAX_PR_URL_LEN = 2048;

/**
 * A non-null, non-array object, or `-32602` saying `<method> requires an object payload`.
 * Validators whose refusal says something else — the shape they expect, or a different rule —
 * keep their own check inline.
 */
export function requireObjectPayload(params: unknown, method: string): asserts params is object {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, `${method} requires an object payload`);
  }
}

// The `optional*` field validators below are seen by `audit:agent-param-kinds` only through their
// CALLS (`HELPER_TO_KIND` in `scripts/structure-audit/check-agent-param-kinds.ts`): register a new
// one there, or every field it validates silently leaves that audit. That audit's own test fails
// until you do.

/**
 * An optional `sinceMs` look-back window: `undefined` when absent, otherwise a non-negative integer
 * of at most `max` ms. `label` is that bound in words (`"90 days"`), echoed in the refusal.
 *
 * `agents.decisions` does NOT use this: its `sinceMs` has no upper bound, a different rule.
 */
export function optionalSinceMs(raw: unknown, max: number, label: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > max) {
    throw new AgentsRpcError(
      -32602,
      `sinceMs must be a non-negative integer up to ${max} ms (${label})`,
    );
  }
  return raw;
}

/**
 * An optional identifier field — `service`, `personId`, `incidentId`: `undefined` when absent,
 * otherwise a string that is non-blank after trim and at most `maxLen` long BEFORE it, returned
 * trimmed. `unit` exists only because `agents.oncall`'s two messages say `characters` where every
 * other validator says `chars`; the wording is kept exactly as the caller has always seen it.
 */
export function optionalBoundedString(
  raw: unknown,
  name: string,
  maxLen: number,
  unit: "chars" | "characters" = "chars",
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0 || raw.length > maxLen) {
    throw new AgentsRpcError(-32602, `${name} must be a non-empty string up to ${maxLen} ${unit}`);
  }
  return raw.trim();
}

/** An optional positive integer with no upper bound (`limit`, `line`): `undefined` when absent. */
export function optionalPositiveInteger(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new AgentsRpcError(-32602, `${name} must be a positive integer`);
  }
  return raw;
}

export function requireExpertParams(params: unknown): {
  topicOrFile?: string;
  itemUrl?: string;
  limit?: number;
} {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(
      -32602,
      "agents.expert requires exactly one of { topicOrFile } or { itemUrl }",
    );
  }
  const p = params as { topicOrFile?: unknown; itemUrl?: unknown; limit?: unknown };
  // Counted, not an equality: the same shape `agents.why` uses, and for the same reason —
  // it keeps meaning "exactly one" if a third arm is ever added.
  const supplied = [p.topicOrFile, p.itemUrl].filter((v) => v !== undefined).length;
  if (supplied !== 1) {
    throw new AgentsRpcError(
      -32602,
      "agents.expert requires exactly one of { topicOrFile } or { itemUrl }",
    );
  }

  const out: { topicOrFile?: string; itemUrl?: string; limit?: number } = {};
  if (p.itemUrl !== undefined) {
    // The same guards `why`'s URL arms get: both values come off a browser address bar.
    out.itemUrl = requireUrlArm(p.itemUrl, "itemUrl");
  } else {
    if (typeof p.topicOrFile !== "string") {
      throw new AgentsRpcError(-32602, "topicOrFile must be a string");
    }
    const trimmed = p.topicOrFile.trim();
    if (trimmed.length < MIN_TOPIC_LEN || trimmed.length > MAX_TOPIC_LEN) {
      throw new AgentsRpcError(
        -32602,
        `topicOrFile must be ${MIN_TOPIC_LEN}..${MAX_TOPIC_LEN} chars after trim`,
      );
    }
    out.topicOrFile = trimmed;
  }
  if (p.limit !== undefined) {
    if (
      typeof p.limit !== "number" ||
      !Number.isInteger(p.limit) ||
      p.limit < 1 ||
      p.limit > MAX_LIMIT
    ) {
      throw new AgentsRpcError(-32602, `limit must be an integer in 1..${MAX_LIMIT}`);
    }
    out.limit = p.limit;
  }
  return out;
}

export function requireImpactParams(params: unknown): {
  fileOrPrUrl: string;
  depth?: number;
  service?: string;
} {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.impact requires { fileOrPrUrl: string }");
  }
  const p = params as { fileOrPrUrl?: unknown; depth?: unknown; service?: unknown };
  if (typeof p.fileOrPrUrl !== "string") {
    throw new AgentsRpcError(-32602, "fileOrPrUrl must be a string");
  }
  const trimmed = p.fileOrPrUrl.trim();
  if (trimmed.length < MIN_FILE_LEN || trimmed.length > MAX_FILE_LEN) {
    throw new AgentsRpcError(
      -32602,
      `fileOrPrUrl must be ${MIN_FILE_LEN}..${MAX_FILE_LEN} chars after trim`,
    );
  }
  const out: { fileOrPrUrl: string; depth?: number; service?: string } = { fileOrPrUrl: trimmed };
  if (p.depth !== undefined) {
    if (
      typeof p.depth !== "number" ||
      !Number.isInteger(p.depth) ||
      p.depth < MIN_DEPTH ||
      p.depth > MAX_IMPACT_DEPTH
    ) {
      throw new AgentsRpcError(
        -32602,
        `depth must be an integer in ${MIN_DEPTH}..${MAX_IMPACT_DEPTH}`,
      );
    }
    out.depth = p.depth;
  }
  const service = optionalBoundedString(p.service, "service", MAX_SERVICE_LEN);
  if (service !== undefined) out.service = service;
  return out;
}

type SinceAndServiceParams = { sinceMs?: number; service?: string };

/**
 * `agents.catchup`'s parameters — and `agents.changelog`'s, which are the same surface under the
 * same bounds: an optional window and an optional service. The two differ only in the method the
 * payload refusal names, so they share this validator rather than carrying two copies of it.
 *
 * The signature stays on ONE line: `scripts/structure-audit/check-agent-param-kinds.ts` reads this
 * file line by line and ends a validator's span once its brace count is back to zero, so a
 * parameter list wrapped before the body's `{` would hide every field below it from that audit.
 */
export function requireCatchupParams(params: unknown, method: string): SinceAndServiceParams {
  requireObjectPayload(params, method);
  const p = params as { sinceMs?: unknown; service?: unknown };
  const out: SinceAndServiceParams = {};
  const sinceMs = optionalSinceMs(p.sinceMs, MAX_SINCE_MS, "90 days");
  if (sinceMs !== undefined) out.sinceMs = sinceMs;
  const service = optionalBoundedString(p.service, "service", MAX_SERVICE_LEN);
  if (service !== undefined) out.service = service;
  return out;
}

/**
 * True when an http(s)-shaped URL carries userinfo (`user:pass@host`).
 * `new URL()` parses that happily, and forwarding it downstream would land
 * plaintext credentials in the brief's `query.ref` and get rendered back in
 * the miss line — this repo's rule is explicit: never store plaintext
 * credentials in logs, IPC messages, configuration, or source. This is the
 * durable fix: every caller of `agents.why` (the browser extension included)
 * goes through this validator, not just the CLI. An unparseable `prUrl` has
 * nothing to check here; `resolveItemByUrl` rejects it later as
 * `unresolvable_url`.
 */
export function prUrlHasCredentials(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return false;
  }
}

/**
 * One URL-shaped arm's value, validated.
 *
 * Extracted so `prUrl` and `itemUrl` cannot drift apart: both come off a browser address
 * bar, so both need the same length bound and the same userinfo rejection. A second copy
 * of these three checks is a second thing to remember to update.
 */
export function requireUrlArm(value: unknown, name: "prUrl" | "itemUrl"): string {
  if (typeof value !== "string") {
    throw new AgentsRpcError(-32602, `${name} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PR_URL_LEN) {
    throw new AgentsRpcError(-32602, `${name} must be 1..${MAX_PR_URL_LEN} chars after trim`);
  }
  if (prUrlHasCredentials(trimmed)) {
    throw new AgentsRpcError(-32602, `${name} must not contain userinfo (user:pass@) credentials`);
  }
  return trimmed;
}

export function requireHuddleParams(params: unknown): { sinceMs?: number; namespaces: string[] } {
  requireObjectPayload(params, "agents.huddle");
  const p = params as { sinceMs?: unknown; namespace?: unknown; namespaces?: unknown };
  const out: { sinceMs?: number; namespaces: string[] } = { namespaces: parseNamespaces(p) };
  const sinceMs = optionalSinceMs(p.sinceMs, MAX_SINCE_MS, "90 days");
  if (sinceMs !== undefined) out.sinceMs = sinceMs;
  return out;
}
