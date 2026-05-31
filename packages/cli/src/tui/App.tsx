import { Box, Text, useStdout } from "ink";
import React from "react";

import { ConnectorHealth } from "./ConnectorHealth.tsx";
import {
  CANCEL_HINT_DURATION_MS,
  DOUBLE_CTRL_C_WINDOW_MS,
  MIN_HEIGHT_THRESHOLD,
  NARROW_LAYOUT_COLUMN_THRESHOLD,
  RECONNECT_BACKOFF_MS,
} from "./constants.ts";
import { useIpc } from "./ipc-context.ts";
import { QueryInput } from "./QueryInput.tsx";
import { ResultStream, type ResultStreamEntry } from "./ResultStream.tsx";
import { SubTaskPane } from "./SubTaskPane.tsx";
import type { HitlRequest } from "./state.ts";
import { initialTuiState, tuiReducer } from "./state.ts";
import { WatcherPane } from "./WatcherPane.tsx";

interface Props {
  readonly historyPath: string;
  readonly onExit: () => void;
}

function formatHitlOutcome(approved: number, rejected: number): string {
  if (rejected === 0) {
    return "✓ approved all";
  }
  if (approved === 0) {
    return "✗ rejected all";
  }
  return `✓ approved ${String(approved)}, ✗ rejected ${String(rejected)}`;
}

function isStreamTokenPayload(p: unknown): p is { streamId: string; text: string } {
  if (typeof p !== "object" || p === null) {
    return false;
  }
  const v = p as Record<string, unknown>;
  return typeof v["streamId"] === "string" && typeof v["text"] === "string";
}

function isStreamDonePayload(p: unknown): p is { streamId: string } {
  if (typeof p !== "object" || p === null) {
    return false;
  }
  const v = p as Record<string, unknown>;
  return typeof v["streamId"] === "string";
}

function isStreamErrorPayload(p: unknown): p is { streamId: string; error: string } {
  if (typeof p !== "object" || p === null) {
    return false;
  }
  const v = p as Record<string, unknown>;
  return typeof v["streamId"] === "string" && typeof v["error"] === "string";
}

function isHitlBatchPayload(p: unknown): p is { batchId: string; requests: HitlRequest[] } {
  if (typeof p !== "object" || p === null) {
    return false;
  }
  const v = p as Record<string, unknown>;
  if (typeof v["batchId"] !== "string") {
    return false;
  }
  if (!Array.isArray(v["requests"])) {
    return false;
  }
  return v["requests"].every((r) => {
    if (typeof r !== "object" || r === null) {
      return false;
    }
    const rr = r as Record<string, unknown>;
    return typeof rr["actionId"] === "string" && typeof rr["action"] === "string";
  });
}

function formatHitlBanner(batch: NonNullable<ReturnType<typeof tuiReducer>["hitlBatch"]>): string {
  const req = batch.requests[batch.cursor];
  if (req === undefined) {
    return "";
  }
  const body = JSON.stringify(req.params, null, 2);
  const indented = body
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
  return (
    "──[ consent required ]──\n" +
    `Action: ${req.action}\n` +
    `${indented}\n` +
    `(${String(batch.cursor + 1)} of ${String(batch.requests.length)} pending)`
  );
}

export function App({ historyPath, onExit }: Props): React.JSX.Element {
  const { client, logger } = useIpc();
  const [state, dispatch] = React.useReducer(tuiReducer, initialTuiState);
  const [entries, setEntries] = React.useState<ResultStreamEntry[]>([]);
  const [clearKey, setClearKey] = React.useState(0);
  const { stdout } = useStdout();
  const [cols, setCols] = React.useState(stdout.columns ?? 120);
  const [rows, setRows] = React.useState(stdout.rows ?? 40);
  const [showCancelHint, setShowCancelHint] = React.useState(false);
  const lastCtrlCRef = React.useRef<number>(0);
  const reconnectAttemptRef = React.useRef(0);

  React.useEffect(() => {
    client.onNotification("engine.streamToken", (p) => {
      if (isStreamTokenPayload(p)) {
        dispatch({ type: "stream-token", streamId: p.streamId, text: p.text });
      }
    });
    client.onNotification("engine.streamDone", (p) => {
      if (isStreamDonePayload(p)) {
        dispatch({ type: "stream-done", streamId: p.streamId });
      }
    });
    client.onNotification("engine.streamError", (p) => {
      if (isStreamErrorPayload(p)) {
        dispatch({ type: "stream-error", streamId: p.streamId, error: p.error });
      }
    });
    client.onNotification("agent.hitlBatch", (p) => {
      if (isHitlBatchPayload(p)) {
        dispatch({ type: "hitl-requested", batchId: p.batchId, requests: p.requests });
      }
    });
  }, [client]);

  React.useEffect(() => {
    if (process.env["NIMBUS_BENCH"] === "1") {
      process.stderr.write("[tui] first-frame\n");
    }
  }, []);

  const prevModeRef = React.useRef(state.mode);
  React.useEffect(() => {
    const prev = prevModeRef.current;
    prevModeRef.current = state.mode;
    if (prev === "streaming" && state.mode === "idle") {
      if (state.liveBuffer !== "") {
        const text = state.liveBuffer;
        const isError = state.lastError !== null;
        setEntries((e) => [...e, isError ? { kind: "error", text } : { kind: "reply", text }]);
      } else if (state.lastError !== null) {
        setEntries((e) => [...e, { kind: "error", text: state.lastError as string }]);
      }
      dispatch({ type: "flush-live" });
    }
  }, [state.mode, state.liveBuffer, state.lastError]);

  React.useEffect(() => {
    const onResize = (): void => {
      setCols(stdout.columns ?? 120);
      setRows(stdout.rows ?? 40);
    };
    (stdout as { on: (e: string, cb: () => void) => void }).on("resize", onResize);
    return () => {
      (stdout as { off: (e: string, cb: () => void) => void }).off("resize", onResize);
    };
  }, [stdout]);

  React.useEffect(() => {
    if (rows === 0) {
      return;
    }
    if (rows < MIN_HEIGHT_THRESHOLD) {
      logger.info({ event: "tui.short-terminal-exit", rows }, "exiting for short terminal");
      onExit();
    }
  }, [rows, logger, onExit]);

  React.useEffect(() => {
    if (state.mode !== "disconnected") {
      reconnectAttemptRef.current = 0;
      return undefined;
    }
    let cancelled = false;
    const attempt = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      const delay =
        RECONNECT_BACKOFF_MS[
          Math.min(reconnectAttemptRef.current, RECONNECT_BACKOFF_MS.length - 1)
        ] ?? 30_000;
      await new Promise((r) => setTimeout(r, delay));
      if (cancelled) {
        return;
      }
      try {
        await client.connect();
        dispatch({ type: "reconnect" });
      } catch {
        reconnectAttemptRef.current += 1;
        void attempt();
      }
    };
    void attempt();
    return () => {
      cancelled = true;
    };
  }, [state.mode, client]);

  const sessionIdRef = React.useRef<string>(crypto.randomUUID());

  const handleSubmit = async (query: string): Promise<void> => {
    setEntries((e) => [...e, { kind: "query", text: query }]);
    setClearKey((k) => k + 1);
    try {
      const res = await client.call<{ streamId: string }>("engine.askStream", {
        input: query,
        sessionId: sessionIdRef.current,
      });
      dispatch({ type: "submit", streamId: res.streamId, query });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.debug({ event: "tui.submit.error", err: msg }, "submit failed");
      dispatch({ type: "disconnect" });
    }
  };

  const handleHitlKey = (key: string): void => {
    if (state.hitlBatch === null) {
      return;
    }
    if (key === "a" || key === "r") {
      dispatch({ type: "hitl-advance", approved: key === "a" });
    } else if (key === "d") {
      // formatHitlBanner already renders the full payload JSON-pretty
      // without truncation, so 'd' is effectively a no-op in v0.1.0.
    } else if (key === "q") {
      void client
        .call("consent.respond", {
          batchId: state.hitlBatch.batchId,
          decisions: state.hitlBatch.requests.map((r) => ({
            actionId: r.actionId,
            approved: false,
          })),
        })
        .catch(() => undefined);
      onExit();
    }
  };

  React.useEffect(() => {
    if (state.hitlBatch === null) {
      return;
    }
    const { batchId, requests, cursor, decisions } = state.hitlBatch;
    if (cursor >= requests.length) {
      const approved = decisions.filter((d) => d.approved).length;
      const rejected = decisions.length - approved;
      const outcome = formatHitlOutcome(approved, rejected);
      setEntries((e) => [...e, { kind: "hitl-outcome", text: outcome }]);
      void client.call("consent.respond", { batchId, decisions }).catch((err) => {
        logger.debug({ event: "tui.consent.error", err: String(err) }, "consent failed");
      });
      dispatch({ type: "hitl-resolve" });
    }
  }, [state.hitlBatch, client, logger]);

  const handleCancelKey = (): void => {
    const now = Date.now();
    if (now - lastCtrlCRef.current < DOUBLE_CTRL_C_WINDOW_MS) {
      logger.debug({ event: "tui.cancel.exit" }, "double Ctrl+C — exiting");
      onExit();
      return;
    }
    lastCtrlCRef.current = now;
    if (state.mode === "streaming") {
      logger.debug(
        { event: "tui.cancel.local", streamId: state.activeStreamId },
        "local-only cancel (engine.cancelStream not implemented — LLM may continue)",
      );
      dispatch({ type: "cancel" });
      setEntries((e) => [
        ...e,
        {
          kind: "error",
          text: "(canceled by user — LLM may continue in the background)",
        },
      ]);
    }
    setShowCancelHint(true);
    setTimeout(() => {
      setShowCancelHint(false);
    }, CANCEL_HINT_DURATION_MS);
  };

  const hitlBanner = state.hitlBatch === null ? null : formatHitlBanner(state.hitlBatch);

  const narrow = cols < NARROW_LAYOUT_COLUMN_THRESHOLD;
  const disconnected = state.mode === "disconnected";

  return (
    <Box flexDirection="column">
      {disconnected ? (
        <Text color="yellow">⚠ Gateway disconnected — reconnecting… (press Ctrl+C to exit)</Text>
      ) : null}
      <QueryInput
        mode={state.mode}
        historyPath={historyPath}
        onSubmit={(q) => {
          void handleSubmit(q);
        }}
        onHitlKey={handleHitlKey}
        onCancelKey={handleCancelKey}
        showCancelHint={showCancelHint}
      />
      {narrow ? (
        <Box flexDirection="column">
          <ResultStream entries={entries} liveBuffer={state.liveBuffer} hitlBanner={hitlBanner} />
          <Box>
            <ConnectorHealth mode={state.mode} />
            <WatcherPane mode={state.mode} />
            <SubTaskPane clearKey={clearKey} />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="row">
          {/*
            BUG-004: cap the left pane width so the right pane sits adjacent
            instead of floating at the far edge on wide modern terminals
            (250-col Windows Terminal was the trigger). 32 = right-pane
            width 30 + 2 cols of slack.
          */}
          <Box flexDirection="column" width={Math.min(Math.max(cols - 32, 40), 120)}>
            <ResultStream entries={entries} liveBuffer={state.liveBuffer} hitlBanner={hitlBanner} />
          </Box>
          <Box
            flexDirection="column"
            width={30}
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
          >
            <ConnectorHealth mode={state.mode} />
            <WatcherPane mode={state.mode} />
            <SubTaskPane clearKey={clearKey} />
          </Box>
        </Box>
      )}
      <Text dimColor>Ctrl+C twice to exit</Text>
    </Box>
  );
}
