import {
  formatBatchCaveat,
  formatGapLine,
  isMissingSubstrateRefusal,
  type MissingSubstrateRefusal,
  type NegationExplain,
  printExplainBlock,
  printRefusal,
} from "../lib/negation-output.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) {
    return undefined;
  }
  return args[i + 1];
}

/**
 * Mirrors `CORRELATION_WINDOW_MS` (`packages/gateway/src/graph/graph-populator.ts`,
 * re-exported for exactly this purpose from `gateway/src/index/negation-predicates.ts`).
 * The CLI cannot import gateway source — `cli-no-import-gateway` in `.dependency-cruiser.cjs`,
 * enforced by `bun run audit:boundaries`, which is in `preflight:fast`'s fast tier — so this
 * is a hand-maintained mirror rather than a live import, matching the same constraint's
 * existing resolution in this codebase (`commands/prove.ts`'s `COVERAGE_CLASS_LABELS`,
 * `commands/share.ts`'s inlined `formatAttributionChipInline`). Unlike those two, this value
 * IS pinned against drift: `query.test.ts` imports the real gateway constant in a TEST file,
 * which `.dependency-cruiser.cjs`'s `exclude` list exempts from the boundary check, and
 * asserts the two are equal — so a change to the gateway constant with no matching update
 * here fails that test rather than silently printing a stale window.
 */
export const CORRELATION_WINDOW_MS_CLI_MIRROR = 2 * 60 * 60 * 1000;

function formatDurationMs(ms: number): string {
  if (ms % (60 * 60 * 1000) === 0) {
    return `${String(ms / (60 * 60 * 1000))}h`;
  }
  if (ms % (60 * 1000) === 0) {
    return `${String(ms / (60 * 1000))}m`;
  }
  return `${String(ms)}ms`;
}

const QUERY_HELP = `nimbus query — structured index reads (Gateway IPC)

Usage:
  nimbus query --service <id> [--type <t>] [--since 7d] [--limit N] [--json | --pretty]
  nimbus query --sql "SELECT ..." [--json | --pretty]   (read-only guard)

Negation predicates (each requires its --type; an empty substrate refuses with exit 1):
  nimbus query --service <id> --type pr         --not-touching '<glob>'
  nimbus query --service <id> --type deployment --no-downstream-incident

  --not-touching <glob> is SQLite GLOB over repo-relative, POSIX-separated paths:
    * crosses / , so ** and * behave identically and a minimatch intuition does not hold
    matching is CASE-SENSITIVE
    a pattern with no wildcard is an exact path, not a prefix — packages/gateway
      matches no file, while packages/gateway/** matches the tree
    a backslash separator or a leading / or ./ is refused, since none can ever match
  The "Gaps:" line reports how many indexed paths your pattern matched. Zero means
  NOTHING was filtered out and every row shown is unfiltered.

  Excluded-but-unverifiable rows are always counted on that same "Gaps:" line — the
  accounting is part of the answer, not debug output. --no-downstream-incident's
  correlation window is fixed at write time; there is deliberately no --within.

  --explain   print the composed SQL, its bound params, and the substrate probe
              (works on every query, not only a negation one)

Output:
  TTY (default)  → human-readable cards
  piped (default)→ compact JSON, one row per array (jq-friendly)
  --json         → pretty JSON (2-space indent), good for inspection
  --pretty       → force cards even when piped
`;

/**
 * Guards on `--not-touching` / `--no-downstream-incident`, all of which must run BEFORE any IPC
 * call. Split out of `runQuery` for cognitive complexity (S3776); the reasoning for each is
 * unchanged and lives with the check it justifies.
 */
function validateNegationFlags(f: {
  type: string | undefined;
  notTouchingRequested: boolean;
  notTouchingRaw: string | undefined;
  noDownstreamIncident: boolean;
}): void {
  // Scoping validated BEFORE any IPC call (non-negotiable): unscoped, `--not-touching`
  // would return every issue, message and commit — all of which trivially "do not touch"
  // any path, because they cannot touch anything. Checked on the REQUEST (whether the flag
  // was supplied), not on its parsed value, so a present-but-blank `--not-touching ''` still
  // trips the guard rather than silently skipping it.
  if (f.notTouchingRequested && f.type !== "pr") {
    throw new Error("--not-touching requires --type pr");
  }
  // A SUPPLIED flag must never become an OMITTED filter. `takeFlag` returns `args[i + 1]`
  // verbatim, so `--not-touching` at the end of argv yields `undefined` and a blank one yields
  // `""` — both would drop `notTouching` from the params below and answer "every PR" to a caller
  // who asked "PRs not touching X". The gateway cannot catch that: an absent param is
  // indistinguishable there from a caller who never asked. The option-token case is the same
  // failure wearing a value — `--not-touching --json` sends `"--json"` as the glob, a pattern
  // that matches no path, so EVERY covered PR comes back as "not touching" with no gap or
  // refusal to signal it.
  if (f.notTouchingRequested) {
    if (f.notTouchingRaw === undefined || f.notTouchingRaw.trim() === "") {
      throw new Error("--not-touching requires a glob pattern (e.g. --not-touching 'tests/**')");
    }
    if (f.notTouchingRaw.startsWith("--")) {
      throw new Error(
        `--not-touching requires a glob pattern, got the option "${f.notTouchingRaw}" ` +
          "(quote the pattern if it really starts with --)",
      );
    }
  }
  if (f.noDownstreamIncident && f.type !== "deployment") {
    throw new Error("--no-downstream-incident requires --type deployment");
  }
}

interface QueryItemsParams {
  services: string[];
  types?: string[];
  sinceMs?: number;
  limit: number;
  notTouching?: string;
  noDownstreamIncident?: boolean;
  explain?: boolean;
}

/** Omit the optionals rather than sending them undefined, so they don't appear in the request. */
function buildQueryParams(f: {
  service: string;
  type: string | undefined;
  sinceMs: number | undefined;
  limit: number;
  notTouchingRaw: string | undefined;
  noDownstreamIncident: boolean;
  explainRequested: boolean;
}): QueryItemsParams {
  const params: QueryItemsParams = {
    services: [f.service],
    limit: Number.isFinite(f.limit) && f.limit > 0 ? Math.min(1000, f.limit) : 50,
  };
  if (f.sinceMs !== undefined) {
    params.sinceMs = f.sinceMs;
  }
  if (f.type !== undefined && f.type !== "") {
    params.types = [f.type];
  }
  if (f.notTouchingRaw !== undefined && f.notTouchingRaw !== "") {
    params.notTouching = f.notTouchingRaw;
  }
  if (f.noDownstreamIncident) {
    params.noDownstreamIncident = true;
  }
  if (f.explainRequested) {
    params.explain = true;
  }
  return params;
}

export async function runQuery(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(QUERY_HELP);
    return;
  }

  const sql = takeFlag(args, "--sql");
  const wantJson = args.includes("--json");
  const pretty = args.includes("--pretty");

  if (sql !== undefined) {
    const r = await withGatewayIpc((c) =>
      c.call<{ rows: Record<string, unknown>[]; meta: { count: number } }>("index.querySql", {
        sql,
      }),
    );
    printRows(r.rows, wantJson, pretty);
    return;
  }

  const service = takeFlag(args, "--service");
  if (service === undefined || service === "") {
    throw new Error("Missing --service (or use --sql for guarded SELECT)");
  }
  const type = takeFlag(args, "--type");
  const sinceRaw = takeFlag(args, "--since");
  const limitRaw = takeFlag(args, "--limit");
  const notTouchingRequested = args.includes("--not-touching");
  const notTouchingRaw = takeFlag(args, "--not-touching");
  const noDownstreamIncident = args.includes("--no-downstream-incident");
  const explainRequested = args.includes("--explain");
  const limit = limitRaw === undefined ? Number.NaN : Number.parseInt(limitRaw, 10);

  validateNegationFlags({ type, notTouchingRequested, notTouchingRaw, noDownstreamIncident });

  const sinceMs =
    sinceRaw === undefined ? undefined : Date.now() - parseSinceDurationToMs(sinceRaw);

  const params = buildQueryParams({
    service,
    type,
    sinceMs,
    limit,
    notTouchingRaw,
    noDownstreamIncident,
    explainRequested,
  });

  const r = await withGatewayIpc((c) => c.call<QueryItemsResult>("index.queryItems", params));

  if (isMissingSubstrateRefusal(r)) {
    printRefusal(r, wantJson);
    process.exitCode = 1;
    return;
  }

  printQueryResult(r, { wantJson, pretty, noDownstreamIncident });
}

function printQueryResult(
  r: Exclude<QueryItemsResult, MissingSubstrateRefusal>,
  o: { wantJson: boolean; pretty: boolean; noDownstreamIncident: boolean },
): void {
  const isNegationResult = r.gaps !== undefined || r.explain !== undefined;
  if (o.wantJson && isNegationResult) {
    const doc: Record<string, unknown> = { ...r };
    if (o.noDownstreamIncident) {
      doc["correlationWindowMs"] = CORRELATION_WINDOW_MS_CLI_MIRROR;
    }
    console.log(JSON.stringify(doc, null, 2));
    return;
  }

  printRows(r.items, o.wantJson, o.pretty);
  if (o.wantJson) {
    return;
  }
  if (r.gaps !== undefined) {
    console.log(formatGapLine(r.gaps));
    console.log(formatBatchCaveat(r.meta));
  }
  if (o.noDownstreamIncident) {
    console.log(
      `Correlation window: ${formatDurationMs(CORRELATION_WINDOW_MS_CLI_MIRROR)} (fixed at ` +
        "write time by the deployment→incident correlator; not adjustable per-query — see " +
        "the design doc § 4.2/D5)",
    );
  }
  if (r.explain !== undefined) {
    printExplainBlock(r.explain);
  }
}

type QueryItemsGaps =
  | {
      readonly pathsMatchingGlob?: number;
      readonly excludedNoCoverage: number;
      readonly excludedTruncated: number;
    }
  | { readonly excludedNoGraphEntity: number };

type QueryItemsSuccess = {
  readonly items: Array<Record<string, unknown>>;
  readonly meta: { readonly limit: number; readonly total: number };
  readonly gaps?: QueryItemsGaps;
  readonly explain?: NegationExplain;
};

type QueryItemsResult = QueryItemsSuccess | MissingSubstrateRefusal;

function formatQueryCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
      return value.toString();
    case "object":
      return JSON.stringify(value);
    default:
      return "";
  }
}

function formatIsoLocal(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${String(sec)}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${String(min)}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${String(hr)}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${String(d)}d ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${String(mo)}mo ago`;
  return `${String(Math.round(mo / 12))}y ago`;
}

function formatTimestampField(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return formatQueryCell(value);
  }
  return `${formatIsoLocal(value)} (${formatRelative(value)})`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function isItemLikeRow(row: Record<string, unknown>): boolean {
  const hasName = typeof row["name"] === "string" || typeof row["title"] === "string";
  return typeof row["service"] === "string" && hasName;
}

function printItemCard(row: Record<string, unknown>, idx: number): void {
  const num = `${String(idx + 1)}.`;
  const nameField = row["name"] ?? row["title"];
  const title = typeof nameField === "string" ? nameField : "(untitled)";
  const typeField = row["itemType"] ?? row["type"];
  const timestampField = row["modifiedAt"] ?? row["modified_at"];
  const meta: string[] = [];
  if (typeof row["service"] === "string") meta.push(row["service"]);
  if (typeof typeField === "string") meta.push(typeField);
  if (typeof timestampField === "number") meta.push(formatTimestampField(timestampField));

  console.log(`${num.padEnd(4)} ${title}`);
  if (meta.length > 0) console.log(`     ${meta.join(" · ")}`);

  const body = typeof row["body_preview"] === "string" ? row["body_preview"] : "";
  if (body !== "" && body !== title) {
    console.log(`     ${truncate(body.replace(/\s+/g, " "), 120)}`);
  }
  const url = typeof row["url"] === "string" ? row["url"] : "";
  if (url !== "") console.log(`     ${url}`);
  console.log("");
}

function isTimestampKey(key: string): boolean {
  return key.endsWith("_at") || key.endsWith("At");
}

function printKvBlock(row: Record<string, unknown>, idx: number): void {
  console.log(`── #${String(idx + 1)} ──`);
  for (const [k, v] of Object.entries(row)) {
    const displayValue = isTimestampKey(k) ? formatTimestampField(v) : formatQueryCell(v);
    console.log(`  ${k}: ${displayValue}`);
  }
  console.log("");
}

function printRows(rows: Record<string, unknown>[], wantJson: boolean, pretty: boolean): void {
  if (wantJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const renderAsCards = pretty || (process.stdout.isTTY === true && !pretty);
  if (!renderAsCards) {
    console.log(JSON.stringify(rows));
    return;
  }
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const useCards = rows.every(isItemLikeRow);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    if (useCards) {
      printItemCard(row, i);
    } else {
      printKvBlock(row, i);
    }
  }
  console.log(
    `(${String(rows.length)} ${rows.length === 1 ? "row" : "rows"} · use --json for raw)`,
  );
}
