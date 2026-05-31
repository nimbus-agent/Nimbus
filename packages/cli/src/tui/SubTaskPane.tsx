import { Box, Text } from "ink";
import React from "react";

import { PROGRESS_BAR_WIDTH, SUBTASK_PANE_ROW_LIMIT } from "./constants.ts";
import { useIpc } from "./ipc-context.ts";

interface SubTaskProgressPayload {
  subTaskId: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed" | "hitl_paused" | "skipped";
  progress: number;
}

function isSubTaskPayload(value: unknown): value is SubTaskProgressPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const okStatus =
    v["status"] === "pending" ||
    v["status"] === "running" ||
    v["status"] === "completed" ||
    v["status"] === "failed" ||
    v["status"] === "hitl_paused" ||
    v["status"] === "skipped";
  return (
    typeof v["subTaskId"] === "string" &&
    typeof v["name"] === "string" &&
    okStatus &&
    typeof v["progress"] === "number"
  );
}

function glyph(status: SubTaskProgressPayload["status"]): string {
  if (status === "completed") {
    return "✓";
  }
  if (status === "failed") {
    return "✗";
  }
  if (status === "hitl_paused") {
    return "⏸";
  }
  if (status === "skipped") {
    return "·";
  }
  return "↻";
}

function progressBar(progress: number): string {
  const clamped = Math.max(0, Math.min(1, progress));
  const filled = Math.round(clamped * PROGRESS_BAR_WIDTH);
  return `[${"=".repeat(filled)}${"-".repeat(PROGRESS_BAR_WIDTH - filled)}]`;
}

interface SubTaskPaneProps {
  readonly clearKey: number;
}

export function SubTaskPane({ clearKey }: SubTaskPaneProps): React.JSX.Element {
  const { client } = useIpc();

  const mapRef = React.useRef<Map<string, SubTaskProgressPayload>>(new Map());
  const [, forceUpdate] = React.useReducer((n: number) => n + 1, 0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: clearKey is a prop value used to trigger reset; mapRef mutation is intentional
  React.useLayoutEffect(() => {
    mapRef.current = new Map();
    forceUpdate();
  }, [clearKey]);

  React.useLayoutEffect(() => {
    const handler = (params: unknown): void => {
      if (!isSubTaskPayload(params)) {
        return;
      }
      mapRef.current.set(params.subTaskId, params);
      forceUpdate();
    };
    client.onNotification("agent.subTaskProgress", handler);
    // IPCClient has no off-notification API; handlers live for process lifetime.
    // A SubTaskPane remount simply registers another handler; the stale one
    // mutates the ref (harmless) and calls forceUpdate on the unmounted component
    // (which React silently ignores).
  }, [client]);

  const ordered = Array.from(mapRef.current.values());
  const shown = ordered.slice(0, SUBTASK_PANE_ROW_LIMIT);
  const hidden = ordered.length - shown.length;

  return (
    <Box flexDirection="column">
      <Text bold>Sub-Tasks</Text>
      {ordered.length === 0 ? (
        <Text dimColor>No sub-tasks running yet</Text>
      ) : (
        <>
          {shown.map((t) => (
            <Text key={t.subTaskId}>
              {progressBar(t.progress)} {glyph(t.status)} {t.name}
            </Text>
          ))}
          {hidden > 0 ? (
            <Text dimColor>
              …{String(hidden)} more ({String(ordered.length)} total)
            </Text>
          ) : null}
        </>
      )}
    </Box>
  );
}
