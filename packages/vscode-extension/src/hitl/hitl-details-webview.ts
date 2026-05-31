import type { HitlRequest } from "@nimbus-dev/client";

import type { HitlDecision } from "./hitl-router.js";

export type HitlDetailsRenderInput = {
  request: HitlRequest;
  cspSource: string;
};

export function renderDetailsHtml(inp: HitlDetailsRenderInput): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${inp.cspSource}; script-src ${inp.cspSource};`;
  const detailsJson = JSON.stringify(inp.request.details ?? null, null, 2);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Nimbus Consent Details</title>
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-editor-foreground);
       background: var(--vscode-editor-background); padding: 1em; }
pre { background: var(--vscode-textBlockQuote-background);
      border-left: 3px solid var(--vscode-textBlockQuote-border); padding: 1em; overflow: auto; }
.actions { margin-top: 1em; display: flex; gap: 0.5em; }
button { padding: 0.5em 1em; cursor: pointer;
         background: var(--vscode-button-background); color: var(--vscode-button-foreground);
         border: none; }
button.reject { background: var(--vscode-errorForeground); }
</style>
</head>
<body>
<h2>${escapeHtml(inp.request.prompt)}</h2>
<pre>${escapeHtml(detailsJson)}</pre>
<div class="actions">
  <button id="approve">Approve</button>
  <button id="reject" class="reject">Reject</button>
</div>
<script>
const vscode = acquireVsCodeApi();
document.getElementById("approve").addEventListener("click", () =>
  vscode.postMessage({ type: "hitlDecision", decision: "approve", requestId: ${JSON.stringify(inp.request.requestId)} }));
document.getElementById("reject").addEventListener("click", () =>
  vscode.postMessage({ type: "hitlDecision", decision: "reject", requestId: ${JSON.stringify(inp.request.requestId)} }));
</script>
</body>
</html>`;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replaceAll(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export type DetailsDecisionMessage = {
  type: "hitlDecision";
  requestId: string;
  decision: HitlDecision;
};
