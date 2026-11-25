/**
 * A local `Bun.serve` fake of the Stack Overflow for Teams v3 API, shared by the question and
 * answer sync tests. It answers the team's questions list and, per question, its answers list;
 * every other path is a 404.
 */
import { Database } from "bun:sqlite";
import type { Server } from "bun";
import pino from "pino";
import { LocalIndex } from "../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../src/sync/rate-limiter.ts";
import { buildSyncCapabilities } from "../../src/sync/sync-capabilities.ts";
import type { SyncContext } from "../../src/sync/types.ts";
import { createMockVault } from "../../src/vault/mock.ts";
import { requestUrl } from "./request-url.ts";

export interface RecordedReq {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
}

/** What the fake answers route returns for one question: its answers, or a failure. */
export type FakeAnswers = unknown[] | { status: number } | "badJson";

export interface FakeStackOverflowConfig {
  pages?: unknown[][];
  status?: number;
  badJson?: boolean;
  /** Answers by question id. A question that is not listed here answers 404, as before. */
  answers?: Record<string, FakeAnswers>;
}

export interface FakeStackOverflow {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

export const TEAM = "acme team";
export function startFakeStackOverflow(config: FakeStackOverflowConfig): FakeStackOverflow {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  const pages = config.pages ?? [[]];
  const expectedPath = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        query: u.search,
        authorization: req.headers.get("authorization"),
      });
      if (u.pathname === expectedPath) {
        if (config.status !== undefined && config.status !== 200) {
          return new Response("error", { status: config.status });
        }
        if (config.badJson === true) {
          return new Response("{not json", { status: 200 });
        }
        const page = Number(u.searchParams.get("page") ?? "1");
        const items = pages[page - 1] ?? [];
        return Response.json({
          items,
          totalCount: pages.reduce((n, p) => n + p.length, 0),
          pageSize: 100,
          page,
          totalPages: pages.length,
          sort: "creation",
          order: "desc",
        });
      }
      const answersMatch = /^\/([^/]+)\/answers$/.exec(
        u.pathname.startsWith(expectedPath) ? u.pathname.slice(expectedPath.length) : "",
      );
      const answers = answersMatch === null ? undefined : config.answers?.[answersMatch[1] ?? ""];
      if (answers !== undefined) {
        if (answers === "badJson") {
          return new Response("{not json", { status: 200 });
        }
        if (!Array.isArray(answers)) {
          return new Response("error", { status: answers.status });
        }
        return Response.json({
          items: answers,
          totalCount: answers.length,
          pageSize: 100,
          page: 1,
          totalPages: 1,
          sort: "score",
          order: "desc",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

export interface Harness {
  vault: ReturnType<typeof createMockVault>;
  db: Database;
  ctx: SyncContext;
  fake: FakeStackOverflow;
  cleanup: () => void;
}

export function startHarness(config: FakeStackOverflowConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeStackOverflow(config);
  return {
    db,
    vault,
    fake,
    cleanup: () => {
      fake.stop();
      db.close();
    },
    ctx: {
      ...buildSyncCapabilities({ vault, db, depth: "full" }, "stackoverflow"),
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter({
        stackoverflow: { requestsPerMinute: 600_000, burstSize: 10_000 },
      }),
    },
  };
}

export function question(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Question ${String(id)} — exponential backoff with jitter`,
    body: "<p>thundering-herd retries on the payment queue</p>",
    bodyMarkdown: "thundering-herd retries on the payment queue",
    tags: [{ name: "reliability" }],
    score: 3,
    viewCount: 42,
    answerCount: 1,
    isAnswered: true,
    owner: { id: 7, name: "Ada Lovelace" },
    webUrl: `https://stackoverflowteams.com/c/acme/questions/${String(id)}`,
    creationDate: "2024-03-01T12:00:00.000Z",
    lastActivityDate: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

export function answer(
  id: number,
  questionId: number,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    questionId,
    body: `<p>Use <strong>full jitter</strong> for answer ${String(id)}.</p>`,
    score: 4,
    isAccepted: false,
    isDeleted: false,
    commentCount: 0,
    owner: { id: 8, name: "Grace Hopper" },
    webUrl: `https://stackoverflowteams.com/c/acme/questions/${String(questionId)}/${String(id)}`,
    creationDate: "2024-03-03T12:00:00.000Z",
    lastActivityDate: "2024-03-04T08:00:00.000Z",
    ...over,
  };
}

export const QUESTIONS_PATH = `/v3/teams/${encodeURIComponent(TEAM)}/questions`;

export function answersRequests(fake: FakeStackOverflow): RecordedReq[] {
  return fake.requests.filter((r) => r.path.endsWith("/answers"));
}

export function answersRequestIds(fake: FakeStackOverflow): string[] {
  return answersRequests(fake).map((r) =>
    r.path.slice(QUESTIONS_PATH.length + 1, -"/answers".length),
  );
}

export function fullPage(base: number): unknown[] {
  return Array.from({ length: 100 }, (_, i) => question(base + i));
}

export function withRewrittenFetch(fakeBase: string): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = requestUrl(input);
    const rewritten = urlStr.replace("https://api.stackoverflowteams.com", fakeBase);
    return original(rewritten, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}
