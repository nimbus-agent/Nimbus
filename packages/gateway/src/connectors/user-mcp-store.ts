import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

export type UserMcpConnectorRow = {
  service_id: string;
  command: string;
  args_json: string;
  created_at: number;
};

export const USER_MCP_SERVICE_ID_PATTERN = /^mcp_[a-z0-9_]{1,62}$/;

export function normalizeUserMcpServiceId(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!USER_MCP_SERVICE_ID_PATTERN.test(s)) {
    return null;
  }
  return s;
}

export function parseUserMcpCommandLine(line: string): { command: string; args: string[] } {
  const trimmed = line.trim();
  if (trimmed === "") {
    throw new Error("MCP command line is empty");
  }
  const parts = trimmed.split(/\s+/).filter((p) => p.length > 0);
  const command = parts[0];
  if (command === undefined || command === "") {
    throw new Error("MCP command line is empty");
  }
  return { command, args: parts.slice(1) };
}

export function validateUserMcpArgsJson(args: string[]): string {
  return JSON.stringify(args);
}

export function listUserMcpConnectors(db: Database): UserMcpConnectorRow[] {
  if (readIndexedUserVersion(db) < 11) {
    return [];
  }
  return db
    .query(
      `SELECT service_id, command, args_json, created_at FROM user_mcp_connector ORDER BY service_id`,
    )
    .all() as UserMcpConnectorRow[];
}

export function getUserMcpConnector(db: Database, serviceId: string): UserMcpConnectorRow | null {
  if (readIndexedUserVersion(db) < 11) {
    return null;
  }
  return db
    .query(
      `SELECT service_id, command, args_json, created_at FROM user_mcp_connector WHERE service_id = ?`,
    )
    .get(serviceId) as UserMcpConnectorRow | null;
}

export function insertUserMcpConnector(
  db: Database,
  row: Omit<UserMcpConnectorRow, "created_at"> & { created_at?: number },
): void {
  if (readIndexedUserVersion(db) < 11) {
    throw new Error("user_mcp_connector requires schema v11+");
  }
  const created = row.created_at ?? Date.now();
  dbRun(
    db,
    `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at) VALUES (?, ?, ?, ?)`,
    [row.service_id, row.command, row.args_json, created],
  );
}

export function deleteUserMcpConnector(db: Database, serviceId: string): boolean {
  if (readIndexedUserVersion(db) < 11) {
    return false;
  }
  const r = dbRun(db, `DELETE FROM user_mcp_connector WHERE service_id = ?`, [serviceId]);
  return r.changes > 0;
}
