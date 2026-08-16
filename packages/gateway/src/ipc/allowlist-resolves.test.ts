import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalIndex } from "../index/local-index.ts";
import { MockVault } from "../vault/mock.ts";
import { createIpcServer } from "./server/index.ts";

/**
 * I7 clause (a) — every `ALLOWED_METHODS` entry resolves to a real gateway handler.
 *
 * `docs/SECURITY-INVARIANTS.md` states the clause and tells authors to "update the allowlist test
 * that asserts every entry resolves to a real handler". **No such test existed.** The Rust side
 * checks size, alphabetization and duplicates; the TypeScript side greps the `.rs` for individual
 * names and pins the count. None of that can see a name with nothing behind it, and three entries
 * had nothing behind them — `connector.list` (no handler at all, dead since the day it was added)
 * plus `audit.export` and `audit.getSummary` (handlers registered, stranded by an arm guard that
 * named two methods where the leaf map served five).
 *
 * WHY A LIVE SERVER RATHER THAN A SOURCE SCAN. Dispatch here is not uniform: a method can be
 * served by a terminal switch, a namespace-prefix sub-dispatcher, a handler map behind
 * `dispatchByMethod`, a direct-index map, an inline handler in `dispatchers.ts`, or an alias to
 * another name — and two arms claim every method with no prefix check at all, so prefix-based
 * reasoning alone marks `team.auditMerged` and `scim.*` unresolved. A static model of eleven
 * shapes is a second implementation of the router that goes stale the first time someone adds a
 * twelfth. Booting the real router asks the real question.
 *
 * WHY THROWING STUBS. Many arms skip when their ctx option is `undefined`, and a skip is
 * indistinguishable from a structural miss at the wire (-32601 either way). Wiring every gating
 * option with a stub that THROWS means reaching one proves the method resolved — the error just
 * has to be something other than "method not found". Without this the test would report ~37 false
 * positives; with it, only genuine misses remain.
 */

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..");
const BRIDGE_RS = join(REPO_ROOT, "packages", "ui", "src-tauri", "src", "gateway_bridge.rs");

/** JSON-RPC "Method not found". The one error that means the router had nothing for this name. */
const METHOD_NOT_FOUND = -32601;

function allowedMethods(rust: string): string[] {
  const start = rust.indexOf("pub const ALLOWED_METHODS: &[&str] = &[");
  if (start === -1) throw new Error("ALLOWED_METHODS not found in gateway_bridge.rs");
  const end = rust.indexOf("];", start);
  return [...rust.slice(start, end).matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

let listenPath: string;
let server: Awaited<ReturnType<typeof createIpcServer>>;
let db: Database;
let methods: string[];

beforeAll(async () => {
  const rust = await Bun.file(BRIDGE_RS).text();
  methods = allowedMethods(rust);

  listenPath =
    platform() === "win32"
      ? `\\\\.\\pipe\\nimbus-allowlist-${randomUUID()}`
      : join(tmpdir(), `nimbus-allowlist-${randomUUID()}.sock`);

  db = new Database(":memory:");
  const localIndex = new LocalIndex(db);
  // Reaching one of these proves the method resolved; what it then does is not this test's
  // business. Any non--32601 outcome — a throw, a param-validation error, a real result — counts.
  const t = (): never => {
    throw new Error("STUB REACHED");
  };

  server = createIpcServer({
    listenPath,
    vault: new MockVault(),
    version: "allowlist-test",
    localIndex,
    dataDir: tmpdir(),
    configDir: tmpdir(),
    // Each only has to be `!== undefined` for its arm to stop skipping.
    statusReaders: { gateway: t, connectors: t, index: t } as never,
    llmRegistry: { listAllModels: t, checkAvailability: t, getRouterStatus: t } as never,
    profileManager: { list: t } as never,
    federationDiscovery: { list: t } as never,
    federationPairing: { listPeers: t } as never,
    identityStore: { listScimUsers: t, getSession: t } as never,
    identityIssuer: "https://example.invalid",
    policyRpcCtx: { showPolicy: t } as never,
    chatopsRpcCtx: { status: t } as never,
    tribalRpcCtx: { status: t, list: t } as never,
    shareRpcCtx: { list: t, get: t, inbox: t, pubkey: t, verify: t } as never,
    egressRpcCtx: { list: t, head: t, verify: t, proveWindow: t } as never,
  } as never);
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  db?.close();
});

function call(method: string): Promise<{ code: number | null; message: string }> {
  return new Promise((done) => {
    const sock = net.createConnection(listenPath);
    let buf = "";
    const finish = (v: { code: number | null; message: string }): void => {
      sock.destroy();
      done(v);
    };
    sock.on("connect", () =>
      sock.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} })}\n`),
    );
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const msg = JSON.parse(buf.slice(0, nl)) as {
        error?: { code: number; message?: string };
      };
      finish(
        msg.error === undefined
          ? { code: null, message: "resolved (result returned)" }
          : { code: msg.error.code, message: String(msg.error.message ?? "") },
      );
    });
    sock.on("error", (e) => finish({ code: -1, message: `socket: ${e.message}` }));
    setTimeout(() => finish({ code: -2, message: "TIMEOUT" }), 10_000);
  });
}

test("the parsed allowlist matches the Rust size assertion", async () => {
  // Non-vacuity, and it comes first: every assertion below iterates `methods`, so a parse that
  // silently produced an empty or truncated list would report a clean allowlist. The Rust
  // `assert_eq!` is the independent second opinion on the count.
  const rust = await Bun.file(BRIDGE_RS).text();
  const asserted = /ALLOWED_METHODS\.len\(\),\s*(\d+)/.exec(rust)?.[1];
  expect(asserted).toBeDefined();
  expect(methods.length).toBe(Number(asserted));
  expect(methods.length).toBeGreaterThan(100);
  expect(new Set(methods).size).toBe(methods.length);
});

test("every ALLOWED_METHODS entry resolves to a gateway handler", async () => {
  const unresolved: string[] = [];
  for (const method of methods) {
    const { code } = await call(method);
    if (code === METHOD_NOT_FOUND) unresolved.push(method);
  }
  // Named, not counted: the point of the failure message is to say WHICH renderer-callable method
  // the desktop would get -32601 from.
  expect(unresolved).toEqual([]);
}, 120_000);

test("a method that is NOT allowlisted still 404s — the probe can distinguish", async () => {
  // The control. Without it, a probe that never returned -32601 for anything (a broken socket
  // read, a swallowed error shape) would pass the test above while proving nothing at all.
  const { code } = await call("definitely.notAMethod");
  expect(code).toBe(METHOD_NOT_FOUND);
});
