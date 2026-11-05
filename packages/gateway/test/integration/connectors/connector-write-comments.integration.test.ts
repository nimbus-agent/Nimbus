/**
 * Phase 9.7 B1, Task 6: the comment writes end to end through REAL connector processes against a
 * loopback fake upstream, for the connectors whose host is configurable (Jira, Confluence, GitLab,
 * GitHub). Slack, Teams, Discord, Linear and Notion hard-code their hosts and are proven in-process.
 *
 * The connectors, the `@mastra/mcp` client, the mesh dispatcher, the door-shaped executor (with its
 * before-state runner) and the index run in a CHILD (`test/fixtures/connector-write-probe.ts`);
 * this file runs the fake upstream and asserts on what reached it. No gateway subprocess, no Vault:
 * fake credentials go to the connectors through their env, and every home and temp directory
 * points at a throwaway one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { extensionProcessEnv } from "../../../src/extensions/spawn-env.ts";

const PROBE = join(import.meta.dir, "..", "..", "fixtures", "connector-write-probe.ts");
const MARKER = "CONNECTOR_WRITE_PROBE ";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly hasAuth: boolean;
}

const seen: Seen[] = [];

/** The fake upstream: one reply per route, every request recorded. */
const ROUTES: Readonly<Record<string, unknown>> = {
  "GET /rest/api/3/issue/NIM-1": {
    key: "NIM-1",
    fields: {
      summary: "Fix login",
      status: { name: "In Progress" },
      issuetype: { name: "Bug" },
      description: { type: "doc", content: [] },
    },
  },
  "POST /rest/api/3/issue/NIM-1/comment": { id: "10001" },
  "GET /wiki/rest/api/content/123": {
    id: "123",
    title: "Runbook",
    space: { key: "ENG" },
    version: { number: 4 },
    body: { storage: { value: "<p>body</p>" } },
  },
  "POST /wiki/rest/api/content/123/child/comment": { id: "9" },
  "GET /api/v4/projects/group%2Frepo/issues/7": { iid: 7, title: "Broken", state: "opened" },
  "POST /api/v4/projects/group%2Frepo/issues/7/notes": { id: 1 },
  "GET /api/v4/projects/group%2Frepo/merge_requests/9": {
    iid: 9,
    title: "Add cache",
    state: "opened",
    source_branch: "feat/cache",
    target_branch: "main",
  },
  "POST /api/v4/projects/group%2Frepo/merge_requests/9/notes": { id: 2 },
  "GET /repos/o/r/issues/42": { number: 42, title: "Login fails", state: "open" },
  "POST /repos/o/r/issues/42/comments": { id: 3 },
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const text = await req.text();
    let body: unknown = null;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    seen.push({
      method: req.method,
      path: url.pathname,
      body,
      // GitLab sends its PAT as PRIVATE-TOKEN; the others use Authorization.
      hasAuth:
        req.headers.get("authorization") !== null || req.headers.get("private-token") !== null,
    });
    const reply = ROUTES[`${req.method} ${url.pathname}`];
    return reply === undefined
      ? new Response("not found", { status: 404 })
      : Response.json(reply, { status: req.method === "POST" ? 201 : 200 });
  },
});
const base = `http://127.0.0.1:${String(server.port)}`;

const sandbox = mkdtempSync(join(tmpdir(), "nimbus-b1-writes-"));
const childEnv = extensionProcessEnv({
  ...Object.fromEntries(
    ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"].map((k) => [
      k,
      sandbox,
    ]),
  ),
  // Fake credentials only; the fake upstream accepts anything.
  JIRA_BASE_URL: base,
  JIRA_EMAIL: "probe@example.test",
  JIRA_API_TOKEN: "fake",
  CONFLUENCE_BASE_URL: base,
  CONFLUENCE_EMAIL: "probe@example.test",
  CONFLUENCE_API_TOKEN: "fake",
  GITLAB_API_BASE_URL: `${base}/api/v4`,
  GITLAB_PAT: "fake",
  GITHUB_API_BASE_URL: base,
  GITHUB_PAT: "fake",
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface ProbeOut {
  runs: Array<{ type: string; approved: boolean; status: string }>;
  consents: Array<{ type: string | undefined; details: Record<string, unknown> | undefined }>;
  egress: Array<{ method: string; resultStatus: string }>;
  replyShape: { keys: string[]; contentTypes: unknown[]; firstTextTitle: unknown };
}

async function runProbe(): Promise<ProbeOut> {
  const proc = Bun.spawn([process.execPath, PROBE, sandbox], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const deadline = setTimeout(() => proc.kill(), 150_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, `probe exited ${String(code)}: ${stderr}`).toBe(0);
    const line = stdout.split("\n").find((l) => l.startsWith(MARKER));
    expect(line, `probe printed no result: ${stdout}\n${stderr}`).toBeDefined();
    return JSON.parse((line ?? "").slice(MARKER.length)) as ProbeOut;
  } finally {
    clearTimeout(deadline);
  }
}

let probed: Promise<ProbeOut> | undefined;
const probe = (): Promise<ProbeOut> => {
  probed ??= runProbe();
  return probed;
};

const TYPES = [
  "jira.comment.add",
  "confluence.comment.add",
  "gitlab.issue.note.create",
  "gitlab.mr.note.create",
  "github.issue.comment.create",
];
const SERVICE: Readonly<Record<string, string>> = {
  "jira.comment.add": "jira",
  "confluence.comment.add": "confluence",
  "gitlab.issue.note.create": "gitlab",
  "gitlab.mr.note.create": "gitlab",
  "github.issue.comment.create": "github",
};

describe("B1 comment writes against fake upstreams (real connectors)", () => {
  test("approved: the before GET precedes the write POST, once each; denied: the GET only, no POST", async () => {
    const out = await probe();
    expect(out.runs.map((r) => `${r.type} ${String(r.approved)} ${r.status}`)).toEqual([
      ...TYPES.map((t) => `${t} true ok`),
      ...TYPES.map((t) => `${t} false rejected`),
    ]);
    const reads = [
      "GET /rest/api/3/issue/NIM-1",
      "GET /wiki/rest/api/content/123",
      "GET /api/v4/projects/group%2Frepo/issues/7",
      "GET /api/v4/projects/group%2Frepo/merge_requests/9",
      "GET /repos/o/r/issues/42",
    ];
    const writes = [
      "POST /rest/api/3/issue/NIM-1/comment",
      "POST /wiki/rest/api/content/123/child/comment",
      "POST /api/v4/projects/group%2Frepo/issues/7/notes",
      "POST /api/v4/projects/group%2Frepo/merge_requests/9/notes",
      "POST /repos/o/r/issues/42/comments",
    ];
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      ...reads.flatMap((r, i) => [r, writes[i] ?? ""]),
      ...reads,
      // The probe's direct read that pins the reply shape.
      "GET /repos/o/r/issues/42",
    ]);
    expect(seen.every((s) => s.hasAuth)).toBe(true);
  }, 180_000);

  test("each POST body is exactly what the connector sends", async () => {
    await probe();
    const posts = seen.filter((s) => s.method === "POST").map((s) => s.body);
    expect(posts).toEqual([
      {
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "Looks good" }] }],
        },
      },
      {
        type: "comment",
        container: { id: "123", type: "page" },
        body: { storage: { value: "<p>Looks good</p>", representation: "storage" } },
      },
      { body: "Looks good" },
      { body: "Looks good" },
      { body: "Looks good" },
    ]);
  }, 180_000);

  test("the owner's preview has the R2 target and the before fields from the fake reply", async () => {
    const out = await probe();
    const writeConsents = out.consents.filter(
      (c) => c.type !== undefined && TYPES.includes(c.type),
    );
    expect(writeConsents).toHaveLength(10);
    const first = writeConsents.slice(0, 5).map((c) => ({
      target: c.details?.["target"],
      before: c.details?.["before"],
      requestedBy: c.details?.["requestedBy"],
    }));
    expect(first).toEqual([
      {
        target: "NIM-1",
        requestedBy: "model",
        before: {
          status: "ok",
          fields: [
            { label: "Summary", value: "Fix login" },
            { label: "Status", value: "In Progress" },
            { label: "Type", value: "Bug" },
          ],
        },
      },
      {
        target: "123",
        requestedBy: "model",
        before: {
          status: "ok",
          fields: [
            { label: "Title", value: "Runbook" },
            { label: "Space", value: "ENG" },
            { label: "Version", value: "4" },
          ],
        },
      },
      {
        target: "group/repo#7",
        requestedBy: "model",
        before: {
          status: "ok",
          fields: [
            { label: "Title", value: "Broken" },
            { label: "State", value: "opened" },
          ],
        },
      },
      {
        target: "group/repo!9",
        requestedBy: "model",
        before: {
          status: "ok",
          fields: [
            { label: "Title", value: "Add cache" },
            { label: "State", value: "opened" },
            { label: "Branches", value: "feat/cache -> main" },
          ],
        },
      },
      {
        target: "o/r#42",
        requestedBy: "model",
        before: {
          status: "ok",
          fields: [
            { label: "Title", value: "Login fails" },
            { label: "State", value: "open" },
            { label: "Kind", value: "issue" },
          ],
        },
      },
    ]);
  }, 180_000);

  test("the real before-read reply is an MCP CallToolResult with one text part (plan R4)", async () => {
    const out = await probe();
    expect(out.replyShape).toEqual({
      keys: ["content"],
      contentTypes: ["text"],
      // The text part parses as JSON and carries the fake upstream's issue.
      firstTextTitle: "Login fails",
    });
  }, 180_000);

  test("egress rows, in order: the before-read authorized, then the write authorized or blocked", async () => {
    const out = await probe();
    const expected = (approved: boolean) =>
      TYPES.flatMap((t) => [
        `${SERVICE[t] ?? ""}.before.read authorized`,
        `${t} ${approved ? "authorized" : "blocked"}`,
      ]);
    expect(out.egress.map((e) => `${e.method} ${e.resultStatus}`)).toEqual([
      ...expected(true),
      ...expected(false),
    ]);
  }, 180_000);
});
