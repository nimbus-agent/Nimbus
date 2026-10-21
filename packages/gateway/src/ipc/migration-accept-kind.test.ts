import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import type { MigrationRow } from "../extensions/migration/migration-engine.ts";
import { LocalIndex } from "../index/local-index.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { MockVault } from "../vault/mock.ts";
import { createIpcServer } from "./server/index.ts";
import type { CreateIpcServerOptions } from "./server/options.ts";

/**
 * I46, end to end over a REAL IPC connection: the connection's declared kind becomes the
 * `fromRenderer` field of the audit row the executor gate writes for `extension.migrate`.
 *
 * Everything between the socket and the engine is production code — `session.declareKind` into
 * the `ClientKindStore`, `tryDispatchMigrationRpc`, the gate-only executor bound to this
 * connection's consent channel, the consent round trip over the socket, and the gate's own
 * `audit_log` row. Only the engine is a stand-in: it asks the consent it is handed, exactly once,
 * with the origin the RPC gave it (the real engine's whitelist is covered by the I46 block in
 * `security-invariants.test.ts`).
 */

const ROW: MigrationRow = {
  id: "m-1",
  legacyServiceId: "fixturewise",
  extensionId: "com.example.fixturewise",
  version: "1.0.0",
  treeDigest: "d".repeat(64),
  stagePath: null,
  state: "awaiting_approval",
  error: null,
  createdAt: 1,
  updatedAt: 1,
};

const ENGINE: NonNullable<CreateIpcServerOptions["migrationEngine"]> = {
  list: () => [ROW],
  accept: async (id, consent, origin) => {
    const approved = await consent({
      migrationId: id,
      extensionId: ROW.extensionId,
      summary: "s",
      publisher: { id: "nimbus", fingerprint: "f" },
      version: "1.0.0",
      network: "no network access",
      readTools: "r",
      knownLoss: "k",
      fromRenderer: origin?.fromRenderer === true,
    });
    return { ...ROW, state: approved ? "approved" : "awaiting_approval" };
  },
  decline: () => ROW,
  retry: async () => {},
};

let listenPath: string;
let server: Awaited<ReturnType<typeof createIpcServer>>;
let db: Database;

beforeAll(async () => {
  listenPath =
    platform() === "win32"
      ? `\\\\.\\pipe\\nimbus-i46-${randomUUID()}`
      : join(tmpdir(), `nimbus-i46-${randomUUID()}.sock`);
  db = openMemoryIndexDatabase();
  server = createIpcServer({
    listenPath,
    vault: new MockVault(),
    version: "i46-test",
    localIndex: new LocalIndex(db),
    dataDir: tmpdir(),
    configDir: tmpdir(),
    migrationEngine: ENGINE,
  });
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  db?.close();
});

interface Frame {
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: unknown;
  readonly error?: { code: number; message: string };
}

/**
 * One connection: sends `frames` in order, approves every `consent.request` it receives, and
 * resolves with the response to the frame whose id is `untilId`.
 */
function session(frames: readonly Frame[], untilId: string): Promise<Frame> {
  return new Promise((done, fail) => {
    const sock = net.createConnection(listenPath);
    let buf = "";
    const deadline = setTimeout(() => {
      sock.destroy();
      fail(new Error("TIMEOUT"));
    }, 10_000);
    const send = (f: Frame): void => {
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", ...f })}\n`);
    };
    sock.on("connect", () => {
      for (const f of frames) send(f);
    });
    sock.on("data", (d) => {
      buf += d.toString();
      for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
        const msg = JSON.parse(buf.slice(0, nl)) as Frame;
        buf = buf.slice(nl + 1);
        if (msg.method === "consent.request") {
          send({
            id: `respond-${String(msg.params?.["requestId"])}`,
            method: "consent.respond",
            params: { requestId: msg.params?.["requestId"], approved: true },
          });
        } else if (msg.id === untilId) {
          clearTimeout(deadline);
          sock.destroy();
          done(msg);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(deadline);
      fail(e);
    });
  });
}

/** The `fromRenderer` values on every `extension.migrate` audit row the gate has written. */
function auditedFromRenderer(): unknown[] {
  const rows = db
    .query("SELECT action_json FROM audit_log WHERE action_type = 'extension.migrate' ORDER BY id")
    .all() as Array<{ action_json: string }>;
  return rows.map((r) => {
    const parsed = JSON.parse(r.action_json) as { action?: { payload?: Record<string, unknown> } };
    return parsed.action?.payload?.["fromRenderer"];
  });
}

test("a connection that declared `ui` is audited fromRenderer: true; first declaration wins", async () => {
  const before = auditedFromRenderer().length;
  const out = await session(
    [
      { id: "k1", method: "session.declareKind", params: { kind: "ui" } },
      // A later re-declaration cannot relabel the connection.
      { id: "k2", method: "session.declareKind", params: { kind: "cli" } },
      { id: "a", method: "migration.accept", params: { id: "m-1" } },
    ],
    "a",
  );
  expect(out.error).toBeUndefined();
  expect((out.result as Record<string, unknown>)["state"]).toBe("approved");
  expect(auditedFromRenderer().slice(before)).toEqual([true]);
});

test("a connection that declared nothing is audited fromRenderer: false, whatever its params say", async () => {
  const before = auditedFromRenderer().length;
  const out = await session(
    [{ id: "a", method: "migration.accept", params: { id: "m-1", fromRenderer: true } }],
    "a",
  );
  expect(out.error).toBeUndefined();
  expect(auditedFromRenderer().slice(before)).toEqual([false]);
});
