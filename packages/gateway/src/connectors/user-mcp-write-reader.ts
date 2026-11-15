// packages/gateway/src/connectors/user-mcp-write-reader.ts
// What a registered user MCP server may WRITE, read from its own row at the moment a prompt is built
// (I15; Phase 28 AD5b). The executor shows it on a model's or the owner's call to that server, and
// refuses the call before any prompt when it cannot be told: `undefined` here means exactly that
// (no such server, an unreadable row, a malformed list).
import type { Database } from "bun:sqlite";

import { getUserMcpConnector } from "./user-mcp-store.ts";

/** The reader the executors are given: `serviceId` to its write directories, or `undefined`. */
export type UserMcpWriteGrantsReader = (serviceId: string) => readonly string[] | undefined;

export function userMcpWriteGrantsReader(db: () => Database): UserMcpWriteGrantsReader {
  return (serviceId) => {
    try {
      const row = getUserMcpConnector(db(), serviceId);
      if (row === null) return undefined;
      const parsed: unknown = JSON.parse(row.write_paths_json);
      return Array.isArray(parsed) && parsed.every((x): x is string => typeof x === "string")
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  };
}
