import DOMPurify from "dompurify";
import { marked } from "marked";

export function renderMarkdown(src: string): string {
  if (src.length === 0) return "";
  const raw = marked.parse(src, {
    async: false,
    breaks: true,
    gfm: true,
  });
  return DOMPurify.sanitize(raw);
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replaceAll(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export type TurnRole = "user" | "assistant";

export interface TurnRenderInput {
  role: TurnRole;
  text: string;
  timestamp?: number;
}

export function renderTurn(turn: TurnRenderInput): string {
  const stamp =
    turn.timestamp !== undefined && turn.timestamp > 0
      ? ` <time datetime="${escapeHtml(new Date(turn.timestamp).toISOString())}">${escapeHtml(formatTimestamp(turn.timestamp))}</time>`
      : "";
  if (turn.role === "user") {
    const inner = `<pre class="user-text">${escapeHtml(turn.text)}</pre>`;
    return `<article class="turn turn-user"><header class="turn-header">You${stamp}</header>${inner}</article>`;
  }
  const inner = renderMarkdown(turn.text);
  return `<article class="turn turn-assistant"><header class="turn-header">Nimbus${stamp}</header><div class="markdown">${inner}</div></article>`;
}

export interface HitlCardInput {
  requestId: string;
  prompt: string;
  details?: unknown;
}

export function renderHitlCard(req: HitlCardInput): string {
  const detailsJson =
    req.details === undefined || req.details === null
      ? ""
      : `<pre class="hitl-details">${escapeHtml(JSON.stringify(req.details, null, 2))}</pre>`;
  const id = escapeHtml(req.requestId);
  return `<section class="hitl-card" data-request-id="${id}" role="alert" aria-live="polite">
<header class="hitl-header">Consent required</header>
<p class="hitl-prompt">${escapeHtml(req.prompt)}</p>
${detailsJson}
<div class="hitl-actions">
<button class="hitl-btn hitl-approve" data-request-id="${id}" data-decision="approve">Approve</button>
<button class="hitl-btn hitl-reject" data-request-id="${id}" data-decision="reject">Reject</button>
</div>
</section>`;
}

export interface SubTaskRowInput {
  subTaskId: string;
  status: string;
  progress?: number;
}

export function renderSubTaskRow(row: SubTaskRowInput): string {
  const id = escapeHtml(row.subTaskId);
  const status = escapeHtml(row.status);
  let pct = "";
  if (typeof row.progress === "number") {
    const percent = `${Math.round(row.progress * 100)}%`;
    pct = ` <span class="subtask-pct">${escapeHtml(percent)}</span>`;
  }
  return `<li class="subtask-row" data-subtask-id="${id}"><span class="subtask-id">${id}</span><span class="subtask-status">${status}</span>${pct}</li>`;
}

export interface EmptyStateInput {
  sub: "no-transcript" | "disconnected" | "permission-denied";
  socketPath?: string;
}

export function renderEmptyState(inp: EmptyStateInput): string {
  if (inp.sub === "no-transcript") {
    return `<div class="empty-state empty-no-transcript">
<h3>Nothing yet.</h3>
<p>Type a question below and press <kbd>Enter</kbd> to ask Nimbus.</p>
</div>`;
  }
  if (inp.sub === "disconnected") {
    const path =
      inp.socketPath !== undefined && inp.socketPath.length > 0
        ? `<p class="muted">Socket: <code>${escapeHtml(inp.socketPath)}</code></p>`
        : "";
    return `<div class="empty-state empty-disconnected">
<h3>Gateway not connected.</h3>
<p>Start the Nimbus Gateway, then click <button class="link-btn" data-action="startGateway">Start Gateway</button> or wait for auto-reconnect.</p>
${path}
</div>`;
  }
  const path =
    inp.socketPath !== undefined && inp.socketPath.length > 0
      ? `<p class="muted">Socket: <code>${escapeHtml(inp.socketPath)}</code></p>`
      : "";
  return `<div class="empty-state empty-permission-denied">
<h3>Permission denied accessing the Gateway socket.</h3>
<p>Check the socket file permissions, or override <code>nimbus.socketPath</code> in settings.</p>
${path}
<p><button class="link-btn" data-action="openLogs">Open Nimbus logs</button></p>
</div>`;
}

function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
