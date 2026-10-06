import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import nacl from "tweetnacl";
import type { LazyMeshToolMap } from "../connectors/lazy-mesh/tool-map.ts";
import { LocalIndex } from "../index/local-index.ts";
import { buildShareFile, type ShareFile } from "../share/share-format.ts";
import { insertReceivedShare } from "../share/share-inbox-store.ts";
import { getShareRecord, listShareRecords } from "../share/share-store.ts";
import { encodeBase64 } from "../util/base64.ts";
import { dispatchShareRpc, type ShareRpcCtx, ShareRpcError } from "./share-rpc.ts";

/**
 * `share-rpc.ts` paths `share-rpc.test.ts` does not reach: the replay tool-outcome mapping (absent
 * tool, non-callable tool, a tool that throws — an `Error` or not), replay's param and parse
 * refusals, the YAML file sink, the defaulted file sink, a peer sink with no delivery wiring, a
 * partially-configured HTTP sink, and the inbox's `all` switch.
 */

let db: Database;
let tmp: string;

beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  tmp = await mkdtemp(join(tmpdir(), "share-rpc-edges-"));
});

afterEach(async () => {
  db.close();
  await rm(tmp, { recursive: true, force: true });
});

function recordingVault() {
  const m = new Map<string, string>();
  const gets: Array<string | undefined> = [];
  return {
    gets,
    vault: {
      get: async (k: string) => {
        gets.push(k);
        return m.get(k) ?? null;
      },
      set: async (k: string, v: string) => void m.set(k, v),
      delete: async () => {},
      listKeys: async () => [...m.keys()],
    },
  };
}

/** A context with an approving owner and NO `deliverToPeer` unless one is passed. */
function ctxWith(over: Partial<ShareRpcCtx> = {}): ShareRpcCtx {
  return {
    db,
    vault: recordingVault().vault,
    label: "edge-host",
    now: () => 1000,
    collectSession: async () => ({
      turns: [{ role: "user" as const, text: "status of the deploy", timestamp: 1 }],
      toolCalls: [],
    }),
    requestApproval: async () => true,
    recordAudit: () => {},
    respondApproval: () => false,
    httpSink: { url: "" },
    listReplayTools: async () => ({}),
    ...over,
  };
}

function hitValue<T>(out: unknown): T {
  expect((out as { kind: string }).kind).toBe("hit");
  return (out as { value: T }).value;
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return await p.then(
    (v) => new Error(`resolved: ${JSON.stringify(v)}`),
    (e: unknown) => e,
  );
}

/** A correctly signed recipe share naming `steps`, as raw JSON bytes in base64. */
function signedRecipeB64(steps: ReadonlyArray<{ tool: string; service: string }>): string {
  const seed = nacl.randomBytes(32);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const share = buildShareFile(
    {
      kind: "recipe",
      sessionId: "s-replay",
      createdAt: 1,
      expiresAt: null,
      redactionSet: [],
      origin: { label: "origin-host", pubkey: encodeBase64(kp.publicKey) },
      recipe: {
        recipeVersion: 1,
        sourceSessionId: "s-replay",
        generatedAt: 1,
        graphTraversals: [],
        steps: steps.map((s, i) => ({
          stepId: `step-${i + 1}`,
          tool: s.tool,
          service: s.service,
          params: {},
          status: "ok",
          dependsOn: [],
        })),
      },
    },
    encodeBase64(seed),
    encodeBase64(kp.publicKey),
  );
  return Buffer.from(JSON.stringify(share), "utf8").toString("base64");
}

type ReplayValue = {
  verify: { ok: boolean };
  report: {
    steps: Array<{ tool: string; status: string; detail?: string }>;
    summary: { missingConnector: number; error: number; match: number };
  };
};

describe("share.replay — how each tool outcome is reported", () => {
  test("absent / non-callable tools are missing connectors; a throw is an error with its text", async () => {
    let mapResolutions = 0;
    const out = await dispatchShareRpc(
      "share.replay",
      {
        bytesB64: signedRecipeB64([
          { tool: "gmail_get", service: "gmail" },
          { tool: "jira_search", service: "jira" },
          { tool: "drive_list", service: "drive" },
          { tool: "calendar_get", service: "calendar" },
          { tool: "slack_search", service: "slack" },
        ]),
      },
      ctxWith({
        listReplayTools: async () => {
          mapResolutions++;
          const tools: LazyMeshToolMap = {
            // gmail_get: absent from the map entirely.
            // jira_search: present, but with no `execute` to call.
            jira_search: {},
            drive_list: {
              execute: async () => {
                throw new Error("quota exceeded");
              },
            },
            calendar_get: { execute: () => Promise.reject("socket hang up") },
            slack_search: { execute: async () => ({ messages: [] }) },
          };
          return tools;
        },
      }),
    );
    const value = hitValue<ReplayValue>(out);
    expect(value.verify.ok).toBe(true);
    expect(value.report.steps.map((s) => [s.tool, s.status, s.detail])).toEqual([
      ["gmail_get", "missing-connector", "gmail"],
      ["jira_search", "missing-connector", "jira"],
      ["drive_list", "error", "quota exceeded"],
      ["calendar_get", "error", "socket hang up"],
      ["slack_search", "match", undefined],
    ]);
    expect(value.report.summary).toMatchObject({ missingConnector: 2, error: 2, match: 1 });
    // Resolved lazily ONCE, then reused for every later step.
    expect(mapResolutions).toBe(1);
  });
});

describe("share.replay — a user-MCP tool is never replayed (I42)", () => {
  test("a share naming a user-MCP read-verb tool is skipped and the tool never executes", async () => {
    let executed = 0;
    let resolved = 0;
    const out = await dispatchShareRpc(
      "share.replay",
      { bytesB64: signedRecipeB64([{ tool: "mcp_notes_search", service: "mcp_notes" }]) },
      ctxWith({
        listReplayTools: async () => {
          resolved++;
          const tools: LazyMeshToolMap = {
            mcp_notes_search: {
              execute: async () => {
                executed++;
                return {};
              },
            },
          };
          return tools;
        },
      }),
    );
    const value = hitValue<ReplayValue>(out);
    expect(value.verify.ok).toBe(true);
    expect(value.report.steps.map((s) => [s.tool, s.status])).toEqual([
      ["mcp_notes_search", "skipped-non-read"],
    ]);
    expect(executed).toBe(0);
    // Refused before the mesh is even resolved: no user MCP server is spawned for it.
    expect(resolved).toBe(0);
  });
});

describe("share.replay — refusals before anything runs", () => {
  test("neither input nor bytesB64 (including a non-object payload) is ERR_INVALID_PARAMS", async () => {
    for (const params of [null, {}, { bytesB64: 7, input: false }]) {
      const err = await rejectionOf(dispatchShareRpc("share.replay", params, ctxWith()));
      expect(err).toBeInstanceOf(ShareRpcError);
      expect((err as ShareRpcError).rpcCode).toBe(-32602);
      expect((err as ShareRpcError).message).toBe(
        "ERR_INVALID_PARAMS: input (url/path) or bytesB64 required",
      );
    }
  });

  test("bytes that are not a share file are refused as such — allowUnsigned cannot override it", async () => {
    let resolved = 0;
    for (const allowUnsigned of [false, true]) {
      const err = await rejectionOf(
        dispatchShareRpc(
          "share.replay",
          {
            bytesB64: Buffer.from(JSON.stringify({ hello: "world" })).toString("base64"),
            allowUnsigned,
          },
          ctxWith({
            listReplayTools: async () => {
              resolved++;
              return {};
            },
          }),
        ),
      );
      expect((err as ShareRpcError).message).toBe("ERR_INVALID_PARAMS: not a share file");
    }
    expect(resolved).toBe(0);
  });
});

describe("share.create — sink variants", () => {
  test("no sink at all defaults to a pathless FILE sink: persisted, nothing emitted", async () => {
    const out = await dispatchShareRpc("share.create", { sessionId: "s1" }, ctxWith());
    const value = hitValue<{ status: string; contentHash: string; delivered?: boolean }>(out);
    expect(value.status).toBe("ok");
    expect(value).not.toHaveProperty("delivered");
    expect(getShareRecord(db, value.contentHash)).toMatchObject({
      contentHash: value.contentHash,
      kind: "transcript",
      sessionId: "s1",
      sink: "file",
    });
  });

  test("a transcript written to a .YML path is YAML that still verifies", async () => {
    const path = join(tmp, "out", "SHARE.YML");
    const out = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file", path } },
      ctxWith(),
    );
    const { contentHash } = hitValue<{ contentHash: string }>(out);
    const text = await readFile(path, "utf8");
    expect(text.trimStart().startsWith("{")).toBe(false);
    expect((yamlLoad(text) as { contentHash: string }).contentHash).toBe(contentHash);

    const verified = hitValue<{ ok: boolean }>(
      await dispatchShareRpc("share.verify", { input: path }, ctxWith()),
    );
    expect(verified.ok).toBe(true);
  });

  test("a transcript written to a .json path stays JSON", async () => {
    const path = join(tmp, "share.json");
    const out = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "file", path } },
      ctxWith(),
    );
    const { contentHash } = hitValue<{ contentHash: string }>(out);
    expect((JSON.parse(await readFile(path, "utf8")) as { contentHash: string }).contentHash).toBe(
      contentHash,
    );
  });

  test("a peer sink with no delivery wiring reports delivered:false and keeps the share", async () => {
    const out = await dispatchShareRpc(
      "share.create",
      { sessionId: "s1", sink: { type: "peer", peerId: "peer:carol" } },
      ctxWith(), // no deliverToPeer
    );
    const value = hitValue<{ status: string; delivered: boolean; contentHash: string }>(out);
    expect(value.status).toBe("ok");
    expect(value.delivered).toBe(false);
    expect(getShareRecord(db, value.contentHash)).toMatchObject({
      contentHash: value.contentHash,
      sink: "peer",
    });
  });

  test("an auth header NAME without a Vault key reads no token and sends no undefined key", async () => {
    // Half-configured auth must not reach `vault.get(undefined)`. The URL is loopback, so the
    // SSRF guard rejects the POST itself — after the share was approved, signed and persisted.
    const { vault, gets } = recordingVault();
    const err = await rejectionOf(
      dispatchShareRpc(
        "share.create",
        { sessionId: "s1", sink: { type: "http" } },
        ctxWith({
          vault,
          httpSink: { url: "http://127.0.0.1:9/share", authHeaderName: "x-share-token" },
        }),
      ),
    );
    // The SSRF guard's own refusal — not a connection error, so no request was attempted at all.
    expect((err as Error).message).toBe("unsafe url: host 127.0.0.1 is loopback/private");
    expect(gets).not.toContain(undefined);
    expect(gets).not.toContain("x-share-token");
    expect(listShareRecords(db, { now: 2000 })).toHaveLength(1);
  });
});

describe("share.inbox — the all switch", () => {
  test("the default view stops at 200 newest; all:true returns every received share", async () => {
    const seed = new Uint8Array(32).fill(3);
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const base: ShareFile = buildShareFile(
      {
        kind: "recipe",
        sessionId: "s1",
        createdAt: 1,
        expiresAt: null,
        redactionSet: [],
        origin: { label: "peer", pubkey: encodeBase64(kp.publicKey) },
        recipe: {
          recipeVersion: 1,
          sourceSessionId: "s1",
          generatedAt: 1,
          graphTraversals: [],
          steps: [],
        },
      },
      encodeBase64(seed),
      encodeBase64(kp.publicKey),
    );
    // The inbox stores without re-verifying, so distinct hashes are enough for distinct rows.
    for (let i = 0; i < 201; i++) {
      insertReceivedShare(db, { share: { ...base, contentHash: `hash-${i}` }, now: i });
    }
    const page = hitValue<{ inbox: Array<{ receivedAt: number }> }>(
      await dispatchShareRpc("share.inbox", {}, ctxWith()),
    );
    const all = hitValue<{ inbox: Array<{ receivedAt: number }> }>(
      await dispatchShareRpc("share.inbox", { all: true }, ctxWith()),
    );
    // The page is the NEWEST 200: it starts at the latest share and the oldest one is cut.
    expect(page.inbox).toHaveLength(200);
    expect(page.inbox[0]?.receivedAt).toBe(200);
    expect(page.inbox.map((r) => r.receivedAt)).not.toContain(0);
    expect(all.inbox).toHaveLength(201);
    expect(all.inbox[0]?.receivedAt).toBe(200);
    expect(all.inbox.at(-1)?.receivedAt).toBe(0);
  });
});
