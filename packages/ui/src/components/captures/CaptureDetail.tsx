import type { ReactNode } from "react";
import { asCaptureDetail } from "../../hooks/useCaptures";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import type { CaptureDetail as Detail } from "../../ipc/types";
import { showInvisible } from "../../lib/escape-invisible";
import { terminalCommands } from "./format";

function when(ms: number | null): string {
  return ms === null ? "—" : new Date(ms).toLocaleString();
}

/**
 * One capture, read-only. Every agent-derived string (title, client label, payload, result URL,
 * error code) goes through showInvisible; the result URL is TEXT, never a link, because the agent
 * influences it. The owner's verbs are printed as commands to type, not offered as controls.
 */
export function CaptureDetail({ id }: { readonly id: string }): ReactNode {
  const { data, error } = useIpcQuery<unknown>("captures.get", 60_000, { id });
  const c = asCaptureDetail(data);
  if (error !== null && c === null) {
    return (
      <p role="alert" className="text-sm">
        {`Could not load capture ${id}: ${error}. From a terminal: nimbus captures show ${id}`}
      </p>
    );
  }
  if (c?.id !== id) return <p className="text-sm text-[var(--color-fg-muted)]">Loading…</p>;
  return (
    <article aria-label="Capture" className="space-y-3 text-sm">
      <h2 className="font-medium">{c.title === "" ? c.id : showInvisible(c.title)}</h2>
      <Fields c={c} />
      <Commands c={c} />
      <section className="space-y-1">
        <h3 className="text-xs font-medium">Payload (agent-authored text)</h3>
        {c.payload === null ? (
          <p className="text-xs text-[var(--color-fg-muted)]">payload cleared</p>
        ) : (
          <pre
            data-testid="capture-payload"
            className="whitespace-pre-wrap break-words font-mono text-xs border border-[var(--color-border)] rounded-md p-3"
          >
            {showInvisible(JSON.stringify(c.payload, null, 2))}
          </pre>
        )}
      </section>
    </article>
  );
}

function Fields({ c }: { readonly c: Detail }): ReactNode {
  const rows: [string, string][] = [
    ["id", c.id],
    ["kind", c.kind],
    ["state", c.state],
    ["client", c.clientLabel === null ? "—" : showInvisible(c.clientLabel)],
    ["created", when(c.createdAt)],
    ["decided", when(c.decidedAt)],
    ["expires", when(c.expiresAt)],
  ];
  if (c.nativeStatus !== null) rows.push(["native row", c.nativeStatus]);
  if (c.outcomeRef !== null) rows.push(["result URL", showInvisible(c.outcomeRef)]);
  if (c.errorCode !== null) rows.push(["error", showInvisible(c.errorCode)]);
  rows.push(["payload bytes", String(c.payloadBytes)]);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-[var(--color-fg-muted)]">{k}</dt>
          <dd className="break-all">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Commands({ c }: { readonly c: Detail }): ReactNode {
  const cmds = terminalCommands(c);
  return (
    <section className="space-y-1">
      <p className="text-xs text-[var(--color-fg-muted)]">
        Accepting, rejecting, revoking and purging happen in a terminal.
      </p>
      {cmds.length > 0 && (
        <pre data-testid="capture-commands" className="font-mono text-xs select-all">
          {cmds.join("\n")}
        </pre>
      )}
    </section>
  );
}
