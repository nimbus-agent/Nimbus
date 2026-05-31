import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { awsCliJson, awsCredentialsExtra } from "./_lib/aws-cli.ts";
import { mapCloudwatchLogGroupToItem } from "./cloudwatch-log-group-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

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

/** Injectable AWS-CLI runner — defaults to the shared `awsCliJson` spawn; tests pass a stub. */
export type RunAwsCli = (
  ctx: SyncContext,
  args: string[],
) => Promise<{ ok: boolean; text: string }>;

export type CloudwatchSyncableOptions = {
  ensureCloudwatchMcpRunning: () => Promise<void>;
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
  const tok = stringField(rec, "nextToken");
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
    ...(lastEventTimestamp !== undefined ? { lastEventTimestamp } : {}),
    bytes,
  };
}

export function createCloudwatchSyncable(options: CloudwatchSyncableOptions): Syncable {
  const run = options.runAwsCli ?? awsCliJson;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureCloudwatchMcpRunning();

      // CloudWatch (Tier-3, metadata-only) reuses the existing AWS credentials.
      const extra = await awsCredentialsExtra(ctx);
      if (extra === null) {
        return syncNoopResult(cursor, t0);
      }

      const now = Date.now();
      let totalBytes = 0;
      let totalUpserted = 0;
      let token: string | null = null;
      let seen = 0;
      let page = 0;

      while (seen < MAX_LOG_GROUPS) {
        const args = ["logs", "describe-log-groups", "--limit", String(PAGE_SIZE)];
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
        for (const entry of extractArray(parsed, "logGroups")) {
          if (seen >= MAX_LOG_GROUPS) {
            break;
          }
          seen += 1;
          const rec = asRecord(entry);
          const groupName = rec === undefined ? undefined : stringField(rec, "logGroupName");
          let streamCount: number | undefined;
          let lastEventTimestamp: number | undefined;
          if (groupName !== undefined && groupName !== "") {
            const peek = await peekStreams(run, ctx, groupName);
            totalBytes += peek.bytes;
            streamCount = peek.streamCount;
            lastEventTimestamp = peek.lastEventTimestamp;
          }
          const mapped = mapCloudwatchLogGroupToItem(entry, {
            syncedAt: now,
            ...(streamCount !== undefined ? { streamCount } : {}),
            ...(lastEventTimestamp !== undefined ? { lastEventTimestamp } : {}),
          });
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
