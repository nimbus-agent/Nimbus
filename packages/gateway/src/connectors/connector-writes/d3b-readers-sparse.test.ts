// Phase 9.7 D3b: the selectors on sparse, odd and hostile replies. Each field is optional in the
// vendors' JSON, so a missing value is left out, never invented, and a malformed one fails closed.
import { describe, expect, test } from "bun:test";

import * as R from "./deploy-readers.ts";

const mcp = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const labels = (f: readonly { label: string }[]) => f.map((x) => x.label);

describe("vercel selectors on sparse replies", () => {
  test("a bare deployment: only the target and effect lines", () => {
    const out = R.selectVercelRedeploy({ id: "d" }, { target: "weird" });
    expect(labels(out)).toContain("Source deployment");
    expect(out.at(-1)?.value).toBe("(unknown target)");
    expect(
      R.selectVercelRedeploy({ uid: "u", state: "BUILDING", createdAt: "text" }, {}),
    ).toBeDefined();
  });
  test("created times: epoch ms, a bad epoch and a string", () => {
    const at = (createdAt: unknown) =>
      R.selectVercelRedeploy({ id: "d", createdAt }, { target: "preview" }).find(
        (f) => f.label === "Source created",
      )?.value;
    expect(at(1_762_000_000_000)).toBe("2025-11-01T12:26:40.000Z");
    expect(at(99_999_999_999_999)).toBe("5138-11-16T09:46:39.999Z");
    expect(at("yesterday")).toBe("yesterday");
    expect(at(undefined)).toBeUndefined();
  });
  test("commit message keys of the other Git hosts", () => {
    for (const k of ["gitlabCommitMessage", "bitbucketCommitMessage", "commitMessage"]) {
      const out = R.selectVercelRedeploy({ id: "d", meta: { [k]: "m" } }, { target: "preview" });
      expect(out.find((f) => f.label === "Source commit message")?.value).toBe("m");
    }
  });
  test("read args refuse a missing id", () => {
    expect(R.vercelRedeployReadArgs({})).toBeUndefined();
    expect(R.vercelPromoteReadArgs({})).toBeUndefined();
    expect(R.vercelPromoteDeploymentReadArgs({})).toBeUndefined();
  });
  test("promote with a sparse production and no note", () => {
    const out = R.selectVercelPromote(
      { projectId: "p", production: { id: "x" } },
      { deploymentId: "y", projectId: "p" },
      { id: "y" },
    );
    expect(labels(out)).not.toContain("Note");
    expect(() => R.selectVercelPromote({}, {}, {})).toThrow();
  });
});

describe("netlify selectors on sparse replies", () => {
  test("read args refuse a missing site", () => {
    expect(R.netlifySiteReadArgs({})).toBeUndefined();
    expect(R.netlifyDeploysReadArgs({})).toBeUndefined();
    expect(R.netlifyDeploysReadArgs({ siteId: "s" })).toEqual({ siteId: "s", perPage: 5 });
  });
  test("a site with only an id, no deploys, and neither branch nor production", () => {
    const out = R.selectNetlifyBuild({ id: "s" }, {}, []);
    expect(out[0]?.value).toBe("s");
    expect(out.find((f) => f.label === "Production branch")?.value).toBe("(not shown: unreadable)");
    expect(out.find((f) => f.label === "Effect")?.value).toBe("(no branch and no production flag)");
    expect(out.find((f) => f.label === "Recent deploys")?.value).toBe("(none)");
    expect(R.selectNetlifyBuild({ id: "s" }, {}, undefined)).toBeDefined();
    expect(
      R.selectNetlifyBuild({ id: "s" }, {}, mcp([{ id: "d" }, { state: "ready" }])),
    ).toBeDefined();
  });
  test("a branch with an unreadable production branch is a plain branch deploy line", () => {
    const out = R.selectNetlifyBuild({ id: "s" }, { branch: "x" }, []);
    expect(out.find((f) => f.label === "Effect")?.value).toContain("branch deploy");
  });
  test("a published deploy without a state or branch", () => {
    const out = R.selectNetlifyBuild(
      { id: "s", published_deploy: { id: "p" } },
      { branch: "x" },
      [],
    );
    expect(out.find((f) => f.label === "Live deploy")?.value).toBe("p");
  });
  test("the guard does not apply without a string branch and refuses a non-string one", () => {
    expect(
      R.NETLIFY_PRODUCTION_BRANCH_GUARD.allows(
        { build_settings: { repo_branch: "m" } },
        {},
        undefined,
        undefined,
      ),
    ).toBe(false);
  });
});

describe("bitrise, codemagic and firebase selectors on sparse replies", () => {
  test("read args refuse missing keys", () => {
    expect(R.bitriseLatestReadArgs({ appSlug: "a" })).toBeUndefined();
    expect(R.codemagicLatestReadArgs({ appId: "a" })).toBeUndefined();
    expect(R.firebaseReleaseReadArgs({ appId: "a" })).toBeUndefined();
    expect(R.testflightGroupsReadArgs({})).toBeUndefined();
    expect(R.testflightBuildGroupsReadArgs({})).toBeUndefined();
  });
  test("a build with only its id", () => {
    expect(R.selectBitriseLatest({ build: { slug: "s" } })).toHaveLength(1);
    expect(R.selectCodemagicLatest({ build: { id: "i" } })).toHaveLength(1);
    expect(() => R.selectBitriseLatest({})).toThrow();
    expect(() => R.selectCodemagicLatest({})).toThrow();
  });
  test("codemagic none without a scan count", () => {
    expect(R.selectCodemagicLatest({ build: null })[0]?.value).toBe("(none found)");
  });
  test("firebase with a build version only, and its test state", () => {
    const out = R.selectFirebaseRelease({ buildVersion: "9", testState: "PASSED" });
    expect(labels(out)).toEqual(["Build version", "Test state", "Already sent"]);
    expect(R.selectFirebaseRelease({ displayVersion: "1" })).toHaveLength(2);
  });
});

describe("testflight selectors on sparse replies", () => {
  const sel = (groups: unknown, ids: unknown, build: unknown) =>
    R.selectTestflightDistribute(groups, { betaGroupIds: ids }, build);
  test("a group with no name, no kind and no link state", () => {
    const out = sel({ groups: [{ id: "g" }] }, ["g"], {});
    expect(out[0]?.value).toBe("(no name) (kind unknown; public link not reported)");
    expect(out.at(-1)?.value).toBe("(not shown)");
  });
  test("an internal group", () => {
    const out = sel({ groups: [{ id: "g", name: "N", isInternalGroup: true }] }, ["g"], {
      groups: [{ id: "x" }],
    });
    expect(out[0]?.value).toContain("internal");
  });
  test("targets that are not a list of ids throw", () => {
    expect(() => sel({ groups: [] }, "g", {})).toThrow();
    expect(() => sel({ groups: [] }, [1], {})).toThrow();
  });
  test("the guard on a reply without groups", () => {
    expect(R.TESTFLIGHT_PUBLIC_LINK_GUARD.appliesTo({}, undefined)).toBe(false);
    expect(
      R.TESTFLIGHT_PUBLIC_LINK_GUARD.allows({}, { betaGroupIds: ["g"] }, undefined, undefined),
    ).toBe(false);
  });
});
