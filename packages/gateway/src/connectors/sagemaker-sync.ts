import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { awsCliJson, awsCredentialsExtra } from "./_lib/aws-cli.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSagemakerModelToItem } from "./sagemaker-model-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "sagemaker";
const CURSOR_PREFIX = "nimbus-sm1:";

// Page caps — single forward pass per cycle (mirrors Athena/CloudWatch caps).
const MAX_MODELS = 500;
const PAGE_SIZE = 50;
// Per-model `describe-model` enrichment is page-capped: a small budget for the
// richer METADATA (container image, model-data S3 pointer, execution role).
const MAX_DESCRIBE = 50;

type SagemakerCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies SagemakerCursorV1);
}

/** Injectable AWS-CLI runner — defaults to the shared `awsCliJson` spawn; tests pass a stub. */
export type RunAwsCli = (
  ctx: SyncContext,
  args: string[],
) => Promise<{ ok: boolean; text: string }>;

export type SagemakerSyncableOptions = {
  ensureSagemakerMcpRunning: () => Promise<void>;
  /** Override the AWS-CLI runner (dependency injection for tests). */
  runAwsCli?: RunAwsCli;
};

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function nextToken(parsed: unknown): string | null {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return null;
  }
  const tok = stringField(rec, "NextToken");
  return tok !== undefined && tok !== "" ? tok : null;
}

function extractArray(parsed: unknown, key: string): unknown[] {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return [];
  }
  const arr = rec[key];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Guard a value before it is passed as a positional/flag-value to the spawned
 * `aws` CLI. Spawns use an argv array (no shell), but a value beginning with `-`
 * would be parsed by the CLI as a FLAG (argv flag smuggling). Model names come
 * from `list-models` output here, but this is defense-in-depth: a value that is
 * empty, starts with `-`, or carries a control character is rejected so it is
 * never used in a `describe-model` argv.
 */
function isSafeCliArg(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) < 0x20) {
      return false;
    }
  }
  return true;
}

interface DescribeEnrichment {
  readonly containerImage?: string;
  readonly modelDataUrl?: string;
  readonly executionRoleArn?: string;
}

/**
 * Best-effort `aws sagemaker describe-model --model-name <name>` for richer
 * METADATA (primary-container image ref, model-data S3 URL pointer, execution
 * role). The `<name>` is guarded against argv flag smuggling before use. Stores
 * a pointer (the S3 URI string) and references — NEVER weights / training data.
 * A failure or unsafe name yields an empty enrichment.
 */
async function describeModel(
  run: RunAwsCli,
  ctx: SyncContext,
  modelName: string,
): Promise<{ enrichment: DescribeEnrichment; bytes: number }> {
  if (!isSafeCliArg(modelName)) {
    return { enrichment: {}, bytes: 0 };
  }
  const res = await run(ctx, ["sagemaker", "describe-model", "--model-name", modelName]);
  const bytes = res.text.length;
  if (!res.ok) {
    return { enrichment: {}, bytes };
  }
  const rec = asRecord(parseJson(res.text));
  if (rec === undefined) {
    return { enrichment: {}, bytes };
  }
  const container = asRecord(rec["PrimaryContainer"]);
  const containerImage = container !== undefined ? stringField(container, "Image") : undefined;
  const modelDataUrl = container !== undefined ? stringField(container, "ModelDataUrl") : undefined;
  const executionRoleArn = stringField(rec, "ExecutionRoleArn");
  const enrichment: DescribeEnrichment = {
    ...(containerImage !== undefined ? { containerImage } : {}),
    ...(modelDataUrl !== undefined ? { modelDataUrl } : {}),
    ...(executionRoleArn !== undefined ? { executionRoleArn } : {}),
  };
  return { enrichment, bytes };
}

export function createSagemakerSyncable(options: SagemakerSyncableOptions): Syncable {
  const run = options.runAwsCli ?? awsCliJson;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureSagemakerMcpRunning();

      // SageMaker (Tier-3, metadata-only) reuses the existing AWS credentials.
      const extra = await awsCredentialsExtra(ctx);
      if (extra === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let token: string | null = null;
      let seen = 0;
      let described = 0;
      let page = 0;

      while (seen < MAX_MODELS) {
        const args = ["sagemaker", "list-models", "--max-results", String(PAGE_SIZE)];
        if (token !== null && token !== "") {
          args.push("--next-token", token);
        }
        const res = await run(ctx, args);
        totalBytes += res.text.length;
        if (!res.ok) {
          if (page === 0) {
            // Graceful empty pass — no throw past the Syncable boundary.
            return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
          }
          break;
        }
        const parsed = parseJson(res.text);
        for (const entry of extractArray(parsed, "Models")) {
          if (seen >= MAX_MODELS) {
            break;
          }
          seen += 1;
          const rec = asRecord(entry);
          const modelName = rec === undefined ? undefined : stringField(rec, "ModelName");
          let enrichment: DescribeEnrichment = {};
          if (modelName !== undefined && modelName !== "" && described < MAX_DESCRIBE) {
            described += 1;
            const d = await describeModel(run, ctx, modelName);
            totalBytes += d.bytes;
            enrichment = d.enrichment;
          }
          const mapped = mapSagemakerModelToItem(entry, { syncedAt: now, ...enrichment });
          if (mapped !== null) {
            upsertIndexedItemForSync(ctx, mapped);
            totalUpserted += 1;
          }
        }
        token = nextToken(parsed);
        page += 1;
        if (token === null) {
          break;
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
