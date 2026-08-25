import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  awsCliJson,
  awsCredentialsExtra,
  parseJson,
  type RunAwsCli,
  runAwsCliPaginatedWalk,
} from "./_lib/aws-cli.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { mapSagemakerModelToItem } from "./sagemaker-model-mapping.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export type { RunAwsCli };

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

export type SagemakerSyncableOptions = {
  ensureSagemakerMcpRunning: () => Promise<void>;
  /** Override the AWS-CLI runner (dependency injection for tests). */
  runAwsCli?: RunAwsCli;
};

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
    const cp = value.codePointAt(i);
    if (cp !== undefined && cp < 0x20) {
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
  const containerImage = container === undefined ? undefined : stringField(container, "Image");
  const modelDataUrl = container === undefined ? undefined : stringField(container, "ModelDataUrl");
  const executionRoleArn = stringField(rec, "ExecutionRoleArn");
  const enrichment: DescribeEnrichment = {
    ...(containerImage === undefined ? {} : { containerImage }),
    ...(modelDataUrl === undefined ? {} : { modelDataUrl }),
    ...(executionRoleArn === undefined ? {} : { executionRoleArn }),
  };
  return { enrichment, bytes };
}

interface ModelWalkState {
  upserted: number;
  bytes: number;
  seen: number;
  described: number;
}

/** Map + upsert one `Models` entry, optionally enriching it via `describe-model`. */
async function processModel(
  run: RunAwsCli,
  ctx: SyncContext,
  entry: unknown,
  now: number,
  state: ModelWalkState,
): Promise<void> {
  const rec = asRecord(entry);
  const modelName = rec === undefined ? undefined : stringField(rec, "ModelName");
  let enrichment: DescribeEnrichment = {};
  if (modelName !== undefined && modelName !== "" && state.described < MAX_DESCRIBE) {
    state.described += 1;
    const d = await describeModel(run, ctx, modelName);
    state.bytes += d.bytes;
    enrichment = d.enrichment;
  }
  const mapped = mapSagemakerModelToItem(entry, { syncedAt: now, ...enrichment });
  if (mapped !== null) {
    ctx.upsertItem(mapped);
    state.upserted += 1;
  }
}

export function createSagemakerSyncable(options: SagemakerSyncableOptions): Syncable {
  const run = options.runAwsCli ?? awsCliJson;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runAwsCliPaginatedWalk<ModelWalkState>(ctx, cursor, run, {
        ensureRunning: options.ensureSagemakerMcpRunning,
        // SageMaker (Tier-3, metadata-only) reuses the existing AWS credentials.
        loadCreds: () => awsCredentialsExtra(ctx),
        pass1Cursor,
        maxItems: MAX_MODELS,
        pageSize: PAGE_SIZE,
        tokenKey: "NextToken",
        arrayKey: "Models",
        initialState: () => ({ upserted: 0, bytes: 0, seen: 0, described: 0 }),
        buildPageArgs: (pageSize, token) => {
          const args = ["sagemaker", "list-models", "--max-results", String(pageSize)];
          if (token !== null && token !== "") {
            args.push("--next-token", token);
          }
          return args;
        },
        processEntry: processModel,
      });
    },
  };
}
