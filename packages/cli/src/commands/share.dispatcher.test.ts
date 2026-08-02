import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureOutput } from "../../test/helpers/cli-output.ts";
import {
  parseShareArgs,
  resolveVerifyShareRequest,
  runShare,
  runShareCommand,
  runVerifyShare,
  runVerifyShareCommand,
  type ShareCommand,
  type ShareCreateArgs,
  type ShareIpc,
} from "./share.ts";

interface Call {
  method: string;
  params?: unknown;
}

function fakeClient(result: unknown = {}): { client: ShareIpc; calls: Call[] } {
  const calls: Call[] = [];
  const client: ShareIpc = {
    call: async <T>(method: string, params?: unknown): Promise<T> => {
      calls.push({ method, params });
      return result as T;
    },
  };
  return { client, calls };
}

const out = captureOutput();

beforeEach(() => {
  out.reset();
  process.exitCode = 0;
});
afterEach(() => {
  // A leaked non-zero exitCode would fail the whole `bun test` run (see bun-test-exit-code-leak).
  process.exitCode = 0;
});
afterAll(() => {
  out.restore();
  process.exitCode = 0;
});

describe("parseShareArgs", () => {
  test("create requires a session id", () => {
    expect(() => parseShareArgs(["create"])).toThrow(
      "Usage: nimbus share create <session-id> [--out <file> | --http | --to-peer <id>]",
    );
  });

  test("create carries the parsed create args through", () => {
    const cmd = parseShareArgs(["create", "s-9", "--http", "--as-recipe"]);
    expect(cmd).toEqual({
      kind: "create",
      create: {
        sessionId: "s-9",
        sink: { type: "http" },
        expiresMs: null,
        redact: [],
        asRecipe: true,
      },
    });
  });

  test("create propagates a malformed-option error instead of crashing later", () => {
    expect(() => parseShareArgs(["create", "s-1", "--out"])).toThrow("--out requires a value");
  });

  test("create rejects a flag-shaped session id instead of dialing the gateway with it", () => {
    // The session id is positional: with the id omitted, `--out`/`--http`/`--to-peer` would each
    // be bound as the session id and pass a bare `length === 0` check, so `runShare` would open an
    // IPC connection and call share.create with a bogus session. Each must hit CREATE_USAGE.
    for (const argv of [
      ["create", "--out", "f.json"],
      ["create", "--http"],
      ["create", "--to-peer", "peer-1"],
      ["create", "--as-recipe"],
    ]) {
      expect(() => parseShareArgs(argv)).toThrow(
        "Usage: nimbus share create <session-id> [--out <file> | --http | --to-peer <id>]",
      );
    }
  });

  test("list / inbox pick up --all", () => {
    expect(parseShareArgs(["list"])).toEqual({ kind: "list", all: false });
    expect(parseShareArgs(["list", "--all"])).toEqual({ kind: "list", all: true });
    expect(parseShareArgs(["inbox"])).toEqual({ kind: "inbox", all: false });
    expect(parseShareArgs(["inbox", "--all"])).toEqual({ kind: "inbox", all: true });
  });

  test("prune and pubkey take no arguments", () => {
    expect(parseShareArgs(["prune"])).toEqual({ kind: "prune" });
    expect(parseShareArgs(["pubkey"])).toEqual({ kind: "pubkey" });
  });

  test("approve / reject map onto the approval command", () => {
    expect(parseShareArgs(["approve", "req-1"])).toEqual({
      kind: "approval",
      approve: true,
      requestId: "req-1",
    });
    expect(parseShareArgs(["reject", "req-2"])).toEqual({
      kind: "approval",
      approve: false,
      requestId: "req-2",
    });
  });

  test("approve / reject reject a missing or flag-shaped request id", () => {
    expect(() => parseShareArgs(["approve"])).toThrow("Usage: nimbus share approve <request-id>");
    expect(() => parseShareArgs(["reject", "--all"])).toThrow(
      "Usage: nimbus share reject <request-id>",
    );
  });

  test("forward needs a content hash and a --to-peer value", () => {
    expect(parseShareArgs(["forward", "abc", "--to-peer", "peer-1"])).toEqual({
      kind: "forward",
      contentHash: "abc",
      peerId: "peer-1",
    });
    expect(() => parseShareArgs(["forward"])).toThrow(
      "Usage: nimbus share forward <contentHash> --to-peer <peerId>",
    );
    expect(() => parseShareArgs(["forward", "--to-peer", "p"])).toThrow(
      "Usage: nimbus share forward <contentHash> --to-peer <peerId>",
    );
    expect(() => parseShareArgs(["forward", "abc"])).toThrow(
      "Usage: nimbus share forward <contentHash> --to-peer <peerId>",
    );
    expect(() => parseShareArgs(["forward", "abc", "--to-peer", "--http"])).toThrow(
      "Usage: nimbus share forward <contentHash> --to-peer <peerId>",
    );
  });

  test("an unknown or absent subcommand throws the top-level usage", () => {
    expect(() => parseShareArgs(["bogus"])).toThrow(
      "Usage: nimbus share <create|list|prune|pubkey|approve|reject|forward|inbox> ...",
    );
    expect(() => parseShareArgs([])).toThrow(
      "Usage: nimbus share <create|list|prune|pubkey|approve|reject|forward|inbox> ...",
    );
  });
});

describe("runShareCommand — create", () => {
  const createArgs: ShareCreateArgs = {
    sessionId: "s-1",
    sink: { type: "file", path: "x.json" },
    expiresMs: 1000,
    redact: ["ZURICH"],
    asRecipe: false,
  };
  const create: ShareCommand = { kind: "create", create: createArgs };

  test("ok status prints the content hash and leaves the exit code clean", async () => {
    const { client, calls } = fakeClient({ status: "ok", contentHash: "h-abc" });
    await runShareCommand(client, create);
    expect(calls[0]).toEqual({
      method: "share.create",
      params: {
        sessionId: "s-1",
        kind: "transcript",
        sink: { type: "file", path: "x.json" },
        expiresMs: 1000,
        redact: ["ZURICH"],
      },
    });
    expect(out.stdout).toContain("Shared: h-abc");
    expect(process.exitCode).toBe(0);
  });

  test("ok status without a content hash falls back to a placeholder", async () => {
    const { client } = fakeClient({ status: "ok" });
    await runShareCommand(client, create);
    expect(out.stdout).toContain("Shared: (no content hash)");
  });

  test("--as-recipe sends kind=recipe", async () => {
    const { client, calls } = fakeClient({ status: "ok", contentHash: "h" });
    await runShareCommand(client, {
      kind: "create",
      create: { ...createArgs, asRecipe: true },
    });
    expect((calls[0]?.params as { kind: string } | undefined)?.kind).toBe("recipe");
  });

  test("a denied share prints the status and sets exit code 1", async () => {
    const { client } = fakeClient({ status: "denied" });
    await runShareCommand(client, create);
    expect(out.stdout).toContain("Share denied");
    expect(process.exitCode).toBe(1);
  });
});

describe("runShareCommand — list / prune / pubkey", () => {
  test("list forwards --all as includeExpired and prints one row per share", async () => {
    const { client, calls } = fakeClient({
      shares: [
        { contentHash: "h1", kind: "transcript", createdAt: 0 },
        { contentHash: "h2", kind: "recipe", createdAt: 86_400_000 },
      ],
    });
    await runShareCommand(client, { kind: "list", all: true });
    expect(calls[0]).toEqual({ method: "share.list", params: { includeExpired: true } });
    expect(out.stdout).toContain("h1  transcript  1970-01-01T00:00:00.000Z");
    expect(out.stdout).toContain("h2  recipe  1970-01-02T00:00:00.000Z");
  });

  test("list without --all asks for the unexpired set only", async () => {
    const { client, calls } = fakeClient({ shares: [] });
    await runShareCommand(client, { kind: "list", all: false });
    expect(calls[0]).toEqual({ method: "share.list", params: { includeExpired: false } });
    expect(out.stdout).toBe("");
  });

  test("prune reports the removed count", async () => {
    const { client, calls } = fakeClient({ removed: 4 });
    await runShareCommand(client, { kind: "prune" });
    expect(calls[0]).toEqual({ method: "share.prune", params: {} });
    expect(out.stdout).toContain("Pruned 4");
  });

  test("pubkey prints the raw key", async () => {
    const { client, calls } = fakeClient({ pubkey: "BASE64PUB" });
    await runShareCommand(client, { kind: "pubkey" });
    expect(calls[0]).toEqual({ method: "share.pubkey", params: {} });
    expect(out.stdout).toContain("BASE64PUB");
  });
});

describe("runShareCommand — approve / reject", () => {
  test("approve sends approved=true and confirms", async () => {
    const { client, calls } = fakeClient({ matched: true });
    await runShareCommand(client, { kind: "approval", approve: true, requestId: "req-1" });
    expect(calls[0]).toEqual({
      method: "share.approvalRespond",
      params: { requestId: "req-1", approved: true },
    });
    expect(out.stdout).toContain("approved req-1");
  });

  test("reject sends approved=false and confirms", async () => {
    const { client, calls } = fakeClient({ matched: true });
    await runShareCommand(client, { kind: "approval", approve: false, requestId: "req-2" });
    expect(calls[0]?.params).toEqual({ requestId: "req-2", approved: false });
    expect(out.stdout).toContain("rejected req-2");
  });

  test("an unmatched request id says so instead of claiming success", async () => {
    const { client } = fakeClient({ matched: false });
    await runShareCommand(client, { kind: "approval", approve: true, requestId: "gone" });
    expect(out.stdout).toContain("no pending share request with that id");
    expect(out.stdout).not.toContain("approved gone");
  });
});

describe("runShareCommand — forward", () => {
  const cmd: ShareCommand = { kind: "forward", contentHash: "h-1", peerId: "peer-7" };

  test("delivered", async () => {
    const { client, calls } = fakeClient({ status: "ok", delivered: true });
    await runShareCommand(client, cmd);
    expect(calls[0]).toEqual({
      method: "federation.shareForward",
      params: { contentHash: "h-1", recipient: "peer-7" },
    });
    expect(out.stdout).toContain("delivered h-1");
  });

  test("queued when the recipient is not yet paired", async () => {
    const { client } = fakeClient({ status: "ok", delivered: false });
    await runShareCommand(client, cmd);
    expect(out.stdout).toContain(
      "queued h-1 (recipient not yet paired — will deliver on first pair)",
    );
  });

  test("rejected when the owner did not approve the forward", async () => {
    const { client } = fakeClient({ status: "rejected", delivered: true });
    await runShareCommand(client, cmd);
    expect(out.stdout).toContain("rejected h-1 (owner did not approve the forward)");
    expect(out.stdout).not.toContain("delivered");
  });
});

describe("runShareCommand — inbox attribution chip", () => {
  test("renders direct / one-hop / multi-hop provenance", async () => {
    const { client, calls } = fakeClient({
      inbox: [
        { contentHash: "h0", kind: "transcript", originLabel: "alice", hops: 0 },
        { contentHash: "h1", kind: "recipe", originLabel: "bob", hops: 1 },
        { contentHash: "h2", kind: "transcript", originLabel: "carol", hops: 3 },
      ],
    });
    await runShareCommand(client, { kind: "inbox", all: true });
    expect(calls[0]).toEqual({ method: "share.inbox", params: { all: true } });
    expect(out.stdout).toContain("from alice (direct)  h0  transcript");
    expect(out.stdout).toContain("forwarded from bob, 1 hop away  h1  recipe");
    expect(out.stdout).toContain("forwarded from carol, 3 hops away  h2  transcript");
  });
});

describe("runShare argument-error path", () => {
  test("a usage error prints to stderr and sets exit code 1 without contacting the gateway", async () => {
    await runShare(["bogus"]);
    expect(out.stderr).toContain(
      "Usage: nimbus share <create|list|prune|pubkey|approve|reject|forward|inbox> ...",
    );
    expect(process.exitCode).toBe(1);
  });

  test("a malformed create option is reported, not thrown as an unhandled rejection", async () => {
    await runShare(["create", "s-1", "--redact"]);
    expect(out.stderr).toContain("--redact requires a value");
    expect(process.exitCode).toBe(1);
  });

  test("an omitted session id is caught in parse, so withIpc is never entered", async () => {
    // Regression guard: `--out` used to bind as the session id, so this argv sailed past the
    // `length === 0` check and reached withIpc() — which either dials a live gateway with a bogus
    // session or rejects with "Gateway is not running" OUTSIDE the parse try/catch. Either way the
    // usage text below never appears. The whole point is that the failure stops before any IPC.
    await runShare(["create", "--out", "f.json"]);
    expect(out.stderr).toContain(
      "Usage: nimbus share create <session-id> [--out <file> | --http | --to-peer <id>]",
    );
    expect(out.stderr).not.toContain("Gateway is not running");
    expect(process.exitCode).toBe(1);
  });
});

describe("resolveVerifyShareRequest", () => {
  test("a missing input prints the usage and returns null", async () => {
    expect(await resolveVerifyShareRequest(["--replay"])).toBeNull();
    expect(out.stderr).toContain("Usage: nimbus verify-share <file|url> [--replay]");
    expect(process.exitCode).toBe(1);
  });

  test("--allow-unsigned is forwarded so the verification gate can be overridden", async () => {
    expect(
      await resolveVerifyShareRequest([
        "https://example.test/s.json",
        "--replay",
        "--allow-unsigned",
      ]),
    ).toEqual({
      replay: true,
      params: { input: "https://example.test/s.json", allowUnsigned: true },
    });
  });

  test("allowUnsigned is ABSENT unless asked for — the gate is on by default", async () => {
    const req = await resolveVerifyShareRequest(["https://example.test/s.json", "--replay"]);
    expect(req?.params).not.toHaveProperty("allowUnsigned");
  });

  test("an http(s) URL is passed through untouched", async () => {
    expect(await resolveVerifyShareRequest(["https://example.test/s.json"])).toEqual({
      replay: false,
      params: { input: "https://example.test/s.json" },
    });
    expect(await resolveVerifyShareRequest(["http://example.test/s.json", "--replay"])).toEqual({
      replay: true,
      params: { input: "http://example.test/s.json" },
    });
  });

  test("a local file is read and base64-encoded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nimbus-share-verify-"));
    try {
      const file = join(dir, "share.json");
      await writeFile(file, '{"body":1}', "utf8");
      const req = await resolveVerifyShareRequest([file, "--replay"]);
      expect(req).toEqual({
        replay: true,
        params: { bytesB64: Buffer.from('{"body":1}', "utf8").toString("base64") },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable path yields a friendly error, not a crash", async () => {
    const missing = join(tmpdir(), "nimbus-share-does-not-exist-42.json");
    expect(await resolveVerifyShareRequest([missing])).toBeNull();
    expect(out.stderr).toContain(`Cannot read share file: ${missing}`);
    expect(process.exitCode).toBe(1);
  });
});

describe("runVerifyShareCommand", () => {
  const params = { input: "https://example.test/s.json" } as const;

  test("verify prints a VALID signature line and leaves the exit code clean", async () => {
    const { client, calls } = fakeClient({
      ok: true,
      signatureValid: true,
      contentHashValid: true,
      expired: false,
      errors: [],
    });
    await runVerifyShareCommand(client, { replay: false, params });
    expect(calls[0]).toEqual({ method: "share.verify", params });
    expect(out.stdout).toContain("signature: VALID");
    expect(out.stdout).not.toContain("(expired)");
    expect(process.exitCode).toBe(0);
  });

  test("verify surfaces the errors and sets exit code 1 on an invalid share", async () => {
    const { client } = fakeClient({
      ok: false,
      signatureValid: false,
      contentHashValid: false,
      expired: true,
      errors: ["signature mismatch", "expired"],
    });
    await runVerifyShareCommand(client, { replay: false, params });
    expect(out.stdout).toContain("signature: INVALID (expired)");
    expect(out.stderr).toContain("signature mismatch; expired");
    expect(process.exitCode).toBe(1);
  });

  test("replay calls share.replay and prints the divergence report", async () => {
    const { client, calls } = fakeClient({
      verify: { ok: true, signatureValid: true, expired: false, errors: [] },
      report: {
        sourceSessionId: "s-1",
        steps: [
          {
            stepId: "step-1",
            tool: "gmail_get",
            service: "gmail",
            status: "match",
            originalStatus: "ok",
          },
        ],
        summary: {
          total: 1,
          match: 1,
          diverged: 0,
          missingConnector: 0,
          skippedNonRead: 0,
          error: 0,
        },
      },
    });
    await runVerifyShareCommand(client, { replay: true, params });
    expect(calls[0]).toEqual({ method: "share.replay", params });
    expect(out.stdout).toContain("signature: VALID");
    expect(out.stdout).toContain("Replay of session s-1 (1 steps):");
    expect(out.stdout).toContain("gmail_get");
    expect(process.exitCode).toBe(0);
  });

  test("replay of a tampered share still prints the report, then fails", async () => {
    const { client } = fakeClient({
      verify: {
        ok: false,
        signatureValid: false,
        expired: false,
        errors: ["content hash mismatch"],
      },
      report: {
        sourceSessionId: "s-2",
        steps: [],
        summary: {
          total: 0,
          match: 0,
          diverged: 0,
          missingConnector: 0,
          skippedNonRead: 0,
          error: 0,
        },
      },
    });
    await runVerifyShareCommand(client, { replay: true, params });
    expect(out.stdout).toContain("signature: INVALID");
    expect(out.stdout).toContain("(no replayable steps in this share)");
    expect(out.stderr).toContain("content hash mismatch");
    expect(process.exitCode).toBe(1);
  });
});

describe("runVerifyShare argument-error path", () => {
  test("returns before contacting the gateway when there is no input", async () => {
    await runVerifyShare([]);
    expect(out.stderr).toContain("Usage: nimbus verify-share <file|url> [--replay]");
    expect(process.exitCode).toBe(1);
  });

  test("returns before contacting the gateway when the file cannot be read", async () => {
    const missing = join(tmpdir(), "nimbus-share-absent-99.json");
    await runVerifyShare([missing]);
    expect(out.stderr).toContain(`Cannot read share file: ${missing}`);
    expect(process.exitCode).toBe(1);
  });
});
