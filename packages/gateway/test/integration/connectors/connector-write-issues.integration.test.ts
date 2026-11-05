/**
 * Phase 9.7 B2, Task 6: the issue writes end to end through REAL connector processes against a
 * loopback fake upstream, for the connectors whose host is configurable (Jira, GitLab, GitHub; 11
 * writes). Linear hard-codes its host and is proven in-process (its guard: `before-state.test.ts`,
 * `model-write-source.test.ts`, `connector-write-injection.test.ts`).
 *
 * The connectors, the `@mastra/mcp` client, the mesh dispatcher, the door-shaped executor (with its
 * before-state runner) and the index run in a CHILD (`test/fixtures/connector-write-probe.ts`,
 * suite `issues`); this file runs the fake upstream and asserts on what reached it, in order. No
 * gateway subprocess, no Vault: fake credentials go to the connectors through their env, and every
 * home and temp directory points at a throwaway one.
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
  readonly search: string;
  readonly body: unknown;
  /** `bearer`, `basic`, `private-token` or `none`. */
  readonly auth: string;
}

const seen: Seen[] = [];

const JIRA_ISSUE = {
  key: "NIM-1",
  fields: {
    summary: "Fix login",
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    description: { type: "doc", content: [] },
  },
};
const GL_ISSUE = {
  iid: 7,
  title: "Broken",
  state: "opened",
  labels: ["ui"],
  assignees: [{ username: "bob" }],
};
const GH_ISSUE = {
  number: 42,
  title: "Login fails",
  state: "open",
  labels: [{ name: "ui" }],
  assignees: [{ login: "bob" }],
  pull_request: { url: "u" },
};

/** One reply per route; `null` is a 204 with no body. */
const ROUTES: Readonly<Record<string, unknown>> = {
  "POST /rest/api/3/issue": { id: "10002", key: "NIM-2" },
  "GET /rest/api/3/issue/NIM-1": JIRA_ISSUE,
  "PUT /rest/api/3/issue/NIM-1": null,
  "GET /rest/api/3/issue/NIM-1/transitions": {
    transitions: [{ id: "31", name: "Done", to: { name: "Done" } }],
  },
  "POST /rest/api/3/issue/NIM-1/transitions": null,
  "POST /api/v4/projects/group%2Frepo/issues": { iid: 8, title: "Broken" },
  "GET /api/v4/projects/group%2Frepo/issues/7": GL_ISSUE,
  "PUT /api/v4/projects/group%2Frepo/issues/7": GL_ISSUE,
  "POST /api/graphql": { data: { issueSetAssignees: { errors: [] } } },
  "POST /repos/o/r/issues": { number: 43 },
  "GET /repos/o/r/issues/42": GH_ISSUE,
  "PATCH /repos/o/r/issues/42": GH_ISSUE,
  "POST /repos/o/r/issues/42/labels": [{ name: "ui" }, { name: "bug" }],
  "POST /repos/o/r/issues/42/assignees": GH_ISSUE,
};

function authKind(req: Request): string {
  if (req.headers.get("private-token") !== null) return "private-token";
  const a = req.headers.get("authorization") ?? "";
  if (a.startsWith("Bearer ")) return "bearer";
  if (a.startsWith("Basic ")) return "basic";
  if (a.startsWith("token ")) return "token";
  return a === "" ? "none" : "other";
}

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
      search: url.search,
      body,
      auth: authKind(req),
    });
    const key = `${req.method} ${url.pathname}`;
    if (!Object.hasOwn(ROUTES, key)) return new Response("not found", { status: 404 });
    const reply = ROUTES[key];
    if (reply === null) return new Response(null, { status: 204 });
    return Response.json(reply, { status: req.method === "POST" ? 201 : 200 });
  },
});
const base = `http://127.0.0.1:${String(server.port)}`;

const sandbox = mkdtempSync(join(tmpdir(), "nimbus-b2-writes-"));
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
}

async function runProbe(): Promise<ProbeOut> {
  const proc = Bun.spawn([process.execPath, PROBE, sandbox, "issues"], {
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
  "jira.issue.create",
  "jira.issue.update",
  "jira.issue.transition",
  "gitlab.issue.create",
  "gitlab.issue.labels.add",
  "gitlab.issue.assignees.add",
  "gitlab.issue.state.set",
  "github.issue.create",
  "github.issue.labels.add",
  "github.issue.assignees.add",
  "github.issue.state.set",
];

/** Per write, in order: the before reads, then (approved only) the write's own requests. */
const READS: ReadonlyArray<readonly string[]> = [
  [],
  ["GET /rest/api/3/issue/NIM-1"],
  ["GET /rest/api/3/issue/NIM-1/transitions", "GET /rest/api/3/issue/NIM-1"],
  [],
  ["GET /api/v4/projects/group%2Frepo/issues/7"],
  ["GET /api/v4/projects/group%2Frepo/issues/7"],
  ["GET /api/v4/projects/group%2Frepo/issues/7"],
  [],
  ["GET /repos/o/r/issues/42"],
  ["GET /repos/o/r/issues/42"],
  ["GET /repos/o/r/issues/42"],
];
const WRITES: ReadonlyArray<readonly string[]> = [
  ["POST /rest/api/3/issue"],
  ["PUT /rest/api/3/issue/NIM-1"],
  // Under the gateway the connector registers the raw handler (the gateway's executor owns
  // consent), so its own pre-state capture does not run: the POST alone.
  ["POST /rest/api/3/issue/NIM-1/transitions"],
  ["POST /api/v4/projects/group%2Frepo/issues"],
  ["PUT /api/v4/projects/group%2Frepo/issues/7"],
  ["POST /api/graphql"],
  ["PUT /api/v4/projects/group%2Frepo/issues/7"],
  ["POST /repos/o/r/issues"],
  ["POST /repos/o/r/issues/42/labels"],
  ["POST /repos/o/r/issues/42/assignees"],
  ["PATCH /repos/o/r/issues/42"],
];

const isWrite = (s: Seen): boolean => s.method !== "GET";

describe("B2 issue writes against fake upstreams (real connectors)", () => {
  test("approved: the before reads precede each write (the transition's two, list first); denied: the reads only", async () => {
    const out = await probe();
    expect(out.runs.map((r) => `${r.type} ${String(r.approved)} ${r.status}`)).toEqual([
      ...TYPES.map((t) => `${t} true ok`),
      ...TYPES.map((t) => `${t} false rejected`),
    ]);
    expect(seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      ...READS.flatMap((r, i) => [...r, ...(WRITES[i] ?? [])]),
      ...READS.flat(),
    ]);
  }, 180_000);

  test("each write request body is exactly what the connector sends; labels and assignees only add", async () => {
    await probe();
    const bodies = seen
      .filter(isWrite)
      .map((s) => `${s.method} ${s.path} ${JSON.stringify(s.body)}`);
    expect(bodies).toEqual([
      `POST /rest/api/3/issue ${JSON.stringify({
        fields: {
          project: { key: "NIM" },
          summary: "Login fails",
          issuetype: { name: "Task" },
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "Steps" }] }],
          },
        },
      })}`,
      `PUT /rest/api/3/issue/NIM-1 ${JSON.stringify({ fields: { summary: "Login fails on Safari" } })}`,
      `POST /rest/api/3/issue/NIM-1/transitions ${JSON.stringify({ transition: { id: "31" } })}`,
      `POST /api/v4/projects/group%2Frepo/issues ${JSON.stringify({
        title: "Broken",
        labels: "bug,ui",
        assignee_ids: [12],
      })}`,
      `PUT /api/v4/projects/group%2Frepo/issues/7 ${JSON.stringify({ add_labels: "bug" })}`,
      `POST /api/graphql ${JSON.stringify({
        query:
          "mutation($projectPath: ID!, $iid: String!, $assigneeUsernames: [String!]!) { issueSetAssignees(input: { projectPath: $projectPath, iid: $iid, assigneeUsernames: $assigneeUsernames, operationMode: APPEND }) { errors } }",
        variables: { projectPath: "group/repo", iid: "7", assigneeUsernames: ["alice"] },
      })}`,
      `PUT /api/v4/projects/group%2Frepo/issues/7 ${JSON.stringify({ state_event: "close" })}`,
      `POST /repos/o/r/issues ${JSON.stringify({ title: "Login fails", body: "Steps" })}`,
      `POST /repos/o/r/issues/42/labels ${JSON.stringify({ labels: ["bug"] })}`,
      `POST /repos/o/r/issues/42/assignees ${JSON.stringify({ assignees: ["alice"] })}`,
      `PATCH /repos/o/r/issues/42 ${JSON.stringify({ state: "closed" })}`,
    ]);
    // The GitLab labels PUT carries no replacing `labels` key.
    const glPut = seen.find((s) => s.method === "PUT" && s.path.endsWith("/issues/7"));
    expect(Object.keys((glPut?.body ?? {}) as object)).toEqual(["add_labels"]);
    // GraphQL is Bearer (GitLab's documented header there), REST is PRIVATE-TOKEN.
    expect(seen.filter((s) => s.path === "/api/graphql").map((s) => s.auth)).toEqual(["bearer"]);
    expect([
      ...new Set(seen.filter((s) => s.path.startsWith("/api/v4/")).map((s) => s.auth)),
    ]).toEqual(["private-token"]);
    expect(seen.every((s) => s.auth !== "none")).toBe(true);
  }, 180_000);

  test("the owner's preview has the R2 target and the R3 before fields from the fake replies", async () => {
    const out = await probe();
    const asked = out.consents.filter((c) => c.type !== undefined && TYPES.includes(c.type));
    expect(asked).toHaveLength(22);
    const first = asked.slice(0, 11).map((c) => ({
      type: c.type,
      target: c.details?.["target"],
      before: c.details?.["before"],
      requestedBy: c.details?.["requestedBy"],
    }));
    const GL_BEFORE = {
      status: "ok",
      fields: [
        { label: "Title", value: "Broken" },
        { label: "State", value: "opened" },
        { label: "Labels", value: "ui" },
        { label: "Assignees", value: "bob" },
      ],
    };
    const GH_BEFORE = {
      status: "ok",
      fields: [
        { label: "Title", value: "Login fails" },
        { label: "State", value: "open" },
        { label: "Kind", value: "pull request" },
        { label: "Labels", value: "ui" },
        { label: "Assignees", value: "bob" },
      ],
    };
    const m = (type: string, target: string, before?: unknown) =>
      before === undefined
        ? { type, target, before: undefined, requestedBy: "model" }
        : { type, target, before, requestedBy: "model" };
    expect(first).toEqual([
      m("jira.issue.create", "NIM"),
      m("jira.issue.update", "NIM-1", {
        status: "ok",
        fields: [
          { label: "Summary", value: "Fix login" },
          { label: "Status", value: "In Progress" },
          { label: "Type", value: "Bug" },
        ],
      }),
      m("jira.issue.transition", "NIM-1", {
        status: "ok",
        fields: [
          { label: "From", value: "In Progress" },
          { label: "Transition", value: "Done" },
          { label: "To", value: "Done" },
        ],
      }),
      m("gitlab.issue.create", "group/repo"),
      m("gitlab.issue.labels.add", "group/repo#7", GL_BEFORE),
      m("gitlab.issue.assignees.add", "group/repo#7", GL_BEFORE),
      m("gitlab.issue.state.set", "group/repo#7", GL_BEFORE),
      m("github.issue.create", "o/r"),
      m("github.issue.labels.add", "o/r#42", GH_BEFORE),
      m("github.issue.assignees.add", "o/r#42", GH_BEFORE),
      m("github.issue.state.set", "o/r#42", GH_BEFORE),
    ]);
  }, 180_000);

  test("egress rows, in order: each before-read (two for the transition), then the write authorized or blocked", async () => {
    const out = await probe();
    const service = (t: string) => t.slice(0, t.indexOf("."));
    const expected = (approved: boolean) =>
      TYPES.flatMap((t, i) => [
        ...(READS[i] ?? []).map(() => `${service(t)}.before.read authorized`),
        `${t} ${approved ? "authorized" : "blocked"}`,
      ]);
    expect(out.egress.map((e) => `${e.method} ${e.resultStatus}`)).toEqual([
      ...expected(true),
      ...expected(false),
    ]);
  }, 180_000);
});
