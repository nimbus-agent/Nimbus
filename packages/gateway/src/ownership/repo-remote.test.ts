import { describe, expect, test } from "bun:test";

import {
  parseRemoteUrl,
  type RemoteSpawn,
  resolveRepoRemote,
  selectRemoteName,
} from "./repo-remote.ts";

/**
 * A `Bun.spawn` stand-in that records the argv of every call and replays a
 * queued `{ out, code }` result per call, in order (extra calls beyond the
 * queue degrade to a non-zero exit rather than throwing). Mirrors the
 * `fakeSpawn` shape in `connectors/blame-index-sync.test.ts`, extended to
 * capture calls so a test can assert a call did NOT happen — the property
 * that matters for the ambiguity short-circuit (case 3 below).
 */
function recordingSpawn(results: readonly { out: string; code: number }[]): {
  spawn: RemoteSpawn;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const spawn = ((cmd: string[]) => {
    calls.push(cmd);
    const r = results[i] ?? { out: "", code: 1 };
    i += 1;
    return {
      exited: Promise.resolve(r.code),
      stdout: new Response(r.out).body,
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as RemoteSpawn;
  return { spawn, calls };
}

/** A `Bun.spawn` stand-in that throws (ENOENT / abort), never a real spawn. */
const throwingSpawn = (() => {
  throw new Error("spawn failed");
}) as unknown as RemoteSpawn;

describe("parseRemoteUrl", () => {
  test("ssh form", () => {
    expect(parseRemoteUrl("git@github.com:nimbus-agent/Nimbus.git")).toEqual({
      service: "github",
      ownerName: "nimbus-agent/Nimbus",
    });
  });

  test("https form with .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/nimbus-agent/Nimbus.git")).toEqual({
      service: "github",
      ownerName: "nimbus-agent/Nimbus",
    });
  });

  test("https form without .git suffix", () => {
    expect(parseRemoteUrl("https://github.com/nimbus-agent/Nimbus")).toEqual({
      service: "github",
      ownerName: "nimbus-agent/Nimbus",
    });
  });

  test("gitlab and bitbucket hosts", () => {
    expect(parseRemoteUrl("git@gitlab.com:group/proj.git")?.service).toBe("gitlab");
    expect(parseRemoteUrl("https://bitbucket.org/team/repo.git")?.service).toBe("bitbucket");
  });

  test("a trailing slash is tolerated", () => {
    expect(parseRemoteUrl("https://github.com/owner/repo/")?.ownerName).toBe("owner/repo");
  });

  test("an unrecognised host yields null", () => {
    expect(parseRemoteUrl("https://git.example.com/owner/repo.git")).toBeNull();
  });

  test("garbage yields null rather than throwing", () => {
    expect(parseRemoteUrl("")).toBeNull();
    expect(parseRemoteUrl("not a url")).toBeNull();
    expect(parseRemoteUrl("https://github.com/onlyowner")).toBeNull();
  });
});

describe("selectRemoteName", () => {
  test("prefers origin whenever it exists", () => {
    expect(selectRemoteName(["upstream", "origin", "fork"])).toBe("origin");
  });

  test("uses the sole remote when origin is absent", () => {
    expect(selectRemoteName(["upstream"])).toBe("upstream");
  });

  // LOAD-BEARING: in a fork workflow `origin` is the user's fork and
  // `upstream` is canonical. Picking "the first" would bind a service to the
  // wrong repository, SILENTLY. Ambiguity must fail closed.
  test("returns null when origin is absent and two or more remotes exist", () => {
    expect(selectRemoteName(["upstream", "fork"])).toBeNull();
    expect(selectRemoteName(["a", "b", "c"])).toBeNull();
  });

  test("returns null when there are no remotes", () => {
    expect(selectRemoteName([])).toBeNull();
  });
});

// Every test below passes its fake explicitly via the injected `RemoteSpawn`
// parameter — none relies on the `Bun.spawn` default, so no test here can
// shell out to a real `git`.
describe("resolveRepoRemote", () => {
  test("origin present: returns the parsed remote and reads origin's URL", async () => {
    const { spawn, calls } = recordingSpawn([
      { out: "upstream\norigin\nfork\n", code: 0 },
      { out: "https://github.com/owner/repo.git\n", code: 0 },
    ]);
    expect(await resolveRepoRemote("/r", spawn)).toEqual({
      service: "github",
      ownerName: "owner/repo",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["git", "-C", "/r", "remote", "get-url", "origin"]);
  });

  test("no origin, exactly one other remote: that remote is used", async () => {
    const { spawn, calls } = recordingSpawn([
      { out: "upstream\n", code: 0 },
      { out: "https://github.com/owner/repo.git\n", code: 0 },
    ]);
    expect(await resolveRepoRemote("/r", spawn)).toEqual({
      service: "github",
      ownerName: "owner/repo",
    });
    expect(calls[1]).toEqual(["git", "-C", "/r", "remote", "get-url", "upstream"]);
  });

  // LOAD-BEARING: this is the short-circuit Task 6 relies on. Asserting only
  // the return value would pass even if the code wastefully (or dangerously)
  // shelled out to `get-url` on an ambiguous remote set before discarding the
  // result — so this asserts on the recorded calls too.
  test("no origin, two or more remotes: null, and get-url is never called", async () => {
    const { spawn, calls } = recordingSpawn([{ out: "upstream\nfork\n", code: 0 }]);
    expect(await resolveRepoRemote("/r", spawn)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["git", "-C", "/r", "remote"]);
  });

  test("`git remote` exits non-zero: null", async () => {
    const { spawn, calls } = recordingSpawn([{ out: "", code: 128 }]);
    expect(await resolveRepoRemote("/r", spawn)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("`git remote get-url` exits non-zero: null", async () => {
    const { spawn } = recordingSpawn([
      { out: "origin\n", code: 0 },
      { out: "", code: 128 },
    ]);
    expect(await resolveRepoRemote("/r", spawn)).toBeNull();
  });

  test("spawn throws (git absent from PATH): null, no exception escapes", async () => {
    await expect(resolveRepoRemote("/r", throwingSpawn)).resolves.toBeNull();
  });
});
