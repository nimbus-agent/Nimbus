import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { nimbusSpawn } from "../../shared/nimbus-spawn.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import { isSafeCliArg } from "../../shared/safe-cli-arg.ts";

/**
 * A value passed to the `gcloud ai` CLI (a Vertex AI region like `us-central1`
 * or a model id). Rejected at the schema boundary if it begins with `-` (argv
 * flag smuggling) or contains control characters. Exported so the contract test
 * can assert the guard rejects a `-`-prefixed value.
 */
export const cliArg = z
  .string()
  .min(1)
  .refine(isSafeCliArg, { message: 'must not start with "-" or contain control characters' });

/**
 * GCP Vertex AI (Tier-3, no-row-data) MCP tool surface. ALL tools index Vertex
 * AI model REGISTRY metadata only (model resource name, display name, version
 * id, region, create/update timestamps). NONE call inference / prediction —
 * there is NO `gcloud ai endpoints predict`, NO `explain`, NO `raw-predict`, NO
 * batch-prediction output read. The names are introspected by the
 * `assertNoRowDataTools` contract test, so they must never contain a row-data
 * segment (predict/query/records/results/scan/sample/…).
 */
export const VERTEX_AI_TOOL_NAMES = [
  "vertex_ai_list",
  "vertex_ai_get",
  "vertex_ai_search",
] as const;

const DEFAULT_REGION = "us-central1";

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
 * Resolve the Vertex AI region: an explicit tool argument wins, else the
 * `VERTEX_AI_REGION` env injected at spawn, else `us-central1`. The result is a
 * raw, unguarded string — callers must pass it through `cliArg`/`isSafeCliArg`
 * (or the schema) before handing it to gcloud.
 */
function resolveRegion(explicit?: string): string {
  const e = (explicit ?? process.env["VERTEX_AI_REGION"])?.trim();
  return e !== undefined && e !== "" ? e : DEFAULT_REGION;
}

/**
 * Run `gcloud ai <args> --region <region> --format json` and parse stdout.
 * gcloud reads Application Default Credentials from
 * `GOOGLE_APPLICATION_CREDENTIALS` natively from the process env injected at
 * spawn time. The `<region>` is `isSafeCliArg`-guarded before use (argv flag
 * smuggling). Throws on non-zero exit.
 */
async function gcloudAi(args: string[], region: string): Promise<unknown> {
  const regionPreview = region.slice(0, 64);
  if (!isSafeCliArg(region)) {
    throw new Error(`Invalid region: ${regionPreview}`);
  }
  const { code, stdout, stderr } = await nimbusSpawn(
    ["gcloud", "ai", ...args, "--region", region, ...projectArgs(), "--format", "json"],
    {},
  );
  const out = stdout.trim();
  const err = stderr.trim();
  if (code !== 0) {
    throw new Error(`gcloud ai ${args[0] ?? ""} failed: ${err.slice(0, 400)}`);
  }
  return out === "" ? [] : (JSON.parse(out) as unknown);
}

function modelMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const needle = q.toLowerCase();
  return (
    strField(entry, "displayName").toLowerCase().includes(needle) ||
    strField(entry, "name").toLowerCase().includes(needle)
  );
}

/**
 * Register the read-only, metadata-only Vertex AI tools onto the given
 * registrar. Shared between `server.ts` (live) and the contract test
 * (introspection).
 */
export function registerVertexAiTools(reg: ZodToolRegistrar): void {
  reg(
    "vertex_ai_list",
    "List GCP Vertex AI models in a region — METADATA ONLY (`gcloud ai models list`). Each entry carries the model `name` (resource path), `displayName`, `versionId`, `createTime`, and `updateTime`. Optional `region` defaults to the configured region (else us-central1). Never calls inference / prediction; never fetches model outputs.",
    z.object({
      region: cliArg.optional(),
    }),
    async (p) => {
      const region = resolveRegion(p.region);
      return jsonResult(asArray(await gcloudAi(["models", "list"], region)));
    },
  );

  reg(
    "vertex_ai_get",
    "Fetch one GCP Vertex AI model's METADATA (`gcloud ai models describe <model> --region <region>`). Returns the model object including `name`, `displayName`, `versionId`, and create/update timestamps. The `modelId` and `region` are guarded against argv flag smuggling before use. No inference, prediction, or model-output data is returned — registry metadata only.",
    z.object({
      modelId: cliArg,
      region: cliArg.optional(),
    }),
    async (p) => {
      const region = resolveRegion(p.region);
      return jsonResult(await gcloudAi(["models", "describe", p.modelId], region));
    },
  );

  reg(
    "vertex_ai_search",
    "Substring search over GCP Vertex AI model display names + resource names (case-insensitive) — METADATA ONLY. Returns a `{ matches: [...] }` envelope of `gcloud ai models list` metadata entries matching the query. Optional `region` defaults to the configured region (else us-central1). Never calls inference / prediction.",
    z.object({
      query: z.string().min(1),
      region: cliArg.optional(),
    }),
    async (p) => {
      const region = resolveRegion(p.region);
      const models = asArray(await gcloudAi(["models", "list"], region));
      const matches = models.filter((m) => modelMatches(m, p.query));
      return jsonResult({ matches });
    },
  );
}
