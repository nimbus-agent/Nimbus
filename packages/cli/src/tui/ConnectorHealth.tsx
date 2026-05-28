import { Box, Text } from "ink";
import type React from "react";

import { STATUS_POLL_INTERVAL_MS } from "./constants.ts";
import type { TuiMode } from "./state.ts";
import { useIpcPoll } from "./useIpcPoll.ts";

interface ConnectorRow {
  serviceId: string;
  status: "ok" | "syncing" | "paused" | "backoff" | "error";
}

function isConnectorRow(row: unknown): row is ConnectorRow {
  if (typeof row !== "object" || row === null) {
    return false;
  }
  const r = row as Record<string, unknown>;
  return (
    typeof r["serviceId"] === "string" &&
    (r["status"] === "ok" ||
      r["status"] === "syncing" ||
      r["status"] === "paused" ||
      r["status"] === "backoff" ||
      r["status"] === "error")
  );
}

function isConnectorList(data: unknown): data is ConnectorRow[] {
  return Array.isArray(data) && data.every(isConnectorRow);
}

function glyph(status: ConnectorRow["status"]): string {
  if (status === "ok") {
    return "●";
  }
  if (status === "syncing" || status === "paused") {
    return "◐";
  }
  return "○";
}

function isDegraded(status: ConnectorRow["status"]): boolean {
  return status === "backoff" || status === "error";
}

interface ConnectorHealthProps {
  readonly mode: TuiMode;
}

function renderBody(
  poll: ReturnType<typeof useIpcPoll<unknown>>,
  rows: ConnectorRow[],
): React.JSX.Element {
  if (poll.data === null && rows.length === 0) {
    return <Text dimColor>Loading connector status…</Text>;
  }
  if (rows.length === 0) {
    return <Text dimColor>No connectors registered</Text>;
  }
  return (
    <>
      {rows.map((r) => (
        <Text key={r.serviceId}>
          {isDegraded(r.status) ? "⚠ " : "  "}
          {glyph(r.status)} {r.serviceId}
        </Text>
      ))}
    </>
  );
}

export function ConnectorHealth({ mode }: ConnectorHealthProps): React.JSX.Element {
  const poll = useIpcPoll<unknown>("connector.listStatus", STATUS_POLL_INTERVAL_MS, mode);
  const rows = isConnectorList(poll.data) ? poll.data : [];
  return (
    <Box flexDirection="column">
      <Text bold>Connectors{poll.stale ? " (stale)" : ""}</Text>
      {renderBody(poll, rows)}
    </Box>
  );
}
