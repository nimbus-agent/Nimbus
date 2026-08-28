import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createVertexAiSyncable, type RunGcloud } from "../../../src/connectors/vertex-ai-sync.ts";
import { spawnCaptureInternals } from "../../../src/platform/spawn-capture.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const CURSOR_PREFIX = "nimbus-vertex1:";

function encodeCursor(payload: unknown): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}
const PASS_1_CURSOR = encodeCursor({ pass: 1 });

const ENSURE = { ensureVertexAiMcpRunning: async (): Promise<void> => {} };

/** Build a runGcloud stub returning canned JSON; records (credPath, project, region) calls. */
function makeRunner(seq: { ok?: boolean; body?: unknown }[]): {
  run: RunGcloud;
  calls: { credPath: string; project: string; region: string }[];
} {
  const calls: { credPath: string; project: string; region: string }[] = [];
  let i = 0;
  const run: RunGcloud = async (credPath, project, region) => {
    calls.push({ credPath, project, region });
    const r = seq[Math.min(i, seq.length - 1)] ?? { ok: true, body: [] };
    i += 1;
    const ok = r.ok ?? true;
    return { ok, text: ok ? JSON.stringify(r.body ?? []) : "" };
  };
  return { run, calls };
}

async function seedGcpCreds(fx: ConnectorSyncFixture): Promise<void> {
  await fx.vault.set("gcp.credentials_json_path", "/etc/gcp.json");
  await fx.vault.set("gcp.project_id", "my-project");
}

describe("vertex-ai-sync — credential short-circuit", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(() => {
    fx = createConnectorSyncFixture();
  });
  afterEach(() => fx.cleanup());

  test("no gcp vault keys → noop, runner never called, cursor preserved", async () => {
    const { run, calls } = makeRunner([]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      "prev",
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe("prev");
    expect(calls).toHaveLength(0);
  });

  test("cred path but no project id → noop", async () => {
    await fx.vault.set("gcp.credentials_json_path", "/etc/gcp.json");
    const { run, calls } = makeRunner([]);
    await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("vertex-ai-sync — model metadata walk", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    await seedGcpCreds(fx);
  });
  afterEach(() => fx.cleanup());

  test("lists models and upserts model metadata (single pass, default region)", async () => {
    const { run, calls } = makeRunner([
      {
        body: [
          {
            name: "projects/my-project/locations/us-central1/models/111",
            displayName: "fraud-detector",
            versionId: "1",
            createTime: "2024-01-01T00:00:00Z",
            updateTime: "2024-06-15T12:00:00Z",
          },
          {
            name: "projects/my-project/locations/us-central1/models/222",
            displayName: "churn-model",
          },
        ],
      },
    ]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(res.itemsUpserted).toBe(2);
    expect(res.cursor).toBe(PASS_1_CURSOR);
    expect(res.hasMore).toBe(false);

    // Exactly one gcloud invocation per cycle, with creds + project + default region.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      credPath: "/etc/gcp.json",
      project: "my-project",
      region: "us-central1",
    });

    const rows = fx.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'vertex_ai' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual([
      "projects/my-project/locations/us-central1/models/111",
      "projects/my-project/locations/us-central1/models/222",
    ]);

    // No inference / prediction output stored anywhere in the indexed metadata.
    const meta = fx.db
      .query<{ metadata: string }, []>("SELECT metadata FROM item WHERE service = 'vertex_ai'")
      .all()
      .map((r) => r.metadata)
      .join("");
    expect(meta).not.toContain("prediction");
    expect(meta).not.toContain("instances");
  });

  test("uses the optional gcp.region when set", async () => {
    await fx.vault.set("gcp.region", "europe-west4");
    const { run, calls } = makeRunner([{ body: [{ displayName: "m" }] }]);
    await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(calls[0]?.region).toBe("europe-west4");
  });

  test("falls back to default region when gcp.region is unsafe (flag-smuggle guard)", async () => {
    await fx.vault.set("gcp.region", "--project=attacker");
    const { run, calls } = makeRunner([{ body: [] }]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    // Unsafe region → noop (loadCreds returns null), runner never called.
    expect(res.itemsUpserted).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("gcloud failure → parse-empty pass cursor, 0 upserts, no throw", async () => {
    const { run } = makeRunner([{ ok: false }]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("non-array gcloud output → 0 upserts, success cursor", async () => {
    const { run } = makeRunner([{ body: { error: "unexpected" } }]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).toBe(PASS_1_CURSOR);
  });

  test("skips entries with no name and no displayName", async () => {
    const { run } = makeRunner([{ body: [{ versionId: "1" }, { displayName: "good-model" }] }]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(res.itemsUpserted).toBe(1);
  });

  test("emits no notifications and reports bytesTransferred", async () => {
    const { run } = makeRunner([{ body: [{ displayName: "m" }] }]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(fx.notifications.emitted).toHaveLength(0);
    expect(res.bytesTransferred).toBeGreaterThan(0);
  });

  test("falls back to default region when gcp.region has a control char", async () => {
    // A region with a control char (< 0x20) passes the non-empty / length / `-`
    // checks but is rejected by the char-scan loop → loadCreds returns null → noop.
    const regionWithControlChar = `us${String.fromCodePoint(0x07)}central1`;
    await fx.vault.set("gcp.region", regionWithControlChar);
    const { run: run2, calls: calls2 } = makeRunner([{ body: [] }]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run2 }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(res.itemsUpserted).toBe(0);
    expect(calls2).toHaveLength(0);
  });

  test("multiple models with mixed fields all upsert", async () => {
    const { run } = makeRunner([
      {
        body: [
          { name: "projects/p/locations/us-central1/models/1", displayName: "a", versionId: "3" },
          { name: "projects/p/locations/us-central1/models/2" },
          { displayName: "name-only-model" },
        ],
      },
    ]);
    const res = await createVertexAiSyncable({ ...ENSURE, runGcloud: run }).sync(
      fx.createSyncContext("vertex_ai"),
      null,
    );
    expect(res.itemsUpserted).toBe(3);
  });
});

// Exercise the real (non-DI) `gcloudAiModelsList` runner body without spawning
// a real subprocess: mock Bun.spawn to return a fake process. `new Response(<string>)`
// reads the canned stdout, so the spawn → exited → parse path is covered hermetically.

describe("vertex-ai-sync — default gcloud runner (hermetic spawn mock)", () => {
  let fx: ConnectorSyncFixture;
  beforeEach(async () => {
    fx = createConnectorSyncFixture();
    await seedGcpCreds(fx);
  });
  afterEach(() => fx.cleanup());

  test("spawn exits 0 with model JSON → models upserted", async () => {
    const models = [{ name: "projects/p/locations/us-central1/models/m1", displayName: "Model 1" }];
    const spy = spyOn(spawnCaptureInternals, "spawn").mockImplementation((() =>
      fakeChild(0, JSON.stringify(models))) as never);
    try {
      const res = await createVertexAiSyncable(ENSURE).sync(
        fx.createSyncContext("vertex_ai"),
        null,
      );
      expect(res.itemsUpserted).toBe(1);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test("spawn throws (gcloud absent) → graceful empty pass, no throw", async () => {
    const spy = spyOn(spawnCaptureInternals, "spawn").mockImplementation((() => {
      throw new Error("ENOENT: gcloud not found");
    }) as never);
    try {
      const res = await createVertexAiSyncable(ENSURE).sync(
        fx.createSyncContext("vertex_ai"),
        null,
      );
      expect(res.itemsUpserted).toBe(0);
      expect(res.cursor).toBe(PASS_1_CURSOR);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * A `node:child_process` stand-in. The connector CLI runners moved off `Bun.spawn` to
 * `platform/spawn-capture.ts`, which spawns with `windowsHide` — the Gateway runs detached, so an
 * unhidden child pops a console window on every sync tick. These tests stub the seam that module
 * exports rather than `Bun.spawn`, which it no longer uses.
 */
function fakeChild(exitCode: number, stdout: string): unknown {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: () => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = (): void => {};
  queueMicrotask(() => {
    if (stdout !== "") proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  });
  return proc;
}
