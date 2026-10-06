import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import { readIndexedUserVersion } from "../index/migrations/runner.ts";

export type UserMcpConnectorRow = {
  service_id: string;
  command: string;
  args_json: string;
  created_at: number;
  read_paths_json: string;
  net_hosts_json: string;
  model_access: number;
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

const SELECT_V65 =
  "SELECT service_id, command, args_json, created_at, read_paths_json, net_hosts_json, model_access FROM user_mcp_connector";
const SELECT_PRE_V65 =
  "SELECT service_id, command, args_json, created_at, '[]' AS read_paths_json, '[]' AS net_hosts_json, 0 AS model_access FROM user_mcp_connector";

function selectUserMcp(db: Database): string {
  return readIndexedUserVersion(db) >= 65 ? SELECT_V65 : SELECT_PRE_V65;
}

export function listUserMcpConnectors(db: Database): UserMcpConnectorRow[] {
  if (readIndexedUserVersion(db) < 11) {
    return [];
  }
  return db.query(`${selectUserMcp(db)} ORDER BY service_id`).all() as UserMcpConnectorRow[];
}

export function getUserMcpConnector(db: Database, serviceId: string): UserMcpConnectorRow | null {
  if (readIndexedUserVersion(db) < 11) {
    return null;
  }
  return db
    .query(`${selectUserMcp(db)} WHERE service_id = ?`)
    .get(serviceId) as UserMcpConnectorRow | null;
}

export function insertUserMcpConnector(
  db: Database,
  row: Omit<UserMcpConnectorRow, "created_at"> & { created_at?: number },
): void {
  const version = readIndexedUserVersion(db);
  if (version < 11) {
    throw new Error("user_mcp_connector requires schema v11+");
  }
  if (version < 65) {
    throw new Error("user_mcp_connector grants require schema v65+");
  }
  const created = row.created_at ?? Date.now();
  dbRun(
    db,
    `INSERT INTO user_mcp_connector (service_id, command, args_json, created_at, read_paths_json, net_hosts_json, model_access) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.service_id,
      row.command,
      row.args_json,
      created,
      row.read_paths_json,
      row.net_hosts_json,
      row.model_access,
    ],
  );
}

export function deleteUserMcpConnector(db: Database, serviceId: string): boolean {
  if (readIndexedUserVersion(db) < 11) {
    return false;
  }
  const r = dbRun(db, `DELETE FROM user_mcp_connector WHERE service_id = ?`, [serviceId]);
  return r.changes > 0;
}
