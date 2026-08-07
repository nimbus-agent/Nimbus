// packages/gateway/src/egress/egress-coverage.ts

/**
 * How completely a binary observed one egress class.
 * Ordered weakest-first; `weakestCoverage` relies on this order.
 */
export const GRANULARITIES = ["none", "per-run", "per-call"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

/**
 * The egress-BEARING source types. Marker classes carry no coverage claim.
 *
 * Kept in key-sorted order — `serializeCoverage` maps over this array to build the canonical
 * string stored in a boot marker's HASHED `source_id`, so the order IS the wire format. `http`
 * sorts before `mcp`, which sorts before `model`; that is why they head the list rather than
 * trailing it. Appending a new class instead of inserting it in sort order would still typecheck,
 * still round-trip within one binary, and produce a canonical string no other binary agrees with.
 */
export const COVERAGE_CLASSES = [
  "http",
  "mcp",
  "model",
  "peer",
  "session",
  "sync",
  "task",
] as const;
export type CoverageClass = (typeof COVERAGE_CLASSES)[number];

export type CoverageVector = Readonly<Record<CoverageClass, Granularity>>;

/**
 * What THIS binary is built to observe. FOUR classes are non-`none`: `task` (the executor's
 * gated-action append, `engine/executor.ts`); `mcp` and `http` — the two external transports an
 * agent brief can be served over, sharing ONE appender (`egress/agent-brief-egress.ts`, selected
 * per transport by the total `EGRESS_BEARING_CLIENT_KINDS` map); and `sync`. Later phases raise
 * `model`, `peer`, `session`; raising an entry without landing its appender is the exact defect
 * this vector exists to prevent.
 *
 * READ THE `mcp` ENTRY NARROWLY. It is `per-call` over exactly one thing: an `agents.*` brief
 * served to a client that declared `kind: "mcp"`. It is NOT "everything an MCP client does". The
 * same MCP server also exposes six read-only index tools — `searchIndex`, `getConnectorStatus`,
 * `getRecentIncidents` / `getRecentPullRequests` / `getRecentDeployments`, `getDoraMetrics` — that
 * hand raw index rows to the same editor model and append NO row at all, and the same socket's
 * `ask` / `search.query` / `glossary.*` calls append nothing either.
 *
 * That narrowing is recorded HERE, in the machine-readable claim, because this vector — not any
 * prose about it — is what gets serialized into a boot marker's HASHED `source_id` and read by
 * published `@nimbus-dev/client` consumers. The `nimbus prove` display label
 * (`COVERAGE_CLASS_LABELS` in `packages/cli/src/commands/prove.ts`) says the same thing for a human
 * reader and is a hand-maintained mirror, since the CLI cannot import this module. `source_type`
 * strings are permanent in the data, so a class whose appender covers less than its NAME suggests
 * must say so at the point the claim is made, not only at the point it is rendered.
 *
 * READ THE `http` ENTRY THE SAME WAY, and more narrowly still. It is `per-call` over exactly one
 * thing: an `agents.*` brief served to a caller verified on the local HTTP API. It is
 * NOT "everything on the HTTP API". `GET /v1/items`, `GET /v1/items/resolve`, `GET /v1/people`,
 * `GET /v1/audit` and the rest of the read surface hand index rows to a local process and append
 * NO row. `GET /v1/items/resolve` is called out by name because it is the newest of them and the
 * one most likely to be mistaken for egress: it takes a URL from an external caller and answers
 * from the LOCAL index without any outbound request. Conversely a targeted connector fetch on the
 * same port WILL append, but under `sync`, not `http` — the class tracks the kind of egress, not
 * the port it arrived on.
 *
 * READ THE `sync` ENTRY AS `per-run`, WHICH IS WEAKER THAN `per-call` AND DELIBERATELY SO. It has
 * TWO appenders: the scheduler's sync-run boundary (`sync/scheduler.ts` `runJob`) and the targeted
 * single-item fetch (`sync/targeted-fetch.ts`, reached by `POST /v1/items/fetch`). A scheduled sync
 * is a paginated run that makes many upstream calls and appends ONE row, so the ledger proves that
 * a sync of that service happened in the window — not how many requests it made. A targeted fetch
 * appends one row for its one call. Both name the service id as `destination`.
 */
export const THIS_BINARY_COVERAGE: CoverageVector = {
  task: "per-call",
  mcp: "per-call",
  http: "per-call",
  sync: "per-run",
  session: "none",
  model: "none",
  peer: "none",
};

/**
 * Claims nothing about any class. Used as the contribution of an UNPARSEABLE boot marker, so the
 * weakest-merge drives the whole window to `none` (→ `indeterminate`) rather than letting a
 * sibling marker's richer claim stand unchallenged.
 */
export const ALL_NONE_COVERAGE: CoverageVector = {
  task: "none",
  mcp: "none",
  http: "none",
  session: "none",
  sync: "none",
  model: "none",
  peer: "none",
};

/** Stable, key-sorted serialization. Stored in the HASHED `source_id`, so it must be canonical. */
export function serializeCoverage(v: CoverageVector): string {
  return COVERAGE_CLASSES.map((c) => `${c}=${v[c]}`).join(";");
}

function isGranularity(s: string): s is Granularity {
  return (GRANULARITIES as readonly string[]).includes(s);
}

/**
 * Parse; returns null (never a guess, never a partial vector) unless the string is EXACTLY the
 * canonical `serializeCoverage` shape: every `;`-segment is a single `key=value` pair (no extra
 * `=`), every key is a known `CoverageClass`, every key appears at most once, and every class is
 * present with a recognized `Granularity`.
 *
 * This is deliberately strict — a marker written by a NEWER binary that adds an unknown coverage
 * class, or that is merely malformed, must be REJECTED (→ `null`, which the caller turns into
 * `ALL_NONE_COVERAGE`) rather than silently accepted with the unknown/duplicate/extra data
 * dropped. Accepting-and-ignoring would let that marker contribute real (understated but
 * plausible-looking) coverage instead of forcing the window to `indeterminate` — exactly the
 * forward-compatibility failure this function exists to prevent.
 */
export function parseCoverage(s: string): CoverageVector | null {
  const found = new Map<string, string>();
  for (const part of s.split(";")) {
    const eq = part.split("=");
    if (eq.length !== 2) return null; // not exactly one `key=value` pair (0 or ≥2 `=` signs)
    const [k, val] = eq as [string, string];
    if (!(COVERAGE_CLASSES as readonly string[]).includes(k)) return null; // unknown key
    if (found.has(k)) return null; // duplicate key
    found.set(k, val);
  }
  const out: Partial<Record<CoverageClass, Granularity>> = {};
  for (const c of COVERAGE_CLASSES) {
    const val = found.get(c);
    if (val === undefined || !isGranularity(val)) return null;
    out[c] = val;
  }
  return out as CoverageVector;
}

/**
 * The weakest granularity per class across every binary that wrote into a window.
 *
 * An EMPTY list yields all-`none`: with no boot marker there is no evidence of any coverage, and
 * the correct response is to claim nothing.
 */
export function weakestCoverage(vs: readonly CoverageVector[]): CoverageVector {
  const out: Partial<Record<CoverageClass, Granularity>> = {};
  for (const c of COVERAGE_CLASSES) {
    let weakest: Granularity = "none";
    if (vs.length > 0) {
      weakest = vs.reduce<Granularity>((acc, v) => {
        return GRANULARITIES.indexOf(v[c]) < GRANULARITIES.indexOf(acc) ? v[c] : acc;
      }, "per-call");
    }
    out[c] = weakest;
  }
  return out as CoverageVector;
}
