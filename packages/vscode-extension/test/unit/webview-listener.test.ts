import { beforeAll, beforeEach, describe, expect, test } from "vitest";

const CHAT_SHELL = `
<main id="root">
  <section id="empty-mount"></section>
  <section id="transcript"></section>
  <section id="hitl-mount"></section>
  <footer id="footer">
    <ul id="subtask-list"></ul>
    <span id="status"></span>
    <form id="input-form">
      <textarea id="input-text"></textarea>
      <button type="submit" id="input-send">Send</button>
      <button type="button" id="input-stop" disabled>Stop</button>
    </form>
  </footer>
</main>
`;

interface VsCodeApi {
  postMessage: (msg: unknown) => void;
  getState: () => unknown;
  setState: (s: unknown) => void;
}

function dispatch(origin: string, data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { origin, data }));
}

function transcriptHtml(): string {
  return document.querySelector("#transcript")?.innerHTML ?? "";
}

beforeAll(async () => {
  document.body.innerHTML = CHAT_SHELL;
  (globalThis as unknown as { acquireVsCodeApi: () => VsCodeApi }).acquireVsCodeApi = () => ({
    postMessage: () => undefined,
    getState: () => undefined,
    setState: () => undefined,
  });
  await import("../../src/chat/webview/main.js");
});

beforeEach(() => {
  const t = document.querySelector("#transcript");
  if (t !== null) t.innerHTML = "";
});

describe("webview message listener", () => {
  test("renders a userMessage payload from a vscode-webview origin", () => {
    dispatch("vscode-webview://abc", { type: "userMessage", text: "hi from extension" });
    expect(transcriptHtml()).toContain("hi from extension");
  });

  test("accepts empty origin (jsdom-style harness)", () => {
    dispatch("", { type: "userMessage", text: "from harness" });
    expect(transcriptHtml()).toContain("from harness");
  });

  test("drops messages from foreign cross-origin frames", () => {
    dispatch("https://evil.example", { type: "userMessage", text: "smuggled" });
    expect(transcriptHtml()).not.toContain("smuggled");
  });

  test("regression: source: null is accepted when origin is trusted", () => {
    const ev = new MessageEvent("message", {
      origin: "vscode-webview://xyz",
      data: { type: "userMessage", text: "no-source-payload" },
    });
    expect(ev.source).toBeNull();
    window.dispatchEvent(ev);
    expect(transcriptHtml()).toContain("no-source-payload");
  });

  test("ignores payloads that do not look like ExtensionToWebview", () => {
    dispatch("vscode-webview://abc", "not an object");
    dispatch("vscode-webview://abc", { noType: true });
    dispatch("vscode-webview://abc", null);
    expect(transcriptHtml()).toBe("");
  });
});
