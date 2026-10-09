/**
 * The `pr` metadata contract shared by every forge writer (GitHub, Bitbucket, GitLab). Same rules
 * as `ci-run-meta.ts`: canonical keys only for readers, omission over guessing, exact-match
 * normalization, colliding raw keys stripped by the builder.
 *
 * Normalizers return `undefined` when the provider sent NO value (so the writer omits `state` and
 * a carry-forward can fill it from the stored row) and `"unknown"` when it sent one this module
 * does not recognise.
 */

/** Bump when a mapper starts writing a key consumers may rely on. Drives `rebody` eligibility. */
export const PR_META_VERSION = 1;

export type PrService = "github" | "bitbucket" | "gitlab";

export type PrState = "open" | "merged" | "closed" | "unknown";

export type CanonicalPrKey =
  | "state"
  | "state_raw"
  | "merged"
  | "opened_at_ms"
  | "merged_at"
  | "repo"
  | "meta_v";

export const CANONICAL_PR_KEYS: readonly CanonicalPrKey[] = [
  "state",
  "state_raw",
  "merged",
  "opened_at_ms",
  "merged_at",
  "repo",
  "meta_v",
];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_PR_KEYS);

/**
 * Which canonical keys each forge CAN emit (see `ci-run-meta.ts`'s `CI_RUN_EMITTED_KEYS`).
 * Bitbucket's PR resource has no merge timestamp, and `updated_on` is not one. GitLab emits both
 * timestamps from its `opened`/`accepted` transition events and from `fetchOne`; an MR whose
 * opening predates the sync window simply lacks the key on its row (per-row absence = unknown).
 */
export const PR_EMITTED_KEYS: Readonly<Record<PrService, ReadonlySet<CanonicalPrKey>>> = {
  github: new Set<CanonicalPrKey>(CANONICAL_PR_KEYS),
  bitbucket: new Set<CanonicalPrKey>([
    "state",
    "state_raw",
    "merged",
    "opened_at_ms",
    "repo",
    "meta_v",
  ]),
  gitlab: new Set<CanonicalPrKey>(CANONICAL_PR_KEYS),
};

export type PrFields = {
  readonly state?: PrState | undefined;
  readonly stateRaw?: string | undefined;
  readonly openedAtMs?: number | undefined;
  readonly mergedAtMs?: number | undefined;
  readonly repo?: string | undefined;
};

function lookup(
  table: Readonly<Record<string, PrState>>,
  raw: string | undefined,
): PrState | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return Object.hasOwn(table, raw) ? (table[raw] as PrState) : "unknown";
}

const GITHUB_STATE: Readonly<Record<string, PrState>> = { open: "open", closed: "closed" };

/** GitHub reports a merged PR as `state: "closed"` with `merged: true`. */
export function normalizeGithubPrState(
  state: string | undefined,
  merged: boolean,
): PrState | undefined {
  return merged ? "merged" : lookup(GITHUB_STATE, state);
}

const BITBUCKET_STATE: Readonly<Record<string, PrState>> = {
  OPEN: "open",
  MERGED: "merged",
  DECLINED: "closed",
  SUPERSEDED: "closed",
};

export function normalizeBitbucketPrState(state: string | undefined): PrState | undefined {
  return lookup(BITBUCKET_STATE, state);
}

const GITLAB_MR_STATE: Readonly<Record<string, PrState>> = {
  opened: "open",
  merged: "merged",
  closed: "closed",
  locked: "closed",
};

/** The MR resource's own `state` (the `fetchOne` path). */
export function normalizeGitlabMrState(state: string | undefined): PrState | undefined {
  return lookup(GITLAB_MR_STATE, state);
}

const GITLAB_EVENT_TRANSITION: Readonly<Record<string, PrState>> = {
  accepted: "merged",
  merged: "merged",
  opened: "open",
  reopened: "open",
  closed: "closed",
};

/**
 * The state an events-API `action_name` moves an MR to, or `null` when the action does not change
 * state (`approved`, `updated`, comments...). A `null` means "carry the stored state forward".
 */
export function gitlabEventTransition(actionName: string | undefined): PrState | null {
  if (actionName === undefined || !Object.hasOwn(GITLAB_EVENT_TRANSITION, actionName)) {
    return null;
  }
  return GITLAB_EVENT_TRANSITION[actionName] as PrState;
}

/**
 * Integer epoch milliseconds from a number or an ISO-8601 string, or `undefined`. Never `NaN`,
 * never `0`, never a fraction: a consumer must be able to tell "no timestamp" from a real one.
 */
export function canonicalEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === "string" && value !== "") {
    const ms = Date.parse(value);
    return Number.isInteger(ms) && ms > 0 ? ms : undefined;
  }
  return undefined;
}

export function buildPrMetadata(
  raw: Readonly<Record<string, unknown>>,
  fields: PrFields,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !CANONICAL_SET.has(k)),
  );
  if (fields.state !== undefined) {
    out["state"] = fields.state;
    // `unknown` asserts nothing about merging; writing `merged: false` there would turn an
    // unrecognised vendor value into a definite "not merged" for every reader of `$.merged`.
    if (fields.state !== "unknown") {
      out["merged"] = fields.state === "merged";
    }
  }
  // `typeof` guards, not `!== undefined`: a raw vendor `null` must be omitted, not written.
  if (typeof fields.stateRaw === "string" && fields.stateRaw !== "") {
    out["state_raw"] = fields.stateRaw;
  }
  const opened = canonicalEpochMs(fields.openedAtMs);
  if (opened !== undefined) {
    out["opened_at_ms"] = opened;
  }
  const mergedAt = canonicalEpochMs(fields.mergedAtMs);
  // A merge time on a PR known NOT to be merged (reopened after close, say) would be a lie.
  if (mergedAt !== undefined && (fields.state === undefined || fields.state === "merged")) {
    out["merged_at"] = mergedAt;
  }
  if (typeof fields.repo === "string" && fields.repo !== "") {
    out["repo"] = fields.repo;
  }
  out["meta_v"] = PR_META_VERSION;
  return out;
}
