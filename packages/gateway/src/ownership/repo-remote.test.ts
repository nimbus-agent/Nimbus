import { describe, expect, test } from "bun:test";

import { parseRemoteUrl, selectRemoteName } from "./repo-remote.ts";

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
