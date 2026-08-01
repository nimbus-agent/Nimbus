import { describe, expect, test } from "bun:test";
import {
  assertPayloadWithinLimit,
  buildBlobQuery,
  buildCommitInput,
  classifyMutationResult,
  createGraphQLClient,
  type DesiredFile,
  encodeContents,
  type FileChanges,
  type GraphQLClient,
  type GraphQLResponse,
  gitBlobOid,
  isStaleHeadError,
  parseAddSpec,
  parseBlobQueryResult,
  parseCliArgs,
  parseNameWithOwner,
  payloadByteLength,
  planFileChanges,
  publishSignedCommit,
  qualifyBranch,
  toRepoPath,
} from "./signed-commit.ts";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Blob oids verified against `git hash-object --stdin` on a real git. */
const OID_EMPTY = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const OID_HELLO_NL = "ce013625030ba8dba906f756967f9e9ca394464a";
const OID_DOC = "bd9dbf5aae1a3862dd1526723246b20206e5fc37";

describe("gitBlobOid", () => {
  test("matches git's own object ids for known vectors", () => {
    expect(gitBlobOid(new Uint8Array(0))).toBe(OID_EMPTY);
    expect(gitBlobOid(bytes("hello\n"))).toBe(OID_HELLO_NL);
    expect(gitBlobOid(bytes("what is up, doc?"))).toBe(OID_DOC);
  });

  test("hashes raw bytes, so binary content with NULs and 0xFF is handled", () => {
    const binary = new Uint8Array([0x00, 0xff, 0x0a, 0x0d, 0x00, 0x80]);
    // Same value git would produce: sha1("blob 6\0" + those bytes).
    expect(gitBlobOid(binary)).toMatch(/^[0-9a-f]{40}$/);
    // Distinct content must not collide with a text-truncated-at-NUL reading.
    expect(gitBlobOid(binary)).not.toBe(gitBlobOid(new Uint8Array([0x00])));
  });
});

describe("toRepoPath", () => {
  test("converts Windows separators to the forward slashes the API requires", () => {
    expect(toRepoPath("Formula\\nimbus.rb")).toBe("Formula/nimbus.rb");
    expect(toRepoPath("bucket\\sub\\nimbus.json")).toBe("bucket/sub/nimbus.json");
  });
  test("strips a leading ./ or /", () => {
    expect(toRepoPath("./Formula/nimbus.rb")).toBe("Formula/nimbus.rb");
    expect(toRepoPath("/Formula/nimbus.rb")).toBe("Formula/nimbus.rb");
  });
  test("leaves an already-clean path alone", () => {
    expect(toRepoPath("bucket/nimbus.json")).toBe("bucket/nimbus.json");
  });
});

describe("encodeContents", () => {
  test("base64-encodes text", () => {
    expect(encodeContents(bytes("hello"))).toBe("aGVsbG8=");
  });
  test("round-trips arbitrary binary bytes", () => {
    const binary = new Uint8Array([0, 1, 2, 253, 254, 255, 0, 128]);
    const decoded = new Uint8Array(Buffer.from(encodeContents(binary), "base64"));
    expect([...decoded]).toEqual([...binary]);
  });
});

describe("planFileChanges", () => {
  const formula: DesiredFile = { path: "Formula/nimbus.rb", contents: bytes("hello\n") };

  test("adds a file that does not exist on the branch", () => {
    const plan = planFileChanges([formula], [], new Map([["Formula/nimbus.rb", null]]));
    expect(plan.isNoOp).toBe(false);
    expect(plan.changes.additions).toEqual([
      { path: "Formula/nimbus.rb", contents: encodeContents(bytes("hello\n")) },
    ]);
    expect(plan.changes.deletions).toBeUndefined();
  });

  test("adds a file whose remote blob oid differs", () => {
    const plan = planFileChanges([formula], [], new Map([["Formula/nimbus.rb", OID_DOC]]));
    expect(plan.isNoOp).toBe(false);
    expect(plan.changes.additions).toHaveLength(1);
  });

  test("is a no-op when the remote blob oid already matches the desired content", () => {
    const plan = planFileChanges([formula], [], new Map([["Formula/nimbus.rb", OID_HELLO_NL]]));
    expect(plan.isNoOp).toBe(true);
    expect(plan.unchanged).toEqual(["Formula/nimbus.rb"]);
    expect(plan.changes.additions).toBeUndefined();
  });

  test("normalizes Windows-separator desired paths before comparing and sending", () => {
    const plan = planFileChanges(
      [{ path: "Formula\\nimbus.rb", contents: bytes("hello\n") }],
      [],
      new Map([["Formula/nimbus.rb", OID_HELLO_NL]]),
    );
    expect(plan.isNoOp).toBe(true);
  });

  test("puts deletions in their own array, never mixed into additions", () => {
    const plan = planFileChanges([], ["old/nimbus.rb"], new Map([["old/nimbus.rb", OID_DOC]]));
    expect(plan.changes.deletions).toEqual([{ path: "old/nimbus.rb" }]);
    expect(plan.changes.additions).toBeUndefined();
    expect(plan.isNoOp).toBe(false);
  });

  test("drops a deletion for a path that is not on the branch (the API errors on it)", () => {
    const plan = planFileChanges([], ["gone.rb"], new Map([["gone.rb", null]]));
    expect(plan.changes.deletions).toBeUndefined();
    expect(plan.alreadyAbsent).toEqual(["gone.rb"]);
    expect(plan.isNoOp).toBe(true);
  });

  test("emits additions and deletions together when both apply", () => {
    const plan = planFileChanges(
      [formula],
      ["old.rb"],
      new Map([
        ["Formula/nimbus.rb", null],
        ["old.rb", OID_DOC],
      ]),
    );
    expect(plan.changes.additions).toHaveLength(1);
    expect(plan.changes.deletions).toEqual([{ path: "old.rb" }]);
  });
});

describe("assertPayloadWithinLimit", () => {
  const changes: FileChanges = { additions: [{ path: "a", contents: "x".repeat(1000) }] };

  test("passes under the ceiling", () => {
    expect(() => assertPayloadWithinLimit(changes, 10_000)).not.toThrow();
  });
  test("throws an actionable error over the ceiling", () => {
    expect(() => assertPayloadWithinLimit(changes, 100)).toThrow(/over the .* MiB ceiling/);
  });
  test("measures the base64 payload, not the source bytes", () => {
    expect(payloadByteLength(changes)).toBeGreaterThan(1000);
  });
});

describe("buildCommitInput", () => {
  test("produces the exact CreateCommitOnBranchInput wire shape", () => {
    const input = buildCommitInput({
      nameWithOwner: "nimbus-agent/homebrew-tap",
      branchName: "main",
      expectedHeadOid: "a".repeat(40),
      message: { headline: "nimbus 1.5.0" },
      changes: { additions: [{ path: "Formula/nimbus.rb", contents: "aGk=" }] },
    });
    expect(input).toEqual({
      branch: { repositoryNameWithOwner: "nimbus-agent/homebrew-tap", branchName: "main" },
      expectedHeadOid: "a".repeat(40),
      message: { headline: "nimbus 1.5.0" },
      fileChanges: { additions: [{ path: "Formula/nimbus.rb", contents: "aGk=" }] },
    });
  });
});

describe("isStaleHeadError / classifyMutationResult", () => {
  test("recognizes the STALE_DATA error type", () => {
    expect(isStaleHeadError([{ message: "whatever", type: "STALE_DATA" }])).toBe(true);
  });
  test("recognizes the expectedHeadOid mismatch message wordings", () => {
    expect(
      isStaleHeadError([{ message: 'Expected branch to point to "abc" but it did not.' }]),
    ).toBe(true);
    expect(isStaleHeadError([{ message: "main is at def456 but expected abc123" }])).toBe(true);
  });
  test("does NOT treat an unrelated error as stale (that would retry forever)", () => {
    expect(isStaleHeadError([{ message: "Resource not accessible by integration" }])).toBe(false);
  });

  test("classifies a successful mutation as ok with the commit oid", () => {
    const res: GraphQLResponse = {
      data: { createCommitOnBranch: { commit: { oid: "deadbeef", url: "u" } } },
    };
    expect(classifyMutationResult(res)).toEqual({ kind: "ok", oid: "deadbeef" });
  });
  test("classifies a stale-head failure as retryable", () => {
    const out = classifyMutationResult({ errors: [{ message: "x", type: "STALE_DATA" }] });
    expect(out.kind).toBe("stale");
  });
  test("classifies a permission failure as fatal", () => {
    const out = classifyMutationResult({
      errors: [{ message: "Resource not accessible by integration" }],
    });
    expect(out.kind).toBe("error");
  });
  test("classifies a missing commit oid as fatal rather than silently succeeding", () => {
    expect(classifyMutationResult({ data: { createCommitOnBranch: null } }).kind).toBe("error");
  });
});

describe("buildBlobQuery / parseBlobQueryResult", () => {
  test("passes paths as variables, aliased one per file", () => {
    const q = buildBlobQuery("nimbus-agent", "homebrew-tap", "abc123", [
      "Formula/nimbus.rb",
      "README.md",
    ]);
    expect(q.variables["e0"]).toBe("abc123:Formula/nimbus.rb");
    expect(q.variables["e1"]).toBe("abc123:README.md");
    expect(q.query).toContain("b0: object(expression:$e0)");
    expect(q.query).toContain("b1: object(expression:$e1)");
    // The path itself must never be interpolated into the document.
    expect(q.query).not.toContain("Formula/nimbus.rb");
  });
  test("normalizes Windows separators inside the expression variable", () => {
    const q = buildBlobQuery("o", "n", "abc", ["Formula\\nimbus.rb"]);
    expect(q.variables["e0"]).toBe("abc:Formula/nimbus.rb");
  });
  test("maps aliased results back onto paths, null when the blob is absent", () => {
    const map = parseBlobQueryResult({ repository: { b0: { oid: "aaa" }, b1: null } }, [
      "a.rb",
      "b.rb",
    ]);
    expect(map.get("a.rb")).toBe("aaa");
    expect(map.get("b.rb")).toBeNull();
  });
});

describe("parseNameWithOwner / qualifyBranch", () => {
  test("splits owner/name", () => {
    expect(parseNameWithOwner("nimbus-agent/scoop-bucket")).toEqual({
      owner: "nimbus-agent",
      name: "scoop-bucket",
    });
  });
  test("rejects a malformed repo", () => {
    expect(() => parseNameWithOwner("scoop-bucket")).toThrow(/owner\/name/);
    expect(() => parseNameWithOwner("a/b/c")).toThrow(/owner\/name/);
  });
  test("qualifies a bare branch name and leaves a qualified one alone", () => {
    expect(qualifyBranch("main")).toBe("refs/heads/main");
    expect(qualifyBranch("refs/heads/main")).toBe("refs/heads/main");
  });
});

describe("parseAddSpec / parseCliArgs", () => {
  test("splits --add on the first = so a local path may contain one", () => {
    expect(parseAddSpec("Formula/nimbus.rb=out/a=b.rb")).toEqual({
      repoPath: "Formula/nimbus.rb",
      localPath: "out/a=b.rb",
    });
  });
  test("rejects an --add without both halves", () => {
    expect(() => parseAddSpec("Formula/nimbus.rb")).toThrow(/--add expects/);
    expect(() => parseAddSpec("=out/nimbus.rb")).toThrow(/--add expects/);
  });
  test("parses a full publish invocation", () => {
    const args = parseCliArgs([
      "--repo",
      "nimbus-agent/homebrew-tap",
      "--message",
      "nimbus 1.5.0",
      "--add",
      "Formula/nimbus.rb=out/nimbus.rb",
    ]);
    expect(args.repo).toBe("nimbus-agent/homebrew-tap");
    expect(args.headline).toBe("nimbus 1.5.0");
    expect(args.branch).toBeUndefined();
    expect(args.adds).toEqual([{ repoPath: "Formula/nimbus.rb", localPath: "out/nimbus.rb" }]);
  });
  test("requires --repo, --message and at least one change", () => {
    expect(() => parseCliArgs(["--message", "m", "--add", "a=b"])).toThrow(/--repo/);
    expect(() => parseCliArgs(["--repo", "o/n", "--add", "a=b"])).toThrow(/--message/);
    expect(() => parseCliArgs(["--repo", "o/n", "--message", "m"])).toThrow(/--add or --delete/);
  });
  test("rejects an unknown flag instead of silently ignoring it", () => {
    expect(() => parseCliArgs(["--repo", "o/n", "--force", "yes"])).toThrow(/unknown flag/);
  });
});

// ---------------------------------------------------------------------------
// Orchestration: read → plan → mutate, with the stale-head retry.
// ---------------------------------------------------------------------------

interface Call {
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

/** A scripted GraphQL client: head reads answer from `heads`, mutations from `mutationResults`. */
function scriptedClient(opts: {
  heads: readonly string[];
  blobOids: readonly (string | null)[];
  mutationResults: readonly GraphQLResponse[];
  calls: Call[];
}): GraphQLClient {
  let headIdx = 0;
  let blobIdx = 0;
  let mutIdx = 0;
  return {
    request(query, variables) {
      opts.calls.push({ query, variables });
      if (query.includes("createCommitOnBranch")) {
        const res = opts.mutationResults[mutIdx++];
        if (res === undefined) throw new Error("test: unexpected extra mutation");
        return Promise.resolve(res);
      }
      if (query.includes("object(expression")) {
        const oid = opts.blobOids[blobIdx++] ?? null;
        return Promise.resolve({ data: { repository: { b0: oid === null ? null : { oid } } } });
      }
      const head = opts.heads[headIdx++];
      if (head === undefined) throw new Error("test: unexpected extra head read");
      return Promise.resolve({
        data: { repository: { defaultBranchRef: { name: "main", target: { oid: head } } } },
      });
    },
  };
}

describe("publishSignedCommit", () => {
  const file: DesiredFile = { path: "Formula/nimbus.rb", contents: bytes("hello\n") };

  test("commits with the head oid it just read as expectedHeadOid", async () => {
    const calls: Call[] = [];
    const client = scriptedClient({
      heads: ["head1"],
      blobOids: [null],
      mutationResults: [{ data: { createCommitOnBranch: { commit: { oid: "new1" } } } }],
      calls,
    });
    const result = await publishSignedCommit({
      client,
      repo: "nimbus-agent/homebrew-tap",
      message: { headline: "nimbus 1.5.0" },
      files: [file],
      log: () => {},
    });
    expect(result).toEqual({ status: "committed", oid: "new1", attempts: 1 });
    const mutation = calls.find((c) => c.query.includes("createCommitOnBranch"));
    const input = mutation?.variables["input"] as { expectedHeadOid: string; branch: unknown };
    expect(input.expectedHeadOid).toBe("head1");
    expect(input.branch).toEqual({
      repositoryNameWithOwner: "nimbus-agent/homebrew-tap",
      branchName: "main",
    });
  });

  test("skips the mutation entirely when the branch already has the content", async () => {
    const calls: Call[] = [];
    const client = scriptedClient({
      heads: ["head1"],
      blobOids: [OID_HELLO_NL],
      mutationResults: [],
      calls,
    });
    const result = await publishSignedCommit({
      client,
      repo: "nimbus-agent/homebrew-tap",
      message: { headline: "nimbus 1.5.0" },
      files: [file],
      log: () => {},
    });
    expect(result).toEqual({ status: "unchanged", attempts: 1 });
    expect(calls.some((c) => c.query.includes("createCommitOnBranch"))).toBe(false);
  });

  test("re-reads the head and retries when the mutation reports a stale head", async () => {
    const calls: Call[] = [];
    const client = scriptedClient({
      heads: ["head1", "head2"],
      blobOids: [null, null],
      mutationResults: [
        { errors: [{ message: 'Expected branch to point to "head1" but it did not.' }] },
        { data: { createCommitOnBranch: { commit: { oid: "new2" } } } },
      ],
      calls,
    });
    const result = await publishSignedCommit({
      client,
      repo: "nimbus-agent/homebrew-tap",
      message: { headline: "nimbus 1.5.0" },
      files: [file],
      log: () => {},
    });
    expect(result).toEqual({ status: "committed", oid: "new2", attempts: 2 });
    const oids = calls
      .filter((c) => c.query.includes("createCommitOnBranch"))
      .map((c) => (c.variables["input"] as { expectedHeadOid: string }).expectedHeadOid);
    // The retry must use the RE-READ head, never the stale one, and never force.
    expect(oids).toEqual(["head1", "head2"]);
  });

  test("collapses to unchanged if the racing writer already wrote our exact content", async () => {
    const calls: Call[] = [];
    const client = scriptedClient({
      heads: ["head1", "head2"],
      blobOids: [null, OID_HELLO_NL],
      mutationResults: [{ errors: [{ message: "x", type: "STALE_DATA" }] }],
      calls,
    });
    const result = await publishSignedCommit({
      client,
      repo: "nimbus-agent/homebrew-tap",
      message: { headline: "nimbus 1.5.0" },
      files: [file],
      log: () => {},
    });
    expect(result).toEqual({ status: "unchanged", attempts: 2 });
  });

  test("gives up after maxAttempts instead of forcing", async () => {
    const stale: GraphQLResponse = { errors: [{ message: "x", type: "STALE_DATA" }] };
    const client = scriptedClient({
      heads: ["h1", "h2"],
      blobOids: [null, null],
      mutationResults: [stale, stale],
      calls: [],
    });
    await expect(
      publishSignedCommit({
        client,
        repo: "nimbus-agent/homebrew-tap",
        message: { headline: "m" },
        files: [file],
        maxAttempts: 2,
        log: () => {},
      }),
    ).rejects.toThrow(/kept moving after 2 attempts/);
  });

  test("fails loudly on a non-stale error rather than retrying", async () => {
    const client = scriptedClient({
      heads: ["h1"],
      blobOids: [null],
      mutationResults: [{ errors: [{ message: "Resource not accessible by integration" }] }],
      calls: [],
    });
    await expect(
      publishSignedCommit({
        client,
        repo: "nimbus-agent/homebrew-tap",
        message: { headline: "m" },
        files: [file],
        log: () => {},
      }),
    ).rejects.toThrow(/Resource not accessible by integration/);
  });

  test("refuses an oversized payload before it reaches the API", async () => {
    const client = scriptedClient({
      heads: ["h1"],
      blobOids: [null],
      mutationResults: [],
      calls: [],
    });
    await expect(
      publishSignedCommit({
        client,
        repo: "nimbus-agent/linux-repo",
        message: { headline: "m" },
        files: [{ path: "yum/nimbus.rpm", contents: new Uint8Array(4096) }],
        maxPayloadBytes: 512,
        log: () => {},
      }),
    ).rejects.toThrow(/MiB ceiling/);
  });
});

describe("createGraphQLClient", () => {
  test("POSTs the query + variables with bearer auth and the api-version header", async () => {
    let captured: { url: string | undefined; init: RequestInit | undefined } = {
      url: undefined,
      init: undefined,
    };
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createGraphQLClient({ token: "t0", fetchFn });
    const res = await client.request("query{x}", { a: 1 });
    expect(captured.url).toBe("https://api.github.com/graphql");
    expect(captured.init?.method).toBe("POST");
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer t0");
    expect(headers["x-github-api-version"]).toBe("2022-11-28");
    expect(JSON.parse(String(captured.init?.body))).toEqual({
      query: "query{x}",
      variables: { a: 1 },
    });
    expect(res.data).toEqual({ ok: true });
  });

  test("throws on a non-200 transport failure", async () => {
    const fetchFn = (async () =>
      new Response("bad credentials", { status: 401 })) as unknown as typeof fetch;
    const client = createGraphQLClient({ token: "t", fetchFn });
    await expect(client.request("query{x}", {})).rejects.toThrow(/HTTP 401/);
  });

  test("normalizes GraphQL errors into {message,type}", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "nope", type: "STALE_DATA" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const client = createGraphQLClient({ token: "t", fetchFn });
    const res = await client.request("mutation{x}", {});
    expect(res.errors).toEqual([{ message: "nope", type: "STALE_DATA" }]);
  });
});
