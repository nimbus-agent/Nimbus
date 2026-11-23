import type { SessionMemoryStore } from "../../memory/session-memory-store.ts";

export function formatResultSummary(results: unknown[]): string {
  if (results.length === 0) {
    return "Done.";
  }
  const parts: string[] = [];
  for (const r of results) {
    try {
      parts.push(typeof r === "string" ? r : JSON.stringify(r, undefined, 2));
    } catch {
      parts.push(String(r));
    }
  }
  return parts.join("\n---\n");
}

export async function loadRecentConversationHistory(
  store: SessionMemoryStore | undefined,
  sessionId: string | undefined,
): Promise<Array<{ role: "user" | "assistant" | "tool"; text: string }>> {
  if (store === undefined || sessionId === undefined || sessionId === "") {
    return [];
  }
  try {
    const recent = await store.getRecentTurns(sessionId, 12);
    return recent.map((t) => ({ role: t.role, text: t.text }));
  } catch {
    return [];
  }
}

export async function persistConversationTurn(
  store: SessionMemoryStore | undefined,
  sessionId: string | undefined,
  userInput: string,
  assistantReply: string,
): Promise<void> {
  if (store === undefined || sessionId === undefined || sessionId === "") {
    return;
  }
  const now = Date.now();
  try {
    await store.append({
      sessionId,
      role: "user",
      text: userInput,
      createdAt: now,
    });
    await store.append({
      sessionId,
      role: "assistant",
      text: assistantReply,
      createdAt: now + 1,
    });
  } catch {
    // best-effort persistence
  }
}
