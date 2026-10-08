import { describe, expect, test } from "bun:test";

import { unevaluableCiServices } from "./ci-evaluability.ts";
import { parseDoraRepoUrn } from "./dora-config.ts";

const repos = (...urns: string[]) => urns.map(parseDoraRepoUrn);

describe("unevaluableCiServices", () => {
  test("preflight cannot judge jenkins (no branch), circleci (no pass/fail) or bitbucket (no writer)", () => {
    expect(
      unevaluableCiServices(
        repos("jenkins:deploy", "circleci:gh/a/b", "bitbucket:a/b"),
        "preflight_failing_runs",
      ).sort(),
    ).toEqual(["bitbucket", "circleci", "jenkins"]);
  });
  test("DORA deploy detection can judge jenkins but not circleci or bitbucket", () => {
    expect(
      unevaluableCiServices(
        repos("jenkins:deploy", "circleci:gh/a/b", "bitbucket:a/b"),
        "dora_deploys",
      ).sort(),
    ).toEqual(["bitbucket", "circleci"]);
  });
  test("github actions and gitlab are evaluable for both uses", () => {
    expect(
      unevaluableCiServices(repos("github:a/b", "gitlab:g/p"), "preflight_failing_runs"),
    ).toEqual([]);
    expect(unevaluableCiServices(repos("github:a/b", "gitlab:g/p"), "dora_deploys")).toEqual([]);
  });
});
