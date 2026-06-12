import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlannedAction } from "../engine/types.ts";
import {
  buildE2eSinkDispatcher,
  buildE2eSinkRunChatopsTool,
} from "./chatops-tool-runner-e2e-sink.ts";

/**
 * Unit coverage for the e2e ChatOps test seam (`NIMBUS_CHATOPS_E2E_SINK_DIR`). The seam is driven
 * end-to-end by the real-gateway e2e, but that runs as a subprocess so its coverage isn't counted;
 * these in-process tests exercise every branch of the file-backed runner + dispatcher directly.
 */
let dir: string;

function readSink(): Record<string, unknown>[] {
  const raw = readFileSync(join(dir, "mock-chatops-sink.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function writeConfig(cfg: unknown): void {
  writeFileSync(join(dir, "mock-chatops.json"), JSON.stringify(cfg));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chatops-sink-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildE2eSinkRunChatopsTool", () => {
  test("socket_open returns the configured wsUrl", async () => {
    writeConfig({ wsUrl: "wss://mock/socket", users: {} });
    const run = buildE2eSinkRunChatopsTool(dir);
    expect(await run("slack", "slack_socket_open", {})).toEqual({ url: "wss://mock/socket" });
  });

  test("socket_open with no config file → empty url (tolerant JSON read)", async () => {
    // No mock-chatops.json written → cfg() catch branch returns { wsUrl: "", users: {} }.
    const run = buildE2eSinkRunChatopsTool(dir);
    expect(await run("teams", "teams_socket_open", {})).toEqual({ url: "" });
  });

  test("slack user_info resolves the email via args.user (slack profile shape)", async () => {
    writeConfig({ wsUrl: "", users: { U_BOB: "bob@acme.com" } });
    const run = buildE2eSinkRunChatopsTool(dir);
    expect(await run("slack", "slack_user_info", { user: "U_BOB" })).toEqual({
      user: { profile: { email: "bob@acme.com" } },
    });
  });

  test("teams user_info resolves the email via args.userId (graph mail shape)", async () => {
    writeConfig({ wsUrl: "", users: { T_ALICE: "alice@acme.com" } });
    const run = buildE2eSinkRunChatopsTool(dir);
    expect(await run("teams", "teams_user_info", { userId: "T_ALICE" })).toEqual({
      mail: "alice@acme.com",
    });
  });

  test("unknown slack user → empty slack user shape (fail-soft unmapped)", async () => {
    writeConfig({ wsUrl: "", users: {} });
    const run = buildE2eSinkRunChatopsTool(dir);
    expect(await run("slack", "slack_user_info", { user: "U_EVE" })).toEqual({ user: {} });
  });

  test("unknown teams user → empty teams shape", async () => {
    writeConfig({ wsUrl: "", users: {} });
    const run = buildE2eSinkRunChatopsTool(dir);
    expect(await run("teams", "teams_user_info", { userId: "T_EVE" })).toEqual({});
  });

  test("user_info with non-string id and no args coerces to empty id → unmapped", async () => {
    writeConfig({ wsUrl: "", users: {} });
    const run = buildE2eSinkRunChatopsTool(dir);
    // args undefined → (args ?? {}) branch; id object → typeof !== "string" → "".
    expect(await run("slack", "slack_user_info", undefined)).toEqual({ user: {} });
    expect(await run("teams", "teams_user_info", { userId: { nested: true } })).toEqual({});
  });

  test("slack chat_post records a chat_post event keyed on channel", async () => {
    const run = buildE2eSinkRunChatopsTool(dir);
    expect(await run("slack", "slack_chat_post", { channel: "C0", text: "hi" })).toEqual({
      ok: true,
    });
    const [ev] = readSink();
    expect(ev).toEqual({ kind: "chat_post", platform: "slack", channel: "C0", text: "hi" });
  });

  test("teams chat_post records via conversationId; missing channel/text default to empty", async () => {
    const run = buildE2eSinkRunChatopsTool(dir);
    await run("teams", "teams_chat_post", { conversationId: "19:conv" });
    const [ev] = readSink();
    expect(ev).toEqual({
      kind: "chat_post",
      platform: "teams",
      channel: "19:conv",
      text: "",
    });
  });

  test("a non-post connector tool records a generic tool invocation", async () => {
    const run = buildE2eSinkRunChatopsTool(dir);
    expect(await run("slack", "deployment.rollback", { service: "pay" })).toEqual({ ok: true });
    const [ev] = readSink();
    expect(ev).toEqual({ kind: "tool", toolId: "deployment.rollback", args: { service: "pay" } });
  });
});

describe("buildE2eSinkDispatcher", () => {
  test("records the dispatched action type + payload and returns an ok envelope", async () => {
    const dispatch = buildE2eSinkDispatcher(dir);
    const action: PlannedAction = {
      type: "deployment.rollback",
      payload: { service: "payment-service", version: "v1.4" },
    };
    expect(await dispatch.dispatch(action)).toEqual({
      ok: true,
      action: "deployment.rollback",
      id: "e2e-kb-page-1",
    });
    const [ev] = readSink();
    expect(ev).toEqual({
      kind: "dispatch",
      type: "deployment.rollback",
      payload: { service: "payment-service", version: "v1.4" },
    });
  });

  test("an action with no payload records an empty payload object", async () => {
    const dispatch = buildE2eSinkDispatcher(dir);
    await dispatch.dispatch({ type: "chatops.noop" } as PlannedAction);
    const [ev] = readSink();
    expect(ev).toEqual({ kind: "dispatch", type: "chatops.noop", payload: {} });
  });
});
