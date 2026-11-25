import { afterEach, describe, expect, test } from "bun:test";

import { BASELINE_KEYS } from "../extensions/spawn-env.ts";
import {
  GIT_GLOBAL_ARGS,
  GIT_OUTPUT_CAP_BYTES,
  LOG_ARGS,
  LOG_MAX_COMMITS,
  LS_FILES_ARGS,
  parseLog,
  parseLsFiles,
  parseRevParse,
  REV_PARSE_ARGS,
  readGitHistory,
  runGit,
  type SpawnFn,
} from "./git-history.ts";

const H = (secs: number): string => `\u0001${String(secs)}`;
const M = (status = "M"): string => `:100644 100644 abc1234 def5678 ${status}`;

/** One commit as `git log --raw -z --pretty=format:%x01%ct` prints it. */
function commit(secs: number, ...paths: string[]): string {
  // Real shape: the header ends in a newline and the first meta rides on its token.
  const [first, ...rest] = paths;
  if (first === undefined) return H(secs);
  return [`${H(secs)}\n${M()}`, first, ...rest.flatMap((p) => [M(), p])].join("\0");
}

type Call = { argv: string[]; opts: Record<string, unknown>; killed: boolean };

function fakeSpawn(
  script: (sub: string) => { out: string | Uint8Array[]; code?: number },
  calls: Call[] = [],
): SpawnFn {
  return ((argv: string[], opts: Record<string, unknown>) => {
    const call: Call = { argv, opts, killed: false };
    calls.push(call);
    const sub = argv.slice(argv.indexOf("--no-pager") + 1)[0] as string;
    const { out, code } = script(sub);
    const chunks = typeof out === "string" ? [new TextEncoder().encode(out)] : out;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(ch);
        c.close();
      },
    });
    return {
      stdout: stream,
      exited: Promise.resolve(code ?? 0),
      kill: () => {
        call.killed = true;
      },
    };
  }) as unknown as SpawnFn;
}

describe("parseLog", () => {
  test("keeps the NEWEST time per path and the oldest commit read", () => {
    const out = [commit(3000, "a.ts", "b.ts"), commit(2000, "a.ts"), commit(1000, "c.ts")].join(
      "\0",
    );
    const p = parseLog(out, false);
    expect(p.lastTouchMs.get("a.ts")).toBe(3_000_000);
    expect(p.lastTouchMs.get("b.ts")).toBe(3_000_000);
    expect(p.lastTouchMs.get("c.ts")).toBe(1_000_000);
    expect(p.oldestCommitMs).toBe(1_000_000);
    expect(p.commits).toBe(3);
  });

  test("a file NAMED like a header or a meta line cannot forge a time or a path", () => {
    const hostile = [
      H(9_999_999_999), // a header-shaped path in FIRST position: must stay a path
      "real.ts",
      H(8_888_888_888), // a header-shaped path later in the commit
      M(), // a meta-shaped path
      `${H(7_777_777_777)}
${M()}`, // the exact shape of a header token with a riding meta
    ];
    const out = [commit(1000, ...hostile)].join("\0");
    const p = parseLog(out, false);
    expect(p.commits).toBe(1);
    expect(p.oldestCommitMs).toBe(1_000_000);
    expect([...p.lastTouchMs.keys()].sort()).toEqual([...hostile].sort());
    for (const v of p.lastTouchMs.values()) expect(v).toBe(1_000_000);
  });

  test("a merge commit with no files still counts as a commit", () => {
    const out = [commit(2000), commit(1000, "a.ts")].join("\0");
    expect(parseLog(out, false).commits).toBe(2);
  });

  test("a truncated log drops the cut token and the last commit's time from the oldest", () => {
    const out = [commit(3000, "a.ts"), commit(2000, "b.ts"), H(1000), M(), "c.t"].join("\0");
    const p = parseLog(out, true);
    // "c.t" (cut) is dropped, so the final meta has no path; the 1000 commit is left out of `oldest`.
    expect(p.lastTouchMs.has("c.t")).toBe(false);
    expect(p.oldestCommitMs).toBe(2_000_000);
    expect(p.lastTouchMs.get("b.ts")).toBe(2_000_000);
  });

  test("a very long log does not overflow the call stack", () => {
    const out = Array.from({ length: 200_000 }, (_, i) => H(1_000_000 - i)).join("\0");
    expect(parseLog(out, false)).toMatchObject({ commits: 200_000, oldestCommitMs: 800_001_000 });
  });

  test("an empty log has no oldest commit", () => {
    expect(parseLog("", false)).toMatchObject({ oldestCommitMs: null, commits: 0 });
  });
});

describe("small parsers", () => {
  test("parseLsFiles splits on NUL and ignores empties", () => {
    expect([...parseLsFiles("a b.ts\0dir/c.ts\0")]).toEqual(["a b.ts", "dir/c.ts"]);
  });
  test("parseRevParse reads the shallow flag and the prefix", () => {
    expect(parseRevParse("false\nsub/dir/\n")).toEqual({ shallow: false, prefix: "sub/dir/" });
    expect(parseRevParse("true\n\n")).toEqual({ shallow: true, prefix: "" });
    expect(parseRevParse("false")).toEqual({ shallow: false, prefix: "" });
    expect(parseRevParse("fatal: nope")).toBeNull();
  });
});

describe("runGit: how the child is spawned", () => {
  const saved = process.env["ANTHROPIC_API_KEY"];
  afterEach(() => {
    if (saved === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = saved;
  });

  test("argv is `git -C <root>` + the constant globals + a constant subcommand, with no pathspec", async () => {
    const calls: Call[] = [];
    await readGitHistory(
      "/the/root",
      fakeSpawn((sub) => {
        if (sub === "rev-parse") return { out: "false\n\n" };
        if (sub === "ls-files") return { out: "a.ts\0" };
        return { out: commit(1000, "a.ts") };
      }, calls),
    );
    expect(calls.map((c) => c.argv)).toEqual([
      ["git", "-C", "/the/root", ...GIT_GLOBAL_ARGS, ...REV_PARSE_ARGS],
      ["git", "-C", "/the/root", ...GIT_GLOBAL_ARGS, ...LS_FILES_ARGS],
      ["git", "-C", "/the/root", ...GIT_GLOBAL_ARGS, ...LOG_ARGS],
    ]);
    expect(LOG_ARGS).not.toContain("--");
    expect(LOG_ARGS).toContain(`--max-count=${String(LOG_MAX_COMMITS)}`);
    for (const c of calls) expect(c.opts).toMatchObject({ windowsHide: true, stdin: "ignore" });
  });

  test("the child env is the I1 baseline plus constant GIT_ and locale keys; a gateway secret never reaches it", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-test-secret";
    const calls: Call[] = [];
    await runGit(
      "/r",
      ["rev-parse"],
      fakeSpawn(() => ({ out: "" }), calls),
    );
    const env = calls[0]?.opts["env"] as Record<string, string>;
    expect(env["ANTHROPIC_API_KEY"]).toBeUndefined();
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["GIT_OPTIONAL_LOCKS"]).toBe("0");
    const allowed = new Set<string>([
      ...BASELINE_KEYS,
      "GIT_TERMINAL_PROMPT",
      "GIT_OPTIONAL_LOCKS",
      "LC_ALL",
    ]);
    expect(Object.keys(env).filter((k) => !allowed.has(k))).toEqual([]);
  });

  test("output past the byte cap kills the child and is reported truncated", async () => {
    const calls: Call[] = [];
    const big = new Uint8Array(GIT_OUTPUT_CAP_BYTES);
    const r = await runGit(
      "/r",
      ["log"],
      fakeSpawn(() => ({ out: [big, new Uint8Array(10)] }), calls),
    );
    expect(r.truncated).toBe(true);
    expect(calls[0]?.killed).toBe(true);
    expect(r.out).toHaveLength(GIT_OUTPUT_CAP_BYTES);
  });

  test("a spawn failure never throws", async () => {
    const boom = (() => {
      throw new Error("ENOENT");
    }) as unknown as SpawnFn;
    expect(await runGit("/r", ["log"], boom)).toMatchObject({ code: -1, out: "" });
  });
});

describe("readGitHistory", () => {
  const ok = (sub: string): { out: string } => {
    if (sub === "rev-parse") return { out: "false\nsub/\n" };
    if (sub === "ls-files") return { out: "x.ts\0y.ts\0" };
    return { out: commit(2000, "x.ts") };
  };

  test("assembles prefix, tracked set, last touch and completeness", async () => {
    const r = await readGitHistory("/r", fakeSpawn(ok));
    expect(r).toMatchObject({
      ok: true,
      history: { prefix: "sub/", complete: true, oldestCommitMs: 2_000_000 },
    });
    if (r.ok) {
      expect([...r.history.tracked]).toEqual(["x.ts", "y.ts"]);
      expect(r.history.lastTouchMs.get("x.ts")).toBe(2_000_000);
    }
  });

  test("hitting the commit cap is an incomplete history", async () => {
    const many = Array.from({ length: LOG_MAX_COMMITS }, (_, i) => commit(5000 - (i % 4000))).join(
      "\0",
    );
    const r = await readGitHistory(
      "/r",
      fakeSpawn((sub) => (sub === "log" ? { out: many } : ok(sub))),
    );
    expect(r).toMatchObject({ ok: true, history: { complete: false } });
  });

  test("a shallow clone, a non-repo, a failed ls-files or log are reported by reason", async () => {
    expect(
      await readGitHistory(
        "/r",
        fakeSpawn((s) => (s === "rev-parse" ? { out: "true\n\n" } : ok(s))),
      ),
    ).toEqual({ ok: false, reason: "shallow" });
    expect(
      await readGitHistory(
        "/r",
        fakeSpawn((s) => (s === "rev-parse" ? { out: "", code: 128 } : ok(s))),
      ),
    ).toEqual({ ok: false, reason: "not_a_repo" });
    expect(
      await readGitHistory(
        "/r",
        fakeSpawn((s) => (s === "rev-parse" ? { out: "junk\n" } : ok(s))),
      ),
    ).toEqual({ ok: false, reason: "not_a_repo" });
    expect(
      await readGitHistory(
        "/r",
        fakeSpawn((s) => (s === "ls-files" ? { out: "", code: 1 } : ok(s))),
      ),
    ).toEqual({ ok: false, reason: "git_failed" });
    expect(
      await readGitHistory(
        "/r",
        fakeSpawn((s) => (s === "log" ? { out: "", code: 128 } : ok(s))),
      ),
    ).toEqual({ ok: false, reason: "git_failed" });
    const boom = (() => {
      throw new Error("ENOENT");
    }) as unknown as SpawnFn;
    expect(await readGitHistory("/r", boom)).toEqual({ ok: false, reason: "git_failed" });
  });

  test("a tracked list past the byte cap is too_large", async () => {
    const big = new Uint8Array(GIT_OUTPUT_CAP_BYTES);
    const r = await readGitHistory(
      "/r",
      fakeSpawn((s) => (s === "ls-files" ? { out: [big, new Uint8Array(5)] } : ok(s))),
    );
    expect(r).toEqual({ ok: false, reason: "too_large" });
  });
});
