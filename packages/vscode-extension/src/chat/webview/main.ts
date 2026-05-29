import type { ExtensionToWebview, WebviewToExtension } from "../chat-protocol.js";
import {
  type EmptyStateInput,
  renderEmptyState,
  renderHitlCard,
  renderSubTaskRow,
  renderTurn,
} from "./render.js";

interface VsCodeApi {
  postMessage(msg: WebviewToExtension): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface Refs {
  transcript: HTMLElement;
  subTaskList: HTMLElement;
  emptyMount: HTMLElement;
  hitlMount: HTMLElement;
  form: HTMLFormElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  status: HTMLElement;
}

function refs(): Refs {
  return {
    transcript: must("#transcript"),
    subTaskList: must("#subtask-list"),
    emptyMount: must("#empty-mount"),
    hitlMount: must("#hitl-mount"),
    form: must<HTMLFormElement>("#input-form"),
    input: must<HTMLTextAreaElement>("#input-text"),
    send: must<HTMLButtonElement>("#input-send"),
    stop: must<HTMLButtonElement>("#input-stop"),
    status: must("#status"),
  };
}

function must<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (el === null) throw new Error(`webview shell missing required selector: ${sel}`);
  return el;
}

interface State {
  streamingText: string;
  streaming: boolean;
}

const state: State = {
  streamingText: "",
  streaming: false,
};

function applyMessage(r: Refs, msg: ExtensionToWebview): void {
  switch (msg.type) {
    case "reset":
      r.transcript.replaceChildren();
      r.subTaskList.replaceChildren();
      r.hitlMount.replaceChildren();
      r.emptyMount.replaceChildren();
      r.emptyMount.insertAdjacentHTML("beforeend", renderEmptyState({ sub: "no-transcript" }));
      state.streamingText = "";
      setStreaming(r, false);
      return;
    case "hydrate":
      r.transcript.replaceChildren();
      r.emptyMount.replaceChildren();
      for (const t of msg.turns) {
        r.transcript.insertAdjacentHTML("beforeend", renderTurn(t));
      }
      scrollToBottom(r);
      return;
    case "userMessage":
      r.emptyMount.replaceChildren();
      r.transcript.insertAdjacentHTML(
        "beforeend",
        renderTurn({ role: "user", text: msg.text, timestamp: Date.now() }),
      );
      state.streamingText = "";
      r.transcript.insertAdjacentHTML(
        "beforeend",
        '<article class="turn turn-assistant turn-streaming"><header class="turn-header">Nimbus</header><div class="markdown" data-streaming="1"></div></article>',
      );
      setStreaming(r, true);
      scrollToBottom(r);
      return;
    case "token":
      state.streamingText += msg.text;
      {
        const target = r.transcript.querySelector('div.markdown[data-streaming="1"]');
        if (target !== null) {
          target.innerHTML = renderTurnBodyHtml(state.streamingText);
        }
      }
      scrollToBottom(r);
      return;
    case "subTask": {
      const row = renderSubTaskRow(msg);
      const existing = r.subTaskList.querySelector(
        `li.subtask-row[data-subtask-id="${cssEscape(msg.subTaskId)}"]`,
      );
      if (existing === null) {
        r.subTaskList.insertAdjacentHTML("beforeend", row);
      } else {
        existing.outerHTML = row;
      }
      return;
    }
    case "hitlInline":
      r.hitlMount.replaceChildren();
      r.hitlMount.insertAdjacentHTML(
        "beforeend",
        renderHitlCard({
          requestId: msg.requestId,
          prompt: msg.prompt,
          ...(msg.details === undefined ? {} : { details: msg.details }),
        }),
      );
      scrollToBottom(r);
      return;
    case "done":
      finalizeStreamingTurn(r);
      setStreaming(r, false);
      return;
    case "error":
      finalizeStreamingTurn(r);
      {
        const article = document.createElement("article");
        article.className = "turn turn-error";
        article.setAttribute("role", "alert");
        article.textContent = `Error: ${msg.message}`;
        r.transcript.append(article);
      }
      setStreaming(r, false);
      return;
    case "emptyState":
      r.transcript.replaceChildren();
      r.emptyMount.replaceChildren();
      r.emptyMount.insertAdjacentHTML(
        "beforeend",
        renderEmptyState({
          sub: msg.sub,
          ...(msg.socketPath === undefined ? {} : { socketPath: msg.socketPath }),
        } as EmptyStateInput),
      );
      return;
    case "themeChange":
      return;
  }
}

function finalizeStreamingTurn(r: Refs): void {
  const target = r.transcript.querySelector<HTMLElement>('div.markdown[data-streaming="1"]');
  if (target !== null) {
    delete target.dataset["streaming"];
    target.innerHTML = renderTurnBodyHtml(state.streamingText);
    target.parentElement?.classList.remove("turn-streaming");
  }
  state.streamingText = "";
  r.subTaskList.replaceChildren();
  r.hitlMount.replaceChildren();
  scrollToBottom(r);
}

function renderTurnBodyHtml(text: string): string {
  const full = renderTurn({ role: "assistant", text });
  const start = full.indexOf('<div class="markdown">');
  const end = full.lastIndexOf("</div>");
  if (start < 0 || end < 0) return "";
  return full.slice(start + '<div class="markdown">'.length, end);
}

function setStreaming(r: Refs, streaming: boolean): void {
  state.streaming = streaming;
  r.send.disabled = streaming;
  r.stop.disabled = !streaming;
  r.status.textContent = streaming ? "Streaming…" : "";
}

function scrollToBottom(r: Refs): void {
  r.transcript.scrollTop = r.transcript.scrollHeight;
}

function cssEscape(s: string): string {
  return s.replaceAll(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function bootstrap(): void {
  const r = refs();

  r.emptyMount.insertAdjacentHTML("beforeend", renderEmptyState({ sub: "no-transcript" }));
  setStreaming(r, false);

  r.form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (state.streaming) return;
    const text = r.input.value.trim();
    if (text.length === 0) return;
    vscode.postMessage({ type: "submitAsk", text });
    r.input.value = "";
  });

  r.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      r.form.dispatchEvent(new Event("submit", { cancelable: true }));
    }
  });

  r.stop.addEventListener("click", () => {
    if (!state.streaming) return;
    vscode.postMessage({ type: "stopStream" });
  });

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (target === null) return;
    if (handleHitlButtonClick(target)) return;
    handleEmptyStateActionClick(target);
  });

  window.addEventListener("message", (ev) => {
    // Origin verification (CodeQL js/missing-origin-check, Sonar S2819):
    // VS Code webviews receive messages from the extension host frame that
    // embeds this iframe. The host sets `ev.source === window.parent` and
    // uses a `vscode-webview://` origin scheme. Both guards must stay inline
    // — extracting them into a helper hides the check from static analysis,
    // which is why commit 985ab9cc reverted that indirection in May 2026.
    if (ev.source !== window.parent) return;
    if (ev.origin === "" || !ev.origin.startsWith("vscode-webview")) return;
    const data = ev.data as ExtensionToWebview;
    if (data === null || typeof data !== "object" || typeof data.type !== "string") return;
    applyMessage(r, data);
  });

  vscode.postMessage({ type: "ready" });
}

function mkStub(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "hitl-stub";
  el.textContent = text;
  return el;
}

function handleHitlButtonClick(target: HTMLElement): boolean {
  const decisionBtn = target.closest<HTMLButtonElement>("button.hitl-btn[data-decision]");
  if (decisionBtn === null) return false;
  const requestId = decisionBtn.dataset["requestId"];
  const decision = decisionBtn.dataset["decision"];
  if (typeof requestId !== "string") return true;
  if (decision !== "approve" && decision !== "reject") return true;
  vscode.postMessage({ type: "hitlResponse", requestId, decision });
  const card = decisionBtn.closest<HTMLElement>(".hitl-card");
  if (card !== null) {
    const verb = decision === "approve" ? "approved" : "rejected";
    card.replaceWith(mkStub(`Decision recorded: ${verb}`));
  }
  return true;
}

function handleEmptyStateActionClick(target: HTMLElement): void {
  const btn = target.closest<HTMLButtonElement>("button[data-action]");
  if (btn === null) return;
  const action = btn.dataset["action"];
  if (action === "openLogs") {
    vscode.postMessage({ type: "openLogs" });
  } else if (action === "startGateway") {
    vscode.postMessage({ type: "startGateway" });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}
