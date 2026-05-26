/**
 * @vitest-environment jsdom
 *
 * Unit tests for the render helpers in src/chat/webview/render.ts. The
 * helpers themselves operate on strings, but `renderMarkdown` runs DOMPurify
 * over the marked output for in-depth defence against agent-supplied HTML —
 * DOMPurify v3 requires a `window`, so this file runs under jsdom rather
 * than Node. Other test files in this package stay in the default Node env.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

// Per-process temp socket path so the test never references a literal under
// /tmp (Sonar S5443 — publicly-writable directory hotspot) and never collides
// across parallel test runs on the same host.
const TEST_SOCKET_PATH = join(tmpdir(), `nimbus-render-${process.pid}.sock`);

import {
  escapeHtml,
  renderEmptyState,
  renderHitlCard,
  renderMarkdown,
  renderSubTaskRow,
  renderTurn,
} from "../../src/chat/webview/render.js";

describe("escapeHtml", () => {
  test("escapes the five HTML metacharacters", () => {
    expect(escapeHtml(`<a href="x">'tag&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;tag&amp;&#39;&lt;/a&gt;",
    );
  });
  test("returns the string unchanged when nothing needs escaping", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});

describe("renderMarkdown", () => {
  test("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });
  test("renders fenced code blocks as <pre><code>", () => {
    const html = renderMarkdown("```js\nconst x = 1;\n```");
    expect(html).toMatch(/<pre>/);
    expect(html).toMatch(/<code class="language-js">/);
    expect(html).toContain("const x = 1;");
  });
  test("renders inline code as <code>", () => {
    const html = renderMarkdown("hello `world`");
    expect(html).toMatch(/<code>world<\/code>/);
  });
  test("renders newlines as <br> with breaks: true", () => {
    const html = renderMarkdown("line one\nline two");
    expect(html).toMatch(/<br>/);
  });
});

describe("renderTurn", () => {
  test("user turn escapes content and uses a <pre> block", () => {
    const html = renderTurn({ role: "user", text: "<script>alert(1)</script>" });
    expect(html).toContain('<article class="turn turn-user">');
    expect(html).toContain('<pre class="user-text">');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // No raw script tag anywhere — XSS would be unforgivable here.
    // Case-insensitive: HTML tag names match ASCII-case-insensitively, so a
    // payload of `<SCRIPT>` is just as exploitable as `<script>`.
    expect(html).not.toMatch(/<script[\s>]/i);
    expect(html).not.toMatch(/<\/script>/i);
  });
  test("assistant turn renders markdown", () => {
    const html = renderTurn({ role: "assistant", text: "**bold**" });
    expect(html).toContain('<article class="turn turn-assistant">');
    expect(html).toContain("<strong>bold</strong>");
  });
  test("includes a <time> stamp when timestamp is provided", () => {
    const html = renderTurn({ role: "user", text: "hi", timestamp: 1700000000000 });
    expect(html).toMatch(/<time datetime=/);
  });
});

describe("renderHitlCard", () => {
  test("includes prompt + Approve/Reject buttons + escaped requestId", () => {
    const html = renderHitlCard({
      requestId: 'req"1',
      prompt: "Delete <i>foo.txt</i>?",
    });
    expect(html).toContain('data-request-id="req&quot;1"');
    expect(html).toContain("Delete &lt;i&gt;foo.txt&lt;/i&gt;?");
    expect(html).toContain('data-decision="approve"');
    expect(html).toContain('data-decision="reject"');
  });
  test("renders details JSON when provided, omits the block when undefined", () => {
    const withDetails = renderHitlCard({
      requestId: "r",
      prompt: "p",
      details: { file: "/etc/passwd" },
    });
    expect(withDetails).toContain('class="hitl-details"');
    expect(withDetails).toContain("/etc/passwd");
    const withoutDetails = renderHitlCard({ requestId: "r", prompt: "p" });
    expect(withoutDetails).not.toContain("hitl-details");
  });
});

describe("renderSubTaskRow", () => {
  test("renders id + status, percentage when progress provided", () => {
    const row = renderSubTaskRow({ subTaskId: "t1", status: "running", progress: 0.42 });
    expect(row).toContain('data-subtask-id="t1"');
    expect(row).toContain(">running<");
    expect(row).toContain("42%");
  });
  test("omits percentage block when progress not provided", () => {
    const row = renderSubTaskRow({ subTaskId: "t1", status: "queued" });
    expect(row).not.toContain("subtask-pct");
  });
});

describe("renderEmptyState", () => {
  test("no-transcript variant", () => {
    const html = renderEmptyState({ sub: "no-transcript" });
    expect(html).toContain("empty-no-transcript");
    expect(html).toContain("Nothing yet");
  });
  test("disconnected variant includes startGateway action and socketPath", () => {
    const html = renderEmptyState({
      sub: "disconnected",
      socketPath: TEST_SOCKET_PATH,
    });
    expect(html).toContain("empty-disconnected");
    expect(html).toContain('data-action="startGateway"');
    expect(html).toContain(TEST_SOCKET_PATH);
  });
  test("permission-denied variant includes openLogs action", () => {
    const html = renderEmptyState({ sub: "permission-denied" });
    expect(html).toContain("empty-permission-denied");
    expect(html).toContain('data-action="openLogs"');
  });
});
