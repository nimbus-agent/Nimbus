import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  awsCliJson,
  awsCredentialsExtra,
  extractArray,
  parseJson,
  type RunAwsCli,
  runAwsCliPaginatedWalk,
} from "./_lib/aws-cli.ts";
import { mapCloudwatchLogGroupToItem } from "./cloudwatch-log-group-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export type { RunAwsCli };

const SERVICE_ID = "cloudwatch";
const CURSOR_PREFIX = "nimbus-cw1:";

// Page caps — single forward pass per cycle (mirrors Athena's caps).
const MAX_LOG_GROUPS = 500;
const PAGE_SIZE = 50;
// Per-group stream peek: a small cap for a COUNT + last-activity timestamp only
// (stream METADATA — never stream events).
const MAX_STREAMS_PER_GROUP = 50;

type CloudwatchCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies CloudwatchCursorV1);
}

export type CloudwatchSyncableOptions = {
  ensureCloudwatchMcpRunning: () => Promise<void>;
  /** Override the AWS-CLI runner (dependency injection for tests). */
  runAwsCli?: RunAwsCli;
};

interface StreamSummary {
  readonly streamCount: number;
  readonly lastEventTimestamp?: number;
  readonly bytes: number;
}

/**
 * Peek a log group's STREAM metadata (`describe-log-streams`, ordered by last
 * event time) for a stream COUNT + the most-recent `lastEventTimestamp`. Stream
 * metadata is permitted; stream EVENTS are NOT — there is no `get-log-events`
 * call here. Best-effort: a failure yields a zero-count summary.
 */
async function peekStreams(
  run: RunAwsCli,
  ctx: SyncContext,
  logGroupName: string,
): Promise<StreamSummary> {
  const res = await run(ctx, [
    "logs",
    "describe-log-streams",
    "--log-group-name",
    logGroupName,
    "--order-by",
    "LastEventTime",
    "--descending",
    "--limit",
    String(MAX_STREAMS_PER_GROUP),
  ]);
  const bytes = res.text.length;
  if (!res.ok) {
    return { streamCount: 0, bytes };
  }
  const parsed = parseJson(res.text);
  const streams = extractArray(parsed, "logStreams");
  let lastEventTimestamp: number | undefined;
  for (const entry of streams) {
    const rec = asRecord(entry);
    if (rec === undefined) {
      continue;
    }
    const ts = numberField(rec, "lastEventTimestamp");
    if (ts !== undefined && (lastEventTimestamp === undefined || ts > lastEventTimestamp)) {
      lastEventTimestamp = ts;
    }
  }
  return {
    streamCount: streams.length,
    ...(lastEventTimestamp === undefined ? {} : { lastEventTimestamp }),
    bytes,
  };
}

interface LogGroupWalkState {
  upserted: number;
  bytes: number;
  seen: number;
}

/**
 * Map + upsert a single `logGroups` entry, peeking its stream metadata for a
 * COUNT + last-activity timestamp. Mutates the byte/upsert counters on `state`.
 */
async function processLogGroup(
  run: RunAwsCli,
  ctx: SyncContext,
  entry: unknown,
  now: number,
  state: LogGroupWalkState,
): Promise<void> {
  const rec = asRecord(entry);
  const groupName = rec === undefined ? undefined : stringField(rec, "logGroupName");
  let summary: StreamSummary | undefined;
  if (groupName !== undefined && groupName !== "") {
    summary = await peekStreams(run, ctx, groupName);
    state.bytes += summary.bytes;
  }
  const streamCount = summary?.streamCount;
  const lastEventTimestamp = summary?.lastEventTimestamp;
  const mapped = mapCloudwatchLogGroupToItem(entry, {
    syncedAt: now,
    ...(streamCount === undefined ? {} : { streamCount }),
    ...(lastEventTimestamp === undefined ? {} : { lastEventTimestamp }),
  });
  if (mapped !== null) {
    ctx.upsertItem(mapped);
    state.upserted += 1;
  }
}

export function createCloudwatchSyncable(options: CloudwatchSyncableOptions): Syncable {
  const run = options.runAwsCli ?? awsCliJson;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      return runAwsCliPaginatedWalk<LogGroupWalkState>(ctx, cursor, run, {
        ensureRunning: options.ensureCloudwatchMcpRunning,
        // CloudWatch (Tier-3, metadata-only) reuses the existing AWS credentials.
        loadCreds: () => awsCredentialsExtra(ctx),
        pass1Cursor,
        maxItems: MAX_LOG_GROUPS,
        pageSize: PAGE_SIZE,
        tokenKey: "nextToken",
        arrayKey: "logGroups",
        initialState: () => ({ upserted: 0, bytes: 0, seen: 0 }),
        buildPageArgs: (pageSize, token) => {
          const args = ["logs", "describe-log-groups", "--limit", String(pageSize)];
          if (token !== null && token !== "") {
            args.push("--next-token", token);
          }
          return args;
        },
        processEntry: processLogGroup,
      });
    },
  };
}
