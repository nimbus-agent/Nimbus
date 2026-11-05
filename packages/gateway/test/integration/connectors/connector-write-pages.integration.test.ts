/**
 * Phase 9.7 B3, Task 6: the Confluence page writes end to end through a REAL connector process
 * against a loopback fake upstream. Confluence is the only B3 connector whose host is configurable
 * (`CONFLUENCE_BASE_URL`); Notion, Gmail, Microsoft Graph and iCloud IMAP hard-code theirs and are
 * proven in-process.
 *
 * The connector, the `@mastra/mcp` client, the mesh dispatcher, the door-shaped executor (its
 * before-state runner fed a Confluence KB destination, space `KB`) and the index run in a CHILD
 * (`test/fixtures/connector-write-probe.ts`, suite `pages`); this file runs the fake upstream and
 * asserts on what reached it. The permitted update and appends target space ENG (B3's review fix 4,
 * kept); since connectors 0.5.0 the before read expands `ancestors`, and the fake returns them only
 * when asked, as Confluence does: page 778 is in the KB space but not under the KB parent (allowed),
 * page 777 is under it (refused). No gateway subprocess, no Vault: fake credentials only, every home
 * and temp directory a throwaway one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KNOWLEDGE_BASE_CHILD_REFUSAL } from "../../../src/connectors/connector-writes/model-write-refusals.ts";
import { extensionProcessEnv } from "../../../src/extensions/spawn-env.ts";

const PROBE = join(import.meta.dir, "..", "..", "fixtures", "connector-write-probe.ts");
const MARKER = "CONNECTOR_WRITE_PROBE ";
const PAGE_PATH = "/wiki/rest/api/content";
const BEFORE_EXPAND = "body.storage,version,history.lastUpdated,space,ancestors";
const CONNECTOR_EXPAND = "body.storage,version";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly expand: string | null;
  readonly body: unknown;
  readonly hasAuth: boolean;
}

const seen: Seen[] = [];

/** Page 124's PUTs so far: the first is answered 409, and its version moves from 3 to 4. */
let puts124 = 0;

/** The ancestors of each KB-space page (0.5.0's `{ id, title }`), sent only when expanded. */
const ANCESTORS: Readonly<Record<string, ReadonlyArray<{ id: string; title: string }>>> = {
  "777": [
    { id: "1", title: "Home" },
    { id: "4242", title: "Nimbus knowledge base" },
  ],
  "778": [
    { id: "1", title: "Home" },
    { id: "77", title: "Team notes" },
  ],
};

/** Page 778's PUTs so far (the allowed KB-space append). */
let puts778 = 0;

function page(id: string): Record<string, unknown> | undefined {
  if (id === "123") {
    return {
      id: "123",
      type: "page",
      title: "Runbook",
      space: { key: "ENG" },
      version: { number: 7 },
      body: { storage: { value: "<p>old</p>" } },
    };
  }
  if (id === "124") {
    return {
      id: "124",
      type: "page",
      title: "Changelog",
      space: { key: "ENG" },
      version: { number: puts124 === 0 ? 3 : 4 },
      body: { storage: { value: puts124 === 0 ? "<p>v3</p>" : "<p>v4</p>" } },
    };
  }
  if (id === "777") {
    // In the KB space, under the KB parent 4242: refused by the KB-child guard.
    return {
      id: "777",
      type: "page",
      title: "KB note",
      space: { key: "KB" },
      version: { number: 2 },
      body: { storage: { value: "<p>kb</p>" } },
    };
  }
  if (id === "778") {
    // In the KB space, NOT under the KB parent: allowed since 0.5.0 reads `ancestors`.
    return {
      id: "778",
      type: "page",
      title: "Team page",
      space: { key: "KB" },
      version: { number: 5 },
      body: { storage: { value: "<p>team</p>" } },
    };
  }
  return undefined;
}

/** The page as Confluence sends it: `ancestors` only when the request's `expand` names it. */
function pageFor(id: string, expand: string | null): Record<string, unknown> | undefined {
  const p = page(id);
  const anc = Object.hasOwn(ANCESTORS, id) ? ANCESTORS[id] : undefined;
  const expanded = (expand ?? "").split(",").includes("ancestors");
  return p === undefined || anc === undefined || !expanded ? p : { ...p, ancestors: anc };
}

function reply(method: string, path: string, expand: string | null): Response {
  if (method === "POST" && path === PAGE_PATH) return Response.json({ id: "200" });
  const id = path.startsWith(`${PAGE_PATH}/`) ? path.slice(PAGE_PATH.length + 1) : "";
  const p = pageFor(id, expand);
  if (p === undefined) return new Response("not found", { status: 404 });
  if (method === "GET") return Response.json(p);
  if (method === "PUT" && id === "778") puts778 += 1;
  if (method === "PUT" && id === "124") {
    puts124 += 1;
    if (puts124 === 1) return new Response("version conflict", { status: 409 });
    return Response.json({ version: { number: 5 } });
  }
  if (method === "PUT") return Response.json({ version: { number: 8 } });
  return new Response("not found", { status: 404 });
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
      expand: url.searchParams.get("expand"),
      body,
      hasAuth: req.headers.get("authorization") !== null,
    });
    return reply(req.method, url.pathname, url.searchParams.get("expand"));
  },
});
const base = `http://127.0.0.1:${String(server.port)}`;

const sandbox = mkdtempSync(join(tmpdir(), "nimbus-b3-pages-"));
const childEnv = extensionProcessEnv({
  ...Object.fromEntries(
    ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP"].map((k) => [
      k,
      sandbox,
    ]),
  ),
  // Fake credentials only; the fake upstream accepts anything.
  CONFLUENCE_BASE_URL: base,
  CONFLUENCE_EMAIL: "probe@example.test",
  CONFLUENCE_API_TOKEN: "fake",
});

afterAll(() => {
  server.stop(true);
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

interface ProbeOut {
  runs: Array<{ type: string; approved: boolean; status: string; reason?: string }>;
  consents: Array<{ type: string | undefined; details: Record<string, unknown> | undefined }>;
  egress: Array<{ method: string; resultStatus: string }>;
}

async function runProbe(): Promise<ProbeOut> {
  const proc = Bun.spawn([process.execPath, PROBE, sandbox, "pages"], {
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

const at = (id: string) => `${PAGE_PATH}/${id}`;
const req = (s: Seen) => `${s.method} ${s.path}${s.expand === null ? "" : `?expand=${s.expand}`}`;
const BEFORE = (id: string) => `GET ${at(id)}?expand=${BEFORE_EXPAND}`;
const CONN = (id: string) => `GET ${at(id)}?expand=${CONNECTOR_EXPAND}`;

describe("B3 Confluence page writes against a fake upstream (real connector)", () => {
  test("approved and denied: each write's results, the append under the KB parent refused by the guard", async () => {
    const out = await probe();
    const pass = (approved: boolean) => [
      `confluence.page.create ${String(approved)} ${approved ? "ok" : "rejected"}`,
      `confluence.page.update ${String(approved)} ${approved ? "ok" : "rejected"}`,
      `confluence.page.append ${String(approved)} ${approved ? "ok" : "rejected"}`,
      `confluence.page.append ${String(approved)} ${approved ? "ok" : "rejected"}`,
      `confluence.page.append ${String(approved)} ${approved ? "ok" : "rejected"}`,
      `confluence.page.append ${String(approved)} rejected`,
    ];
    expect(out.runs.map((r) => `${r.type} ${String(r.approved)} ${r.status}`)).toEqual([
      ...pass(true),
      ...pass(false),
    ]);
    // Page 777 (under the KB parent): refused with the guard's fixed text in BOTH passes, before
    // any prompt; page 778 (KB space, other ancestors) reached the prompt in both.
    expect(out.runs.filter((r) => r.reason === KNOWLEDGE_BASE_CHILD_REFUSAL)).toHaveLength(2);
  }, 180_000);

  test("the requests, in order: no read for the create; the before GET, then the connector's GET and PUT", async () => {
    await probe();
    expect(seen.map(req)).toEqual([
      // Approved pass.
      `POST ${PAGE_PATH}`,
      BEFORE("123"),
      `PUT ${at("123")}`,
      BEFORE("123"),
      CONN("123"),
      `PUT ${at("123")}`,
      BEFORE("124"),
      CONN("124"),
      `PUT ${at("124")}`, // 409
      CONN("124"),
      `PUT ${at("124")}`,
      BEFORE("778"), // in the KB space, not under the KB parent: allowed
      CONN("778"),
      `PUT ${at("778")}`,
      BEFORE("777"), // under the KB parent: refused by the KB-child guard, no write
      // Denied pass: the before GETs only.
      BEFORE("123"),
      BEFORE("123"),
      BEFORE("124"),
      BEFORE("778"),
      BEFORE("777"),
    ]);
    expect(seen.every((s) => s.hasAuth)).toBe(true);
  }, 180_000);

  test("each write body is exactly what the connector sends", async () => {
    await probe();
    const writes = seen.filter((s) => s.method !== "GET").map((s) => s.body);
    expect(writes).toEqual([
      {
        type: "page",
        title: "New page",
        space: { key: "ENG" },
        body: { storage: { value: "<p>new</p>", representation: "storage" } },
        ancestors: [{ id: "55" }],
      },
      {
        type: "page",
        title: "Runbook v2",
        version: { number: 8, message: "nimbus" },
        body: { storage: { value: "<p>replaced</p>", representation: "storage" } },
      },
      {
        type: "page",
        title: "Runbook",
        version: { number: 8, message: "nimbus" },
        body: { storage: { value: "<p>old</p><p>appended</p>", representation: "storage" } },
      },
      // The 409: the connector re-reads and appends to the body as it is NOW.
      {
        type: "page",
        title: "Changelog",
        version: { number: 4, message: "nimbus" },
        body: { storage: { value: "<p>v3</p><p>more</p>", representation: "storage" } },
      },
      {
        type: "page",
        title: "Changelog",
        version: { number: 5, message: "nimbus" },
        body: { storage: { value: "<p>v4</p><p>more</p>", representation: "storage" } },
      },
      // The connector's own GET expands no `ancestors`, so none is written back.
      {
        type: "page",
        title: "Team page",
        version: { number: 6, message: "nimbus" },
        body: { storage: { value: "<p>team</p><p>team note</p>", representation: "storage" } },
      },
    ]);
    expect(puts778).toBe(1);
  }, 180_000);

  test("the owner's preview: the version check for the update, the current tail for the append", async () => {
    const out = await probe();
    const asked = out.consents.filter((c) => c.type?.startsWith("confluence.page.") === true);
    // Two passes of create, update and three appends: the append under the KB parent never asks.
    expect(asked.map((c) => c.type)).toEqual([
      "confluence.page.create",
      "confluence.page.update",
      "confluence.page.append",
      "confluence.page.append",
      "confluence.page.append",
      "confluence.page.create",
      "confluence.page.update",
      "confluence.page.append",
      "confluence.page.append",
      "confluence.page.append",
    ]);
    expect(asked[0]?.details?.["before"]).toBeUndefined();
    expect(asked[1]?.details?.["before"]).toEqual({
      status: "ok",
      fields: [
        { label: "Title", value: "Runbook" },
        { label: "Space", value: "ENG" },
        { label: "Version", value: "7" },
        { label: "Version check", value: "matches; the write saves version 8" },
        { label: "Current length", value: "10 characters (all replaced)" },
        { label: "Current body (start)", value: "<p>old</p>" },
      ],
    });
    expect(asked[2]?.details?.["before"]).toEqual({
      status: "ok",
      fields: [
        { label: "Title", value: "Runbook" },
        { label: "Space", value: "ENG" },
        { label: "Version", value: "7" },
        { label: "Current length", value: "10 characters (kept)" },
        { label: "Current body (end)", value: "<p>old</p>" },
      ],
    });
    // The allowed KB-space append (page 778) shows its before like any other.
    expect(asked[4]?.details?.["before"]).toEqual({
      status: "ok",
      fields: [
        { label: "Title", value: "Team page" },
        { label: "Space", value: "KB" },
        { label: "Version", value: "5" },
        { label: "Current length", value: "11 characters (kept)" },
        { label: "Current body (end)", value: "<p>team</p>" },
      ],
    });
  }, 180_000);

  test("egress rows: the before-read, then the write authorized, blocked when denied or refused", async () => {
    const out = await probe();
    const pass = (approved: boolean) => {
      const w = approved ? "authorized" : "blocked";
      return [
        `confluence.page.create ${w}`,
        "confluence.before.read authorized",
        `confluence.page.update ${w}`,
        "confluence.before.read authorized",
        `confluence.page.append ${w}`,
        "confluence.before.read authorized",
        `confluence.page.append ${w}`,
        "confluence.before.read authorized",
        `confluence.page.append ${w}`,
        "confluence.before.read authorized",
        "confluence.page.append blocked",
      ];
    };
    expect(out.egress.map((e) => `${e.method} ${e.resultStatus}`)).toEqual([
      ...pass(true),
      ...pass(false),
    ]);
  }, 180_000);
});
