import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { nimbusSpawn } from "../../shared/nimbus-spawn.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import { isSafeCliArg } from "../../shared/safe-cli-arg.ts";

/**
 * A SageMaker model name passed as a value to the `aws sagemaker` CLI. Rejected
 * at the schema boundary if it begins with `-` (argv flag smuggling) or contains
 * control characters. Exported so the contract test can assert the guard rejects
 * a `-`-prefixed value.
 */
export const cliArg = z
  .string()
  .min(1)
  .refine(isSafeCliArg, { message: 'must not start with "-" or contain control characters' });

/**
 * Amazon SageMaker (Tier-3, metadata-only) MCP tool surface. ALL tools index
 * model-REGISTRY metadata only (model name, ARN, primary-container image
 * reference, model-data S3 URL pointer, execution-role ARN, creation time).
 * NONE fetch inference / training / model-artifact data — there is NO
 * `invoke-endpoint`, NO `sagemaker-runtime`, NO predict/query/records path. The
 * names are introspected by the `assertNoRowDataTools` contract test, so they
 * must never contain a row-data segment (invoke/predict/query/records/scan/…).
 */
export const SAGEMAKER_TOOL_NAMES = [
  "sagemaker_list",
  "sagemaker_get",
  "sagemaker_search",
] as const;

const PAGE = "50";

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
 * Run `aws sagemaker <args> --output json` and parse stdout. The AWS CLI reads
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION / AWS_PROFILE
 * natively from the process env injected at spawn time. Throws on non-zero exit.
 */
async function sagemakerCli(args: string[]): Promise<unknown> {
  const { code, stdout, stderr } = await nimbusSpawn(
    ["aws", "sagemaker", ...args, "--output", "json"],
    {},
  );
  const out = stdout.trim();
  const err = stderr.trim();
  if (code !== 0) {
    throw new Error(`aws sagemaker ${args[0] ?? ""} failed: ${err.slice(0, 400)}`);
  }
  return out === "" ? {} : (JSON.parse(out) as unknown);
}

function modelMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return strField(entry, "ModelName").toLowerCase().includes(q.toLowerCase());
}

/**
 * Register the read-only, metadata-only SageMaker tools onto the given
 * registrar. Shared between `server.ts` (live) and the contract test
 * (introspection).
 */
export function registerSagemakerTools(reg: ZodToolRegistrar): void {
  reg(
    "sagemaker_list",
    "List Amazon SageMaker models — METADATA ONLY (`aws sagemaker list-models`). Each entry carries `ModelName`, `ModelArn`, and `CreationTime`. Optionally filter by a `nameContains` substring on the model name. Never invokes an endpoint and never fetches inference / training / model-artifact data.",
    z.object({
      nameContains: cliArg.optional(),
    }),
    async (p) => {
      const args = ["list-models", "--max-results", PAGE];
      if (p.nameContains !== undefined) {
        args.push("--name-contains", p.nameContains);
      }
      return jsonResult(await sagemakerCli(args));
    },
  );

  reg(
    "sagemaker_get",
    "Fetch one Amazon SageMaker model's METADATA (`aws sagemaker describe-model`). Returns the model object including `ModelName`, `ModelArn`, `PrimaryContainer` (container `Image` reference + `ModelDataUrl` S3 pointer — a URI string, NOT the model bytes), `ExecutionRoleArn`, and `CreationTime`. No inference, training, or model-artifact data is returned — registry metadata only.",
    z.object({
      modelName: cliArg,
    }),
    async (p) => {
      return jsonResult(await sagemakerCli(["describe-model", "--model-name", p.modelName]));
    },
  );

  reg(
    "sagemaker_search",
    "Substring search over Amazon SageMaker model NAMES (case-insensitive) — METADATA ONLY. Returns a `{ matches: [...] }` envelope of `list-models` metadata entries whose `ModelName` contains the query. Never invokes an endpoint and never fetches inference / training / model-artifact data.",
    z.object({
      query: z.string().min(1),
    }),
    async (p) => {
      const root = await sagemakerCli(["list-models", "--max-results", PAGE]);
      const matches = asArray(root, "Models").filter((m) => modelMatches(m, p.query));
      return jsonResult({ matches });
    },
  );
}
