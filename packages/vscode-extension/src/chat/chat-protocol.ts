export type ExtensionToWebview =
  | { type: "reset" }
  | {
      type: "hydrate";
      turns: Array<{ role: "user" | "assistant"; text: string; timestamp: number }>;
    }
  | { type: "userMessage"; text: string }
  | { type: "token"; text: string }
  | { type: "subTask"; subTaskId: string; status: string; progress?: number }
  | {
      type: "hitlInline";
      requestId: string;
      prompt: string;
      details?: unknown;
    }
  | { type: "done"; reply: string; sessionId: string }
  | { type: "error"; message: string }
  | {
      type: "emptyState";
      sub: "no-transcript" | "disconnected" | "permission-denied";
      socketPath?: string;
    }
  | { type: "themeChange" };

export type WebviewToExtension =
  | { type: "submitAsk"; text: string }
  | { type: "stopStream" }
  | { type: "hitlResponse"; requestId: string; decision: "approve" | "reject" }
  | { type: "requestRehydrate"; sessionId: string }
  | { type: "ready" }
  | { type: "openLogs" }
  | { type: "startGateway" }
  | { type: "openExternal"; url: string };
