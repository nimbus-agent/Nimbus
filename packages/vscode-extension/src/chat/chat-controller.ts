import type { AskStreamHandle, AskStreamOptions, StreamEvent } from "@nimbus-dev/client";

import type { Logger } from "../logging.js";
import type { ChatPanel } from "./chat-panel.js";
import type { ExtensionToWebview } from "./chat-protocol.js";
import type { SessionStore } from "./session-store.js";

export interface ChatClientLike {
  askStream(input: string, opts?: AskStreamOptions): AskStreamHandle;
  cancelStream(streamId: string): Promise<{ ok: boolean }>;
  getSessionTranscript(params: { sessionId: string; limit?: number }): Promise<{
    sessionId: string;
    turns: Array<{ role: "user" | "assistant"; text: string; timestamp: number }>;
    hasMore: boolean;
  }>;
}

export interface ChatControllerDeps {
  client: ChatClientLike;
  panel: ChatPanel;
  sessionStore: SessionStore;
  registerStreamWithHitl(streamId: string): void;
  unregisterStreamWithHitl(streamId: string): void;
  log: Logger;
  agent?: () => string;
}

export interface ChatController {
  start(input: string): Promise<void>;
  stop(): Promise<void>;
  newConversation(): Promise<void>;
  rehydrateIfNeeded(limit: number): Promise<void>;
  isStreaming(): boolean;
}

function buildAskStreamOptions(
  sessionStore: SessionStore,
  agent: (() => string) | undefined,
): AskStreamOptions {
  const opts: AskStreamOptions = {};
  const sid = sessionStore.get();
  if (sid !== undefined) opts.sessionId = sid;
  const agentName = agent?.() ?? "";
  if (agentName.length > 0) opts.agent = agentName;
  return opts;
}

function buildSubTaskMessage(ev: {
  subTaskId: string;
  status: string;
  progress?: number;
}): ExtensionToWebview {
  if (typeof ev.progress === "number") {
    return {
      type: "subTask",
      subTaskId: ev.subTaskId,
      status: ev.status,
      progress: ev.progress,
    };
  }
  return { type: "subTask", subTaskId: ev.subTaskId, status: ev.status };
}

export function createChatController(deps: ChatControllerDeps): ChatController {
  let active: AskStreamHandle | undefined;

  const post = (m: ExtensionToWebview): void => {
    void deps.panel.postMessage(m);
  };

  const handleEvent = async (ev: StreamEvent): Promise<boolean> => {
    if (ev.type === "token") {
      post({ type: "token", text: ev.text });
      return false;
    }
    if (ev.type === "subTaskProgress") {
      post(buildSubTaskMessage(ev));
      return false;
    }
    if (ev.type === "hitlBatch") {
      post({
        type: "hitlInline",
        requestId: ev.requestId,
        prompt: ev.prompt,
        details: ev.details,
      });
      return false;
    }
    if (ev.type === "done") {
      post({ type: "done", reply: ev.reply, sessionId: ev.sessionId });
      if (ev.sessionId.length > 0) {
        await deps.sessionStore.set(ev.sessionId);
      }
      return true;
    }
    if (ev.type === "error") {
      post({ type: "error", message: ev.message });
      deps.log.error(`Stream error: ${ev.code}: ${ev.message}`);
      return true;
    }
    return false;
  };

  return {
    async start(input): Promise<void> {
      if (active !== undefined) {
        throw new Error("Stream in progress; click Stop or wait for it to finish.");
      }
      const opts = buildAskStreamOptions(deps.sessionStore, deps.agent);
      const handle = deps.client.askStream(input, opts);
      active = handle;
      post({ type: "userMessage", text: input });
      try {
        let registered = false;
        for await (const ev of handle) {
          if (!registered && handle.streamId.length > 0) {
            deps.registerStreamWithHitl(handle.streamId);
            registered = true;
          }
          if (await handleEvent(ev)) break;
        }
      } finally {
        if (handle.streamId.length > 0) {
          deps.unregisterStreamWithHitl(handle.streamId);
        }
        active = undefined;
      }
    },
    async stop(): Promise<void> {
      if (active === undefined) return;
      await active.cancel();
      active = undefined;
    },
    async newConversation(): Promise<void> {
      if (active !== undefined) {
        await active.cancel();
        active = undefined;
      }
      await deps.sessionStore.clear();
      post({ type: "reset" });
    },
    async rehydrateIfNeeded(limit): Promise<void> {
      const sid = deps.sessionStore.get();
      if (sid === undefined) {
        post({ type: "emptyState", sub: "no-transcript" });
        return;
      }
      try {
        const r = await deps.client.getSessionTranscript({ sessionId: sid, limit });
        post({ type: "hydrate", turns: r.turns });
      } catch (e) {
        deps.log.warn(`getSessionTranscript failed: ${e instanceof Error ? e.message : String(e)}`);
        post({ type: "emptyState", sub: "no-transcript" });
      }
    },
    isStreaming: () => active !== undefined,
  };
}
