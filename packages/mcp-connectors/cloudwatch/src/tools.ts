import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { nimbusSpawn } from "../../shared/nimbus-spawn.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import { isSafeCliArg } from "../../shared/safe-cli-arg.ts";

/**
 * A log-group name / prefix passed as a value to the `aws logs` CLI. Rejected at
 * the schema boundary if it begins with `-` (argv flag smuggling) or contains
 * control characters.
 */
const cliArg = z
  .string()
  .min(1)
  .refine(isSafeCliArg, { message: 'must not start with "-" or contain control characters' });

/**
 * Amazon CloudWatch Logs (Tier-3, no-row-data) MCP tool surface. ALL tools
 * index log-GROUP metadata only (group name, ARN, retention, stored bytes,
 * creation time, metric-filter count) plus optional stream METADATA (stream
 * name, last-event timestamp, stored bytes). NONE fetch log-event contents /
 * row data — there is NO `get-log-events`, NO `filter-log-events`, NO
 * `start-query`, NO `get-query-results`, NO `tail`. The names are introspected
 * by the `assertNoRowDataTools` contract test, so they must never contain a
 * row-data segment (events/query/results/scan/tail/…).
 */
export const CLOUDWATCH_TOOL_NAMES = [
  "cloudwatch_list",
  "cloudwatch_get",
  "cloudwatch_search",
] as const;

const LIMIT = "50";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

function asArray(parsed: unknown, key: string): unknown[] {
  if (!isRecord(parsed)) {
    return [];
  }
  const arr = parsed[key];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Run `aws logs <args> --output json` and parse stdout. The AWS CLI reads
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION / AWS_PROFILE
 * natively from the process env injected at spawn time. Throws on non-zero exit.
 */
async function logsCli(args: string[]): Promise<unknown> {
  const { code, stdout, stderr } = await nimbusSpawn(
    ["aws", "logs", ...args, "--output", "json"],
    {},
  );
  const out = stdout.trim();
  const err = stderr.trim();
  if (code !== 0) {
    throw new Error(`aws logs ${args[0] ?? ""} failed: ${err.slice(0, 400)}`);
  }
  return out === "" ? {} : (JSON.parse(out) as unknown);
}

function groupMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return strField(entry, "logGroupName").toLowerCase().includes(q.toLowerCase());
}

/**
 * Register the read-only, metadata-only CloudWatch Logs tools onto the given
 * registrar. Shared between `server.ts` (live) and the contract test
 * (introspection).
 */
export function registerCloudwatchTools(reg: ZodToolRegistrar): void {
  reg(
    "cloudwatch_list",
    "List CloudWatch log GROUPS — METADATA ONLY (`aws logs describe-log-groups`). Each entry carries `logGroupName`, `arn`, `creationTime`, `retentionInDays`, `storedBytes`, and `metricFilterCount`. Optionally filter by a `prefix` on the log-group name. Never fetches log-event contents / row data.",
    z.object({
      prefix: cliArg.optional(),
    }),
    async (p) => {
      const args = ["describe-log-groups", "--limit", LIMIT];
      if (p.prefix !== undefined) {
        args.push("--log-group-name-prefix", p.prefix);
      }
      return jsonResult(await logsCli(args));
    },
  );

  reg(
    "cloudwatch_get",
    "Fetch one CloudWatch log group's METADATA plus a stream summary. Returns the matching `describe-log-groups` entry (name, ARN, retention, stored bytes, metric-filter count) and the group's `describe-log-streams` METADATA (stream names, last-event timestamps, stored bytes) ordered by last activity. No log-event contents are returned — metadata only.",
    z.object({
      logGroupName: cliArg,
    }),
    async (p) => {
      const group = await logsCli([
        "describe-log-groups",
        "--log-group-name-prefix",
        p.logGroupName,
        "--limit",
        LIMIT,
      ]);
      const match = asArray(group, "logGroups").find(
        (g) => isRecord(g) && strField(g, "logGroupName") === p.logGroupName,
      );
      const streams = await logsCli([
        "describe-log-streams",
        "--log-group-name",
        p.logGroupName,
        "--order-by",
        "LastEventTime",
        "--descending",
        "--limit",
        LIMIT,
      ]);
      return jsonResult({
        logGroup: match ?? null,
        streams: asArray(streams, "logStreams"),
      });
    },
  );

  reg(
    "cloudwatch_search",
    "Substring search over CloudWatch log GROUP names (case-insensitive) — METADATA ONLY. Returns a `{ matches: [...] }` envelope of `describe-log-groups` metadata entries whose `logGroupName` contains the query. Never fetches log-event contents / row data.",
    z.object({
      query: z.string().min(1),
    }),
    async (p) => {
      const root = await logsCli(["describe-log-groups", "--limit", LIMIT]);
      const matches = asArray(root, "logGroups").filter((g) => groupMatches(g, p.query));
      return jsonResult({ matches });
    },
  );
}
