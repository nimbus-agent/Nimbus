import type { IPCClient } from "../ipc-client/index.ts";

/**
 * Declares this connection as the owner's CLI (`session.declareKind { kind: "cli" }`). Call it as the
 * FIRST frame after `connect()` on a conversational connection (`nimbus ask`, `nimbus repl`): the
 * gateway records a connection's kind once (first declaration wins) and offers the model's
 * connector-write door only to `cli` / `ui` turns.
 *
 * The kind is SELF-REPORTED, not an authorization: any local process on the user-only socket can
 * declare `cli`. The boundary is the local socket plus the owner's HITL prompt on every write; the
 * kind map keeps the MCP adapter (`mcp`), HTTP, ChatOps, fleet, push and non-declaring clients out.
 *
 * Best-effort, like the MCP adapter's declaration: an older gateway without the method, or any other
 * failure, leaves the connection `unknown` (no door tools) and never breaks the command. A dead
 * connection surfaces on the command's next real call.
 */
export async function declareCliClientKind(client: Pick<IPCClient, "call">): Promise<void> {
  try {
    await client.call("session.declareKind", { kind: "cli" });
  } catch {
    // Best-effort: see above.
  }
}
