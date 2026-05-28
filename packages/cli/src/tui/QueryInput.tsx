import { Box, Text, useStdin } from "ink";
import React from "react";

import { appendQuery, readHistory } from "./query-history.ts";
import type { TuiMode } from "./state.ts";

interface Props {
  readonly mode: TuiMode;
  readonly historyPath: string;
  readonly onSubmit: (query: string) => void;
  readonly onHitlKey: (key: string) => void;
  readonly onCancelKey: () => void;
  readonly showCancelHint: boolean;
}

interface ProcessContext {
  readonly bufRef: React.MutableRefObject<string>;
  readonly histCursorRef: React.MutableRefObject<number | null>;
  readonly historyRef: React.MutableRefObject<string[]>;
  readonly historyPathRef: React.MutableRefObject<string>;
  readonly inHitlRef: React.MutableRefObject<boolean>;
  readonly disabledRef: React.MutableRefObject<boolean>;
  readonly onSubmit: (q: string) => void;
  readonly onCancel: () => void;
  readonly onHitlKey: (k: string) => void;
  readonly forceRender: () => void;
}

const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7e;

function isEditable(ctx: ProcessContext): boolean {
  return !ctx.inHitlRef.current && !ctx.disabledRef.current;
}

function handleUp(ctx: ProcessContext): void {
  if (!isEditable(ctx)) {
    return;
  }
  const h = ctx.historyRef.current;
  if (h.length === 0) {
    return;
  }
  const cur = ctx.histCursorRef.current;
  const next = cur === null ? h.length - 1 : Math.max(0, cur - 1);
  ctx.histCursorRef.current = next;
  ctx.bufRef.current = h[next] ?? "";
  ctx.forceRender();
}

function handleDown(ctx: ProcessContext): void {
  if (!isEditable(ctx)) {
    return;
  }
  const cur = ctx.histCursorRef.current;
  if (cur === null) {
    return;
  }
  const h = ctx.historyRef.current;
  const next = cur + 1;
  if (next >= h.length) {
    ctx.histCursorRef.current = null;
    ctx.bufRef.current = "";
  } else {
    ctx.histCursorRef.current = next;
    ctx.bufRef.current = h[next] ?? "";
  }
  ctx.forceRender();
}

function skipCsi(chunk: string, start: number): number {
  let i = start;
  while (i < chunk.length) {
    const code = chunk.codePointAt(i) ?? 0;
    i++;
    if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) {
      return i;
    }
  }
  return i;
}

function handleEscape(chunk: string, i: number, ctx: ProcessContext): number {
  const three = chunk.slice(i, i + 3);
  if (three === "\x1B[A") {
    handleUp(ctx);
    return i + 3;
  }
  if (three === "\x1B[B") {
    handleDown(ctx);
    return i + 3;
  }
  return skipCsi(chunk, i + 1);
}

function handleSubmit(ctx: ProcessContext): void {
  if (!isEditable(ctx)) {
    return;
  }
  const trimmed = ctx.bufRef.current.trim();
  if (trimmed === "") {
    return;
  }
  void appendQuery(ctx.historyPathRef.current, trimmed)
    .then(async () => {
      ctx.historyRef.current = await readHistory(ctx.historyPathRef.current);
    })
    .catch(() => {
      // History persistence is best-effort; swallow filesystem errors so
      // the rejection does not become an unhandled promise rejection
      // (e.g. when a test's afterEach removes the temp dir before the
      // background write completes).
    });
  ctx.onSubmit(trimmed);
  ctx.bufRef.current = "";
  ctx.histCursorRef.current = null;
  ctx.forceRender();
}

function handleBackspace(ctx: ProcessContext): void {
  if (!isEditable(ctx)) {
    return;
  }
  ctx.bufRef.current = ctx.bufRef.current.slice(0, -1);
  ctx.forceRender();
}

function isHitlKey(ch: string): boolean {
  return ch === "a" || ch === "r" || ch === "d" || ch === "q";
}

function handlePrintable(ch: string, ctx: ProcessContext): void {
  if (ctx.inHitlRef.current) {
    if (isHitlKey(ch)) {
      ctx.onHitlKey(ch);
    }
    return;
  }
  if (ctx.disabledRef.current) {
    return;
  }
  ctx.bufRef.current += ch;
  ctx.forceRender();
}

function processChunk(chunk: string, ctx: ProcessContext): void {
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b") {
      i = handleEscape(chunk, i, ctx);
      continue;
    }

    const ch = chunk[i] ?? "";
    i++;

    if (ch === "\x03") {
      ctx.onCancel();
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      handleSubmit(ctx);
      continue;
    }
    if (ch === "\x7f" || ch === "\x08") {
      handleBackspace(ctx);
      continue;
    }
    if ((ch.codePointAt(0) ?? 0) < 32) {
      continue;
    }
    handlePrintable(ch, ctx);
  }
}

export function QueryInput(props: Props): React.JSX.Element {
  const { mode, historyPath, onSubmit, onHitlKey, onCancelKey, showCancelHint } = props;

  const bufRef = React.useRef("");
  const histCursorRef = React.useRef<number | null>(null);
  const historyRef = React.useRef<string[]>([]);
  const [, forceRender] = React.useReducer((n: number) => n + 1, 0);

  const inHitlRef = React.useRef(mode === "awaiting-hitl");
  const disabledRef = React.useRef(mode === "streaming" || mode === "disconnected");
  const historyPathRef = React.useRef(historyPath);
  const onSubmitRef = React.useRef(onSubmit);
  const onHitlKeyRef = React.useRef(onHitlKey);
  const onCancelKeyRef = React.useRef(onCancelKey);

  inHitlRef.current = mode === "awaiting-hitl";
  disabledRef.current = mode === "streaming" || mode === "disconnected";
  historyPathRef.current = historyPath;
  onSubmitRef.current = onSubmit;
  onHitlKeyRef.current = onHitlKey;
  onCancelKeyRef.current = onCancelKey;

  React.useEffect(() => {
    void readHistory(historyPath).then((entries) => {
      historyRef.current = entries;
    });
  }, [historyPath]);

  const { stdin } = useStdin();

  React.useLayoutEffect(() => {
    const handler = (data: unknown): void => {
      const ctx: ProcessContext = {
        bufRef,
        histCursorRef,
        historyRef,
        historyPathRef,
        inHitlRef,
        disabledRef,
        onSubmit: onSubmitRef.current,
        onCancel: onCancelKeyRef.current,
        onHitlKey: onHitlKeyRef.current,
        forceRender,
      };
      processChunk(String(data), ctx);
    };
    stdin?.on("data", handler);
    return () => {
      stdin?.off("data", handler);
    };
  }, [stdin]);

  const inHitl = mode === "awaiting-hitl";
  const disabled = mode === "streaming" || mode === "disconnected";
  const promptText = inHitl ? "nimbus[hitl]>" : "nimbus>";
  const displayValue = bufRef.current;

  return (
    <Box flexDirection="column">
      <Box>
        {disabled ? <Text color="gray">{promptText} </Text> : <Text>{promptText} </Text>}
        {inHitl ? (
          <Text dimColor>[a]pprove [r]eject [d]etails [q]uit</Text>
        ) : (
          <Text dimColor={disabled}>{displayValue}</Text>
        )}
      </Box>
      {showCancelHint ? <Text color="yellow">^C Press again within 2s to exit</Text> : null}
    </Box>
  );
}
