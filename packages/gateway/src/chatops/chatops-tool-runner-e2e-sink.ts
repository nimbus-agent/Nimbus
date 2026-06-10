import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import type { RunChatopsTool } from "./chatops-tool-runner.ts";

/**
 * E2E test seam (gated by `NIMBUS_CHATOPS_E2E_SINK_DIR`, same precedent class as
 * `NIMBUS_SKIP_EMBEDDING_RUNTIME`): a file-backed ChatOps connector-tool runner that stands in for
 * the bot-credentialed connector subprocess. It is the "mock Slack/Teams transport" the e2e drives
 * a REAL gateway against — so the e2e exercises the full boot wiring (IPC, signed policy, SCIM,
 * executor HITL gate, audit chain, I23 reply surface) without depending on the OS sandbox spawn,
 * which is verified independently (chatops-bot-spawn.test.ts + the Docker shell-pipe proof).
 *
 * Protocol (all under the sink dir):
 *   read  `mock-chatops.json`  → `{ wsUrl, users: { <userId>: <email> } }`
 *   write `mock-chatops-sink.ndjson` ← one JSON line per chat_post / rollback (the e2e asserts on these)
 */
interface SinkConfig {
  readonly wsUrl: string;
  readonly users: Record<string, string>;
}

export function buildE2eSinkRunChatopsTool(sinkDir: string): RunChatopsTool {
  const cfg = (): SinkConfig => {
    try {
      return JSON.parse(readFileSync(join(sinkDir, "mock-chatops.json"), "utf8")) as SinkConfig;
    } catch {
      return { wsUrl: "", users: {} };
    }
  };
  const record = (event: Record<string, unknown>): void => {
    appendFileSync(join(sinkDir, "mock-chatops-sink.ndjson"), `${JSON.stringify(event)}\n`);
  };

  return (platform, toolId, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    if (toolId === "slack_socket_open") return Promise.resolve({ url: cfg().wsUrl });
    if (toolId === "slack_user_info" || toolId === "teams_user_info") {
      const userId = String(a["user"] ?? a["userId"] ?? "");
      const email = cfg().users[userId];
      if (email === undefined) return Promise.resolve(platform === "slack" ? { user: {} } : {});
      return Promise.resolve(
        platform === "slack" ? { user: { profile: { email } } } : { mail: email },
      );
    }
    if (toolId === "slack_chat_post" || toolId === "teams_chat_post") {
      record({
        kind: "chat_post",
        platform,
        channel: a["channel"] ?? a["conversationId"] ?? "",
        text: a["text"] ?? "",
      });
      return Promise.resolve({ ok: true });
    }
    // An approved write dispatches its action.type as a connector tool; record the invocation.
    record({ kind: "tool", toolId, args: a });
    return Promise.resolve({ ok: true });
  };
}

/**
 * The matching mock connector DISPATCHER: an approved ChatOps write runs through
 * `executor.execute` → `ConnectorDispatcher.dispatch`, which in production resolves the action
 * against the live mesh tool map. For the e2e it records the dispatched action to the same sink so
 * the test can assert "connector tool invoked" alongside the audit `hitlStatus=approved` row.
 */
export function buildE2eSinkDispatcher(sinkDir: string): ConnectorDispatcher {
  return {
    dispatch(action: PlannedAction): Promise<unknown> {
      appendFileSync(
        join(sinkDir, "mock-chatops-sink.ndjson"),
        `${JSON.stringify({ kind: "dispatch", type: action.type, payload: action.payload ?? {} })}\n`,
      );
      return Promise.resolve({ ok: true, action: action.type });
    },
  };
}
