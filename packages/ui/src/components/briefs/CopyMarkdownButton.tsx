import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { type ReactNode, useEffect, useRef, useState } from "react";

const COPIED_MS = 2_000;

/** Copies the markdown source. A failed clipboard write leaves the label alone and never throws. */
export function CopyMarkdownButton({ text }: { readonly text: string }): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const onCopy = async (): Promise<void> => {
    try {
      await writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <button
      type="button"
      className="text-sm px-2 py-1 border border-[var(--color-border)] rounded"
      onClick={() => {
        onCopy().catch(() => undefined);
      }}
    >
      {copied ? "Copied" : "Copy as markdown"}
    </button>
  );
}
