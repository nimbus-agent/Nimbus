import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { awaitAgentBrief, renderAgentBrief, resolveBriefTimeoutMs } from "./agent-brief-render.ts";

// ---------------------------------------------------------------------------
// renderAgentBrief
// ---------------------------------------------------------------------------

const capture = createStreamCapture({ captureExit: true });

beforeEach(() => {
  capture.install();
  capture.stdoutChunks.length = 0;
  capture.stderrChunks.length = 0;
});

afterEach(() => {
  capture.restore();
});

type SimpleFindings = { gaps: readonly { category: string }[]; value: string };

function makeFindings(opts: { emptyIndex?: boolean; value?: string } = {}): SimpleFindings {
  return {
    gaps: opts.emptyIndex ? [{ category: "empty_index" }] : [],
    value: opts.value ?? "hello",
  };
}

describe("renderAgentBrief — json mode", () => {
  it("writes JSON-stringified findings to stdout and returns", () => {
    const findings = makeFindings({ value: "test" });
    renderAgentBrief("the brief", findings, true);
    const out = capture.stdoutChunks.join("");
    expect(out).toContain('"value": "test"');
    expect(out).toContain('"gaps"');
    expect(capture.stderrChunks).toHaveLength(0);
  });

  it("does not print the brief string when json=true", () => {
    renderAgentBrief("should not appear", makeFindings(), true);
    expect(capture.stdoutChunks.join("")).not.toContain("should not appear");
  });
});

describe("renderAgentBrief — empty_index gap", () => {
  it("writes the sync-first message to stderr and exits with code 1", () => {
    expect(() => renderAgentBrief("brief", makeFindings({ emptyIndex: true }), false)).toThrow(
      "process.exit(1)",
    );
    expect(capture.stderrChunks.join("")).toContain("No data indexed yet");
    expect(capture.stdoutChunks).toHaveLength(0);
  });
});

describe("renderAgentBrief — normal (non-json, non-empty-index)", () => {
  it("writes the brief to stdout", () => {
    renderAgentBrief("my brief text", makeFindings(), false);
    expect(capture.stdoutChunks.join("")).toContain("my brief text");
  });

  it("does not write to stderr in the normal path", () => {
    renderAgentBrief("a brief", makeFindings(), false);
    expect(capture.stderrChunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// awaitAgentBrief
// ---------------------------------------------------------------------------

type FakeBrief = { kind: "fake"; agentVersion: 1; gaps: readonly { category: string }[] };

function isFakeBrief(x: unknown): x is FakeBrief {
  if (x === null || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return b["kind"] === "fake" && b["agentVersion"] === 1 && Array.isArray(b["gaps"]);
}

function makeValidFakeBrief(): FakeBrief {
  return { kind: "fake", agentVersion: 1, gaps: [] };
}

describe("awaitAgentBrief — resolves on briefReady with valid guard", () => {
  it("resolves with brief and findings when notification is valid", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const { client } = createMockIpcClient([], handlers);

    const pending = awaitAgentBrief(client, "fake", isFakeBrief);
    pending.bindSession("s1");

    handlers.get("fake.briefReady")?.({
      sessionId: "s1",
      brief: "some summary",
      findings: makeValidFakeBrief(),
    });

    const result = await pending.result;
    expect(result.brief).toBe("some summary");
    expect(result.findings.kind).toBe("fake");
  });
});

describe("awaitAgentBrief — rejects on malformed payload", () => {
  it("rejects when brief is missing from payload", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const { client } = createMockIpcClient([], handlers);

    const pending = awaitAgentBrief(client, "fake", isFakeBrief);
    pending.bindSession("s1");

    handlers.get("fake.briefReady")?.({
      sessionId: "s1",
      findings: makeValidFakeBrief(),
      // brief intentionally missing
    });

    await expect(pending.result).rejects.toThrow("Malformed fake.briefReady payload");
  });

  it("rejects when findings fails the guard", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const { client } = createMockIpcClient([], handlers);

    const pending = awaitAgentBrief(client, "fake", isFakeBrief);
    pending.bindSession("s1");

    handlers.get("fake.briefReady")?.({
      sessionId: "s1",
      brief: "ok",
      findings: { kind: "wrong" }, // fails isFakeBrief
    });

    await expect(pending.result).rejects.toThrow("Malformed fake.briefReady payload");
  });
});

describe("awaitAgentBrief — rejects on briefError", () => {
  it("rejects with the error message from the gateway", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const { client } = createMockIpcClient([], handlers);

    const pending = awaitAgentBrief(client, "fake", isFakeBrief);
    pending.bindSession("s1");

    handlers.get("fake.briefError")?.({ sessionId: "s1", error: "index not ready" });

    await expect(pending.result).rejects.toThrow("index not ready");
  });

  it("rejects with a malformed-payload message naming the briefError channel when error is absent", async () => {
    // `error` is absent and `brief` is not a string, so this is indistinguishable
    // from a malformed briefError payload — there is no "Agent failed" fallback
    // once routing is sessionId-based; the router only ever rejects with a
    // concrete cause (malformed payload, explicit error, timeout, or fail()). The
    // message must name `briefError` (the channel it actually arrived on), not
    // `briefReady`.
    const handlers = new Map<string, (params: unknown) => void>();
    const { client } = createMockIpcClient([], handlers);

    const pending = awaitAgentBrief(client, "fake", isFakeBrief);
    pending.bindSession("s1");

    handlers.get("fake.briefError")?.({ sessionId: "s1" });

    await expect(pending.result).rejects.toThrow("Malformed fake.briefError payload");
  });
});

describe("awaitAgentBrief — timeout", () => {
  it("rejects once the timeout elapses without a matching notification", async () => {
    const handlers = new Map<string, (params: unknown) => void>();
    const { client } = createMockIpcClient([], handlers);

    const pending = awaitAgentBrief(client, "fake", isFakeBrief, 5);
    pending.bindSession("s1");

    await expect(pending.result).rejects.toThrow("timed out");
  });
});

// ---------------------------------------------------------------------------
// resolveBriefTimeoutMs
//
// The CLI's brief timeout used to be a hardcoded 30_000 with no override. That
// silently capped the gateway's own `[agents] synthesis_timeout_ms`: a config of
// 90_000 was unreachable, because the client gave up first. Any local model slow
// enough to need more than 30s could therefore never return a brief through the
// CLI at all (observed: a 14B model rendering `catchup` in 41.5s).
// ---------------------------------------------------------------------------

const TIMEOUT_ENV = "NIMBUS_BRIEF_TIMEOUT_MS";

function withTimeoutEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[TIMEOUT_ENV];
  if (value === undefined) delete process.env[TIMEOUT_ENV];
  else process.env[TIMEOUT_ENV] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[TIMEOUT_ENV];
    else process.env[TIMEOUT_ENV] = prev;
  }
}

describe("resolveBriefTimeoutMs", () => {
  it("defaults high enough for a local mid-size model to finish a brief", () => {
    // Pinned deliberately: the old 30_000 default is below the observed
    // wall-clock of a 14B-class local model, which is the default path for a
    // local-first product.
    expect(withTimeoutEnv(undefined, resolveBriefTimeoutMs)).toBe(120_000);
  });

  it("uses NIMBUS_BRIEF_TIMEOUT_MS when it is a positive integer", () => {
    expect(withTimeoutEnv("240000", resolveBriefTimeoutMs)).toBe(240_000);
  });

  it("falls back to the default when the override is not a positive integer", () => {
    for (const bad of ["", "abc", "0", "-5"]) {
      expect(withTimeoutEnv(bad, resolveBriefTimeoutMs)).toBe(120_000);
    }
  });
});

describe("awaitAgentBrief — timeout wiring", () => {
  it("times out using the env-derived value rather than a hardcoded default", async () => {
    const client: { onNotification(m: string, h: (p: unknown) => void): void } = {
      onNotification: (): void => {},
    };
    const pending = withTimeoutEnv("60", () =>
      awaitAgentBrief(client, "catchup", (_x): _x is { gaps: [] } => true),
    );
    await expect(pending.result).rejects.toThrow("Agent timed out after 60 ms");
  });
});

// ---------------------------------------------------------------------------
// Single source of truth for the brief timeout.
//
// The 30s cap existed in FOUR independent copies: this module,
// commands/_agent-brief-cli.ts, commands/glossary.ts (via that export) and
// commands/expert.ts — the last with the literal "30 s" baked into its error
// string, so it would have reported the wrong number the moment its own
// constant moved. Fixing one left the others capping every brief they serve.
// Written as what CANNOT pass: any NEW hardcoded brief timeout re-fails this.
// ---------------------------------------------------------------------------

describe("brief timeout has one definition", () => {
  it("no CLI command declares its own 30-second brief timeout", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];
    const glob = new Glob("**/*.ts");
    for await (const rel of glob.scan({ cwd: `${import.meta.dir}/..` })) {
      if (rel.endsWith(".test.ts")) continue;
      const path = `${import.meta.dir}/../${rel}`;
      const src = await Bun.file(path).text();
      // A local timeout constant sized in the 30s range, or an error string
      // that hardcodes the duration instead of formatting the real value.
      // Bare `TIMEOUT_MS` only: a prefixed constant like doctor.ts's
      // FIX_KEYRING_EXEC_TIMEOUT_MS is an unrelated spawn budget, not a brief cap.
      if (
        /^\s*(?:export\s+)?const TIMEOUT_MS\s*=\s*30_000/m.test(src) ||
        /timed out after 30 s/.test(src)
      ) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
