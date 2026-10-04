import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LocalIndex } from "../index/local-index.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "./automation-rpc.ts";
import { type ChatopsRpcCtx, dispatchChatopsRpc } from "./chatops-rpc.ts";
import { type ComputerRpcCtx, ComputerRpcError, dispatchComputerRpc } from "./computer-rpc.ts";
import { dispatchExecRpc, type ExecRpcCtx, ExecRpcError } from "./exec-rpc.ts";
import {
  dispatchFederationRpc,
  type FederationRpcContext,
  FederationRpcError,
} from "./federation-rpc.ts";
import { dispatchIdentityRpc, type IdentityRpcContext, IdentityRpcError } from "./identity-rpc.ts";
import { dispatchPeopleRpc, PeopleRpcError } from "./people-rpc.ts";
import { dispatchSessionRpc, SessionRpcError } from "./session-rpc.ts";
import { dispatchShareRpc, type ShareRpcCtx, ShareRpcError } from "./share-rpc.ts";
import { dispatchToolgenRpc, type ToolgenRpcCtx, ToolgenRpcError } from "./toolgen-rpc.ts";
import { dispatchTribalRpc, type TribalRpcCtx } from "./tribal-rpc.ts";

/**
 * Which `rpc-params.ts` helper each dispatcher uses, pinned through the dispatcher itself.
 *
 * The four helpers differ in their rule AND in their refusal's wording, and each module's wording
 * has always been on the wire. A call site names its helper in one identifier, so swapping a module
 * to a sibling helper — `requireNonEmptyStringParam` for `requireNonEmptyStringField`, say — is a
 * one-word edit that compiles, keeps the error class, and silently changes both the rule and the
 * message. `rpc-params.test.ts` pins each helper's own behaviour and that every caller passes its
 * OWN error class; it cannot see which helper a module picked. This file can: every helper's
 * message template is unique, so one exact refusal per module identifies the helper it reaches.
 *
 * Each call below refuses before the handler touches its context, which is why the contexts are
 * empty stand-ins.
 */

type Refusal = {
  readonly module: string;
  readonly call: () => unknown;
  /** The module's own error class, or plain `Error` for the two modules that always threw one. */
  readonly errorClass: abstract new (
    ...args: never[]
  ) => Error;
  /** `undefined` for a plain `Error`, which carries no JSON-RPC code of its own. */
  readonly rpcCode: number | undefined;
  readonly message: string;
};

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});
function db(): Database {
  const d = new Database(":memory:");
  openDbs.push(d);
  return d;
}

const REFUSALS: readonly Refusal[] = [
  {
    module: "computer-rpc",
    call: () => dispatchComputerRpc("computer.sessionClose", {}, {} as unknown as ComputerRpcCtx),
    errorClass: ComputerRpcError,
    rpcCode: -32602,
    message: "ERR_INVALID_PARAMS: sessionId (non-empty string) required",
  },
  {
    module: "exec-rpc",
    call: () => dispatchExecRpc("exec.approvalRespond", {}, {} as unknown as ExecRpcCtx),
    errorClass: ExecRpcError,
    rpcCode: -32602,
    message: "ERR_INVALID_PARAMS: requestId (non-empty string) required",
  },
  {
    module: "share-rpc",
    call: () => dispatchShareRpc("share.get", {}, {} as unknown as ShareRpcCtx),
    errorClass: ShareRpcError,
    rpcCode: -32602,
    message: "ERR_INVALID_PARAMS: contentHash (non-empty string) required",
  },
  {
    module: "toolgen-rpc",
    call: () => dispatchToolgenRpc("toolgen.approvalRespond", {}, {} as unknown as ToolgenRpcCtx),
    errorClass: ToolgenRpcError,
    rpcCode: -32602,
    message: "ERR_INVALID_PARAMS: requestId (non-empty string) required",
  },
  {
    module: "federation-rpc",
    call: () =>
      dispatchFederationRpc("federation.pair", {}, {
        db: db(),
      } as unknown as FederationRpcContext),
    errorClass: FederationRpcError,
    rpcCode: -32602,
    message: "ERR_INVALID_PARAMS: host must be a non-empty string",
  },
  {
    module: "identity-rpc",
    call: () => dispatchIdentityRpc("identity.bind", {}, {} as unknown as IdentityRpcContext),
    errorClass: IdentityRpcError,
    rpcCode: -32602,
    message: "ERR_INVALID_PARAMS: email must be a non-empty string",
  },
  {
    module: "automation-rpc",
    call: () => dispatchAutomationRpc({ method: "watcher.delete", params: {}, db: db() }),
    errorClass: AutomationRpcError,
    rpcCode: -32602,
    message: "Missing or invalid id",
  },
  {
    module: "people-rpc",
    call: () => {
      const d = db();
      const localIndex = { getDatabase: () => d } as unknown as LocalIndex;
      return dispatchPeopleRpc({ method: "people.get", params: {}, localIndex });
    },
    errorClass: PeopleRpcError,
    rpcCode: -32602,
    message: "Missing or invalid id",
  },
  {
    module: "session-rpc",
    call: () =>
      dispatchSessionRpc({
        method: "session.append",
        params: {},
        store: {} as unknown as SessionMemoryStore,
      }),
    errorClass: SessionRpcError,
    rpcCode: -32602,
    message: "Missing or invalid sessionId",
  },
  {
    module: "chatops-rpc",
    call: () => dispatchChatopsRpc("chatops.test", {}, {} as unknown as ChatopsRpcCtx),
    errorClass: Error,
    rpcCode: undefined,
    message: "ERR_INVALID_PARAMS: text (string) required",
  },
  {
    module: "tribal-rpc",
    call: () => dispatchTribalRpc("tribal.dismiss", {}, {} as unknown as TribalRpcCtx),
    errorClass: Error,
    rpcCode: undefined,
    message: "ERR_INVALID_PARAMS: clusterId (string) required",
  },
];

/** What the call threw or rejected with — a sync throw (`dispatchPeopleRpc`) included. */
async function rejectionOf(call: () => unknown): Promise<unknown> {
  try {
    await call();
  } catch (e) {
    return e;
  }
  throw new Error("expected the dispatcher to refuse");
}

describe("each dispatcher reaches the rpc-params.ts helper it has always matched", () => {
  test.each(REFUSALS.map((r) => [r.module, r] as const))("%s", async (_module, r) => {
    const e = await rejectionOf(r.call);
    // EXACT class, not `instanceof`: a plain `Error` must stay plain, and a coded error must be the
    // module's own class, which is what `ipc/server/dispatchers.ts` routes on.
    expect((e as Error).constructor).toBe(r.errorClass);
    expect((e as { rpcCode?: unknown }).rpcCode).toBe(r.rpcCode);
    expect((e as Error).message).toBe(r.message);
  });

  test("every ipc/ module that imports rpc-params.ts has a row above", () => {
    // Derived, not hand-kept: a module that starts using one of the helpers without a row here
    // would otherwise sit outside this pin while every listed row stayed green.
    const ipcDir = import.meta.dir;
    const importers = readdirSync(ipcDir, { recursive: true, encoding: "utf8" })
      .filter((rel) => rel.endsWith(".ts") && !rel.endsWith(".test.ts") && rel !== "rpc-params.ts")
      .filter((rel) =>
        /from "(?:\.\.?\/)+(?:ipc\/)?rpc-params\.ts"/.test(readFileSync(join(ipcDir, rel), "utf8")),
      )
      .map((rel) => basename(rel, ".ts"))
      .sort();
    expect(importers.length).toBeGreaterThan(0);
    expect(importers).toEqual(REFUSALS.map((r) => r.module).sort());
  });
});
