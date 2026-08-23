import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { nimbusSpawn } from "../../shared/nimbus-spawn.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import { assertSafeCliArg } from "../../shared/safe-cli-arg.ts";

/**
 * GCP Cloud Logging (Tier-3, no-row-data) MCP tool surface. ALL tools index log
 * routing SINK configuration metadata only (sink name, destination, filter
 * expression, description, disabled flag, create/update timestamps). NONE read
 * log ENTRIES / row data — there is NO `gcloud logging read`, NO
 * `gcloud logging entries list`, NO tail. The names are introspected by the
 * `assertNoRowDataTools` contract test, so they must never contain a row-data
 * segment (read/entries/events/query/results/scan/tail/…). (`read` is not a
 * denylisted segment, but the commands the tools shell out to are sinks-only.)
 */
export const CLOUD_LOGGING_TOOL_NAMES = [
  "cloud_logging_list",
  "cloud_logging_get",
  "cloud_logging_search",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

function asArray(parsed: unknown): unknown[] {
  return Array.isArray(parsed) ? parsed : [];
}

/** The configured GCP project id, if `GOOGLE_CLOUD_PROJECT` is set at spawn. */
function projectArgs(): string[] {
  const project = process.env["GOOGLE_CLOUD_PROJECT"]?.trim();
  return project !== undefined && project !== "" ? ["--project", project] : [];
}

/**
 * Run `gcloud logging <args> --format json` and parse stdout. gcloud reads
 * Application Default Credentials from `GOOGLE_APPLICATION_CREDENTIALS`
 * natively from the process env injected at spawn time. Throws on non-zero exit.
 */
async function gcloudLogging(args: string[]): Promise<unknown> {
  const { code, stdout, stderr } = await nimbusSpawn(
    ["gcloud", "logging", ...args, ...projectArgs(), "--format", "json"],
    {},
  );
  const out = stdout.trim();
  const err = stderr.trim();
  if (code !== 0) {
    throw new Error(`gcloud logging ${args[0] ?? ""} failed: ${err.slice(0, 400)}`);
  }
  return out === "" ? [] : (JSON.parse(out) as unknown);
}

function sinkMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const needle = q.toLowerCase();
  return (
    strField(entry, "name").toLowerCase().includes(needle) ||
    strField(entry, "filter").toLowerCase().includes(needle) ||
    strField(entry, "destination").toLowerCase().includes(needle)
  );
}

/**
 * Register the read-only, metadata-only Cloud Logging tools onto the given
 * registrar. Shared between `server.ts` (live) and the contract test
 * (introspection).
 */
export function registerCloudLoggingTools(reg: ZodToolRegistrar): void {
  reg(
    "cloud_logging_list",
    "List GCP Cloud Logging routing SINKS — METADATA ONLY (`gcloud logging sinks list`). Each entry carries `name`, `destination`, `filter`, `description`, `disabled`, `createTime`, and `updateTime`. Never reads log-entry contents / row data.",
    z.object({}),
    async () => {
      return jsonResult(asArray(await gcloudLogging(["sinks", "list"])));
    },
  );

  reg(
    "cloud_logging_get",
    "Fetch one Cloud Logging routing sink's configuration METADATA (`gcloud logging sinks describe <sink>`). Returns the sink's `name`, `destination`, `filter`, `description`, `disabled` flag, and create/update timestamps. No log-entry contents are returned — metadata only.",
    z.object({
      sinkName: z.string().min(1),
    }),
    async (p) => {
      // `sinkName` is a bare positional to `gcloud logging sinks describe`; guard
      // against argv flag smuggling (a value beginning with "-" would be parsed as
      // a gcloud flag).
      return jsonResult(
        await gcloudLogging(["sinks", "describe", assertSafeCliArg(p.sinkName, "sinkName")]),
      );
    },
  );

  reg(
    "cloud_logging_search",
    "Substring search over Cloud Logging routing SINK names, filters, and destinations (case-insensitive) — METADATA ONLY. Returns a `{ matches: [...] }` envelope of `gcloud logging sinks list` metadata entries matching the query. Never reads log-entry contents / row data.",
    z.object({
      query: z.string().min(1),
    }),
    async (p) => {
      const sinks = asArray(await gcloudLogging(["sinks", "list"]));
      const matches = sinks.filter((s) => sinkMatches(s, p.query));
      return jsonResult({ matches });
    },
  );
}
