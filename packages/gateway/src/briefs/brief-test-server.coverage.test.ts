/**
 * `runBriefWithIndexHits`' refusals to report a result it did not get. The harness drives a REAL
 * server; each test answers exactly ONE of its HTTP calls with a canned failure (every other call
 * still reaches the real server) and asserts the harness throws, naming the step, without making
 * any later call. A control run with nothing intercepted proves the interception passes through.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IndexHit } from "./brief-registry.ts";
import { runBriefWithIndexHits } from "./brief-test-server.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const HITS: IndexHit[] = [
  {
    itemId: "nimbus:pull_request:acme/web/482",
    itemType: "pull_request",
    title: "Drop the legacy worker pool",
    url: "https://github.test/acme/web/pull/482",
    snippet: "the pool is replaced by a bounded queue",
  },
];

type Call = { method: string; step: Step; status: number };
type Step = "create" | "feed" | "run" | "poll" | "other";

function stepOf(method: string, path: string): Step {
  if (method === "POST" && path === "/v1/briefs") return "create";
  if (method === "POST" && /^\/v1\/briefs\/[^/]+\/sources$/.test(path)) return "feed";
  if (method === "POST" && /^\/v1\/briefs\/[^/]+\/run$/.test(path)) return "run";
  if (method === "GET" && /^\/v1\/briefs\/[^/]+$/.test(path)) return "poll";
  return "other";
}

/** Answers the calls `canned` returns a Response for; every other call reaches the real server. */
function interceptFetch(canned: (step: Step) => Response | undefined): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const step = stepOf(method, new URL(input).pathname);
    const res = canned(step) ?? (await realFetch(input, init));
    calls.push({ method, step, status: res.status });
    return res;
  }) as unknown as typeof fetch;
  return calls;
}

describe("runBriefWithIndexHits", () => {
  test("control: with nothing intercepted it returns the report citing the injected hit", async () => {
    const calls = interceptFetch(() => undefined);
    const report = await runBriefWithIndexHits(HITS);
    const cited = report.findings.flatMap((f) => f.citations);
    expect(
      cited.some(
        (c) =>
          c.kind === "clip" &&
          c.itemId === "nimbus:pull_request:acme/web/482" &&
          c.itemType === "pull_request",
      ),
    ).toBe(true);
    expect(calls.slice(0, 3)).toEqual([
      { method: "POST", step: "create", status: 200 },
      { method: "POST", step: "feed", status: 200 },
      { method: "POST", step: "run", status: 200 },
    ]);
    expect(calls.slice(3).every((c) => c.step === "poll" && c.status === 200)).toBe(true);
    expect(calls.length).toBeGreaterThan(3);
  });

  test.each([
    ["create", 503, "runBriefWithIndexHits: create failed with 503"],
    ["feed", 500, "runBriefWithIndexHits: feeding the source failed with 500"],
    ["run", 409, "runBriefWithIndexHits: starting the run failed with 409"],
  ] as const)("a non-200 %s stops the run there", async (failing, status, message) => {
    const calls = interceptFetch((step) =>
      step === failing ? new Response("{}", { status }) : undefined,
    );
    await expect(runBriefWithIndexHits(HITS)).rejects.toThrow(message);
    // The failing step is the LAST call made: nothing after it was attempted.
    expect(calls.at(-1)).toEqual({ method: "POST", step: failing, status });
    expect(calls.filter((c) => c.step === failing)).toHaveLength(1);
    expect(calls.some((c) => c.step === "poll")).toBe(false);
  });

  test("a run the server reports as failed is an error, never a report", async () => {
    const calls = interceptFetch((step) =>
      step === "poll" ? Response.json({ status: "failed", failureReason: "llm_error" }) : undefined,
    );
    await expect(runBriefWithIndexHits(HITS)).rejects.toThrow(
      "runBriefWithIndexHits: run reached status failed",
    );
    expect(calls.map((c) => c.step)).toEqual(["create", "feed", "run", "poll"]);
  });

  test("a done status without a report body is an error, never an undefined report", async () => {
    const calls = interceptFetch((step) =>
      step === "poll" ? Response.json({ status: "done" }) : undefined,
    );
    await expect(runBriefWithIndexHits(HITS)).rejects.toThrow(
      "runBriefWithIndexHits: done status but no report in the body",
    );
    expect(calls.map((c) => c.step)).toEqual(["create", "feed", "run", "poll"]);
  });
});
