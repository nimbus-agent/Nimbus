import { expect, test } from "bun:test";
import {
  type CloudwatchSyncableOptions,
  createCloudwatchSyncable,
  type RunAwsCli,
} from "./cloudwatch-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  expectSyncNoopResult,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";

// ---------------------------------------------------------------------------
// Vault helpers
// ---------------------------------------------------------------------------

/** AWS vault keys that satisfy awsCredentialsExtra (ak + sk + region). */
function awsVault(): ReturnType<typeof createStubVault> {
  return createStubVault({
    "aws.access_key_id": "AKIATEST",
    "aws.secret_access_key": "secret",
    "aws.default_region": "us-east-1",
    "aws.profile": null,
  });
}

/** Vault missing all credentials — awsCredentialsExtra returns null → noop. */
function emptyAwsVault(): ReturnType<typeof createStubVault> {
  return createStubVault({
    "aws.access_key_id": null,
    "aws.secret_access_key": null,
    "aws.default_region": null,
    "aws.profile": null,
  });
}

/** Profile-only vault — awsCredentialsExtra returns non-null. */
function profileOnlyVault(): ReturnType<typeof createStubVault> {
  return createStubVault({
    "aws.access_key_id": null,
    "aws.secret_access_key": null,
    "aws.default_region": null,
    "aws.profile": "my-profile",
  });
}

// ---------------------------------------------------------------------------
// RunAwsCli stub builders
// ---------------------------------------------------------------------------

/** A stub runner that returns a fixed response for every call. */
function stubRunner(ok: boolean, text: string): RunAwsCli {
  return async (_ctx, _args) => ({ ok, text });
}

// ---------------------------------------------------------------------------
// Response shape builders
// ---------------------------------------------------------------------------

function logGroupsPage(
  names: string[],
  nextToken?: string,
  extras?: Record<string, unknown>[],
): string {
  const body: Record<string, unknown> = {
    logGroups: names.map((n, i) => ({
      logGroupName: n,
      arn: `arn:aws:logs:us-east-1:123:log-group:${n}`,
      storedBytes: 1024,
      retentionInDays: 30,
      metricFilterCount: 0,
      creationTime: Date.now() - 7 * 24 * 60 * 60 * 1000,
      ...(extras?.[i] ?? {}),
    })),
  };
  if (nextToken !== undefined) {
    body["nextToken"] = nextToken;
  }
  return JSON.stringify(body);
}

function streamsPage(count: number, latestTimestamp?: number, nextToken?: string): string {
  const streams = Array.from({ length: count }, (_, i) => ({
    logStreamName: `stream-${i}`,
    lastEventTimestamp: latestTimestamp !== undefined ? latestTimestamp - i * 1000 : undefined,
  }));
  const body: Record<string, unknown> = { logStreams: streams };
  if (nextToken !== undefined) {
    body["nextToken"] = nextToken;
  }
  return JSON.stringify(body);
}

// ---------------------------------------------------------------------------
// Options helper
// ---------------------------------------------------------------------------

function opts(runAwsCli: RunAwsCli): CloudwatchSyncableOptions {
  return {
    ensureCloudwatchMcpRunning: async () => {},
    runAwsCli,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeWithFetchRestore("cloudwatch-sync", () => {
  // ─── noop when AWS credentials are missing ─────────────────────────────
  test("no-op when AWS credentials are missing", async () => {
    const db = createMemoryIndexDb();
    const sync = createCloudwatchSyncable({
      ensureCloudwatchMcpRunning: async () => {},
    });
    const r = await sync.sync(syncTestContext(db, emptyAwsVault(), "cloudwatch"), null);
    expectSyncNoopResult(r);
    expectServiceItemCount(db, "cloudwatch", 0);
  });

  // ─── noop with profile-only still proceeds ─────────────────────────────
  test("proceeds with profile-only AWS credentials (no access key)", async () => {
    const db = createMemoryIndexDb();
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["my-group"]) };
      }
      // peekStreams: describe-log-streams
      return { ok: true, text: streamsPage(2, Date.now() - 1000) };
    };
    const sync = createCloudwatchSyncable({ ...opts(runner), runAwsCli: runner });
    const r = await sync.sync(syncTestContext(db, profileOnlyVault(), "cloudwatch"), null);
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-cw1:");
  });

  // ─── first page fails (page===0) → syncPassCursorParseEmpty ────────────
  // Covers: !res.ok branch when page === 0
  test("returns empty pass when describe-log-groups first page fails", async () => {
    const db = createMemoryIndexDb();
    const runner = stubRunner(false, "access denied");
    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-cw1:");
    expectServiceItemCount(db, "cloudwatch", 0);
  });

  // ─── happy path: single log group, streams ok ───────────────────────────
  test("indexes one log group with stream metadata and advances cursor", async () => {
    const db = createMemoryIndexDb();
    const latestTs = Date.now() - 5000;

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["my-log-group"]) };
      }
      // describe-log-streams
      return { ok: true, text: streamsPage(3, latestTs) };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-cw1:");
    expectServiceItemCount(db, "cloudwatch", 1);
  });

  // ─── empty log groups list → success with 0 upserts ───────────────────
  test("returns success with 0 upserts when log groups list is empty", async () => {
    const db = createMemoryIndexDb();
    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage([]) };
      }
      return { ok: false, text: "" };
    };
    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-cw1:");
  });

  // ─── malformed JSON → treated as empty page ─────────────────────────────
  // Covers: parseJson catch → undefined; extractArray(undefined) → []; nextToken(undefined) → null
  test("handles invalid JSON from describe-log-groups gracefully", async () => {
    const db = createMemoryIndexDb();
    const runner = stubRunner(true, "not valid json {{{{");
    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-cw1:");
  });

  // ─── nextToken present → second page fetched ────────────────────────────
  // Covers: token !== null && token !== "" branch (push --next-token)
  test("follows nextToken to fetch additional log group pages", async () => {
    const db = createMemoryIndexDb();
    let logGroupCall = 0;

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        logGroupCall += 1;
        if (logGroupCall === 1) {
          return { ok: true, text: logGroupsPage(["group-1"], "page-2-token") };
        }
        return { ok: true, text: logGroupsPage(["group-2"]) };
      }
      // describe-log-streams
      return { ok: true, text: streamsPage(1, Date.now() - 1000) };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(logGroupCall).toBe(2);
    expect(r.itemsUpserted).toBe(2);
    expectServiceItemCount(db, "cloudwatch", 2);
  });

  // ─── nextToken is empty string → stop paginating ────────────────────────
  // Covers: nextToken() when tok === "" → null → loop breaks
  test("treats empty-string nextToken as end of pages", async () => {
    const db = createMemoryIndexDb();
    let logGroupCall = 0;

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        logGroupCall += 1;
        return {
          ok: true,
          text: JSON.stringify({
            logGroups: [
              {
                logGroupName: "group-only",
                arn: "arn:aws:logs:us-east-1:123:log-group:group-only",
                storedBytes: 0,
                creationTime: Date.now() - 1000,
              },
            ],
            nextToken: "",
          }),
        };
      }
      return { ok: true, text: streamsPage(0) };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);
    // Empty nextToken → only one page fetched
    expect(logGroupCall).toBe(1);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── second page fail (page > 0) → break (not firstPageFailed) ──────────
  // Covers: !res.ok branch when page > 0 → break
  test("breaks loop when a subsequent log-groups page fails", async () => {
    const db = createMemoryIndexDb();
    let logGroupCall = 0;

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        logGroupCall += 1;
        if (logGroupCall === 1) {
          return { ok: true, text: logGroupsPage(["group-1"], "next-tok") };
        }
        return { ok: false, text: "throttled" };
      }
      return { ok: true, text: streamsPage(1, Date.now() - 2000) };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    // First page had group-1 → 1 upsert; second page failed → break (not empty pass)
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-cw1:");
  });

  // ─── peekStreams: !res.ok → return zero-count summary ───────────────────
  // Covers: peekStreams early return when describe-log-streams fails
  test("log group is still indexed when peekStreams call fails", async () => {
    const db = createMemoryIndexDb();

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["my-group"]) };
      }
      // describe-log-streams fails
      return { ok: false, text: "access denied" };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    // Group is still indexed (summary.streamCount = 0, no lastEventTimestamp)
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "cloudwatch", 1);
  });

  // ─── peekStreams: malformed JSON → streams array is empty ───────────────
  // Covers: parseJson catch in peekStreams; extractArray returns []
  test("log group indexed with zero streams when peekStreams returns malformed JSON", async () => {
    const db = createMemoryIndexDb();

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["my-group"]) };
      }
      return { ok: true, text: "{{ not json }}" };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "cloudwatch", 1);
  });

  // ─── peekStreams: non-array logStreams field ──────────────────────────────
  // Covers: extractArray when arr is not Array → []
  test("log group indexed when logStreams is not an array", async () => {
    const db = createMemoryIndexDb();

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["my-group"]) };
      }
      return { ok: true, text: JSON.stringify({ logStreams: "not-an-array" }) };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(r.itemsUpserted).toBe(1);
  });

  // ─── peekStreams: stream entry is not a record → skip (continue) ─────────
  // Covers: asRecord(entry) === undefined → continue inside for loop
  test("skips non-object stream entries in peekStreams", async () => {
    const db = createMemoryIndexDb();

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["my-group"]) };
      }
      // logStreams contains non-objects
      return {
        ok: true,
        text: JSON.stringify({
          logStreams: ["not-an-object", 42, null, { logStreamName: "s1" }],
        }),
      };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(r.itemsUpserted).toBe(1);
  });

  // ─── peekStreams: lastEventTimestamp tracking (max selection) ────────────
  // Covers: ts > lastEventTimestamp → update branch; lastEventTimestamp defined → spread
  test("picks the largest lastEventTimestamp across streams in peekStreams", async () => {
    const db = createMemoryIndexDb();
    const now = Date.now();
    const oldest = now - 10000;
    const newest = now - 1000;

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["my-group"]) };
      }
      // Two streams with different lastEventTimestamp; newest should win
      return {
        ok: true,
        text: JSON.stringify({
          logStreams: [
            { logStreamName: "s1", lastEventTimestamp: oldest },
            { logStreamName: "s2", lastEventTimestamp: newest },
          ],
        }),
      };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(r.itemsUpserted).toBe(1);

    // Verify lastEventTimestamp was stored in DB metadata
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'cloudwatch' LIMIT 1")
      .get() as { metadata: string } | null;
    expect(row).not.toBeNull();
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["lastEventTimestamp"]).toBe(newest);
  });

  // ─── peekStreams: stream entry missing lastEventTimestamp field ──────────
  // Covers: ts === undefined → does NOT update lastEventTimestamp
  test("handles stream entries without lastEventTimestamp", async () => {
    const db = createMemoryIndexDb();

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["my-group"]) };
      }
      return {
        ok: true,
        text: JSON.stringify({
          logStreams: [
            { logStreamName: "s1" }, // no lastEventTimestamp
          ],
        }),
      };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    // Still indexed; lastEventTimestamp should be absent from metadata
    expect(r.itemsUpserted).toBe(1);
    const row = db
      .prepare("SELECT metadata FROM item WHERE service = 'cloudwatch' LIMIT 1")
      .get() as { metadata: string } | null;
    const meta = JSON.parse(row?.metadata ?? "{}") as Record<string, unknown>;
    // lastEventTimestamp from ctx is undefined → null → not spread into metadata
    expect(Object.hasOwn(meta, "lastEventTimestamp")).toBe(false);
  });

  // ─── processLogGroup: entry is not a record → groupName undefined ─────────
  // Covers: asRecord(entry) === undefined → groupName undefined → no peekStreams
  //         mapCloudwatchLogGroupToItem returns null → skip
  test("skips non-object log group entries", async () => {
    const db = createMemoryIndexDb();

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return {
          ok: true,
          text: JSON.stringify({ logGroups: ["not-an-object", 42, null] }),
        };
      }
      return { ok: false, text: "" };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(r.itemsUpserted).toBe(0);
  });

  // ─── processLogGroup: logGroupName is empty string → no peekStreams ───────
  // Covers: groupName === "" branch; mapCloudwatchLogGroupToItem → null → skip
  test("skips log group entries with empty logGroupName", async () => {
    const db = createMemoryIndexDb();

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return {
          ok: true,
          text: JSON.stringify({
            logGroups: [{ logGroupName: "" }],
          }),
        };
      }
      return { ok: false, text: "" };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(r.itemsUpserted).toBe(0);
  });

  // ─── processLogGroupPage: MAX_LOG_GROUPS cap ────────────────────────────
  // Covers: state.seen >= MAX_LOG_GROUPS → break inside loop
  test("respects MAX_LOG_GROUPS cap and stops processing after 500 entries", async () => {
    const db = createMemoryIndexDb();

    // Provide 501 groups in one page — cap is 500
    const manyGroups = Array.from({ length: 501 }, (_, i) => ({
      logGroupName: `group-${i}`,
      arn: `arn:aws:logs:us-east-1:123:log-group:group-${i}`,
      storedBytes: 0,
      creationTime: Date.now() - 1000,
    }));

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return {
          ok: true,
          text: JSON.stringify({ logGroups: manyGroups }),
        };
      }
      // describe-log-streams
      return { ok: true, text: streamsPage(1, Date.now() - 500) };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    // MAX_LOG_GROUPS = 500
    expect(r.itemsUpserted).toBe(500);
    expectServiceItemCount(db, "cloudwatch", 500);
  });

  // ─── multiple log groups → all indexed ────────────────────────────────
  test("indexes multiple log groups from one page", async () => {
    const db = createMemoryIndexDb();

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        return { ok: true, text: logGroupsPage(["g1", "g2", "g3"]) };
      }
      return { ok: true, text: streamsPage(2, Date.now() - 3000) };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "cloudwatch", 3);
  });

  // ─── extractArray: record present but key value is not array ────────────
  // Covers extractArray line: arr not Array.isArray → return []
  test("handles non-array value for logGroups key gracefully", async () => {
    const db = createMemoryIndexDb();
    const runner = stubRunner(true, JSON.stringify({ logGroups: "should-be-array" }));
    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-cw1:");
  });

  // ─── nextToken: nextToken field not in response → null → stop ────────────
  // Covers: nextToken returns null when field absent → loop breaks
  test("stops paginating when no nextToken in response", async () => {
    const db = createMemoryIndexDb();
    let callCount = 0;

    const runner: RunAwsCli = async (_ctx, args) => {
      if (args[1] === "describe-log-groups") {
        callCount += 1;
        return { ok: true, text: logGroupsPage(["single-group"]) }; // no nextToken field
      }
      return { ok: true, text: streamsPage(0) };
    };

    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);

    expect(callCount).toBe(1);
    expect(r.itemsUpserted).toBe(1);
  });

  // ─── serviceId / defaultIntervalMs / initialSyncDepthDays metadata ───────
  test("syncable has correct service metadata", () => {
    const sync = createCloudwatchSyncable({
      ensureCloudwatchMcpRunning: async () => {},
    });
    expect(sync.serviceId).toBe("cloudwatch");
    expect(sync.defaultIntervalMs).toBe(10 * 60 * 1000);
    expect(sync.initialSyncDepthDays).toBe(30);
  });

  // ─── default runAwsCli injection (no override → awsCliJson used) ─────────
  // Covers: options.runAwsCli ?? awsCliJson (null-coalescing branch where runAwsCli absent)
  // We verify the syncable is created without crashing and has the right service id.
  test("creates syncable without explicit runAwsCli injection", () => {
    const sync = createCloudwatchSyncable({
      ensureCloudwatchMcpRunning: async () => {},
      // no runAwsCli — defaults to awsCliJson
    });
    expect(sync.serviceId).toBe("cloudwatch");
  });

  // ─── nextToken is a non-record (e.g. top-level JSON is an array) ─────────
  // Covers: nextToken() when asRecord(parsed) === undefined → null
  test("handles top-level JSON array (non-record) without crashing", async () => {
    const db = createMemoryIndexDb();
    // Valid JSON but parsed is an array, not a record
    const runner = stubRunner(true, JSON.stringify([]));
    const sync = createCloudwatchSyncable(opts(runner));
    const r = await sync.sync(syncTestContext(db, awsVault(), "cloudwatch"), null);
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-cw1:");
  });
});
