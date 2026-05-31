import { getCurrentWindow } from "@tauri-apps/api/window";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { createIpcClient } from "../ipc/client";
import { useNimbusStore } from "../store";

interface StreamTokenParams {
  streamId: string;
  text: string;
  meta?: { modelUsed?: string; isLocal?: boolean };
}
interface StreamDoneParams {
  streamId: string;
  model?: string;
  meta?: { modelUsed?: string; isLocal?: boolean };
}

export function QuickQuery() {
  const [prompt, setPrompt] = useState("");
  const streamId = useNimbusStore((s) => s.streamId);
  const tokens = useNimbusStore((s) => s.tokens);
  const modelLabel = useNimbusStore((s) => s.modelLabel);
  const doneAt = useNimbusStore((s) => s.doneAt);
  const startStream = useNimbusStore((s) => s.startStream);
  const appendToken = useNimbusStore((s) => s.appendToken);
  const markDone = useNimbusStore((s) => s.markDone);

  const unsubRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      if (e.key === "Escape") await getCurrentWindow().close();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!doneAt) return;
    const t = setTimeout(async () => {
      await getCurrentWindow().close();
    }, 2000);
    return () => clearTimeout(t);
  }, [doneAt]);

  useEffect(
    () => () => {
      unsubRef.current?.();
    },
    [],
  );

  const onSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    const client = createIpcClient();
    const res = await client.call<{ streamId: string }>("engine.askStream", {
      input: prompt,
    });
    startStream(res.streamId);
    unsubRef.current?.();
    unsubRef.current = await client.subscribe((n) => {
      if (n.method === "engine.streamToken") {
        const p = n.params as StreamTokenParams;
        if (p.streamId === res.streamId) appendToken(res.streamId, p.text);
      } else if (n.method === "engine.streamDone") {
        const p = n.params as StreamDoneParams;
        if (p.streamId === res.streamId) {
          const label =
            p.model ??
            (p.meta?.isLocal
              ? `local · ${p.meta.modelUsed ?? "unknown"}`
              : (p.meta?.modelUsed ?? "remote"));
          markDone(res.streamId, label);
        }
      }
    });
  };

  return (
    <div
      style={{
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--color-surface)",
      }}
    >
      <form onSubmit={onSubmit} style={{ borderBottom: "1px solid var(--color-border)" }}>
        <input
          autoFocus
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask Nimbus…"
          style={{
            width: "100%",
            padding: "16px 18px",
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--color-fg)",
            fontSize: 15,
            boxSizing: "border-box",
          }}
        />
      </form>
      <div
        style={{
          flex: 1,
          padding: "14px 18px",
          fontSize: 13,
          lineHeight: 1.55,
          color: "var(--color-fg)",
          opacity: 0.9,
        }}
      >
        {tokens.length > 0 ? (
          tokens.join("")
        ) : (
          <span style={{ opacity: 0.4 }}>Streaming response appears here…</span>
        )}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          padding: "8px 14px",
          fontSize: 11,
          borderTop: "1px solid var(--color-border)",
          opacity: 0.55,
          fontFamily: "monospace",
        }}
      >
        <span>⏎ submit · Esc close{streamId ? ` · ${streamId}` : ""}</span>
        <span>{modelLabel ?? "local"}</span>
      </div>
    </div>
  );
}
