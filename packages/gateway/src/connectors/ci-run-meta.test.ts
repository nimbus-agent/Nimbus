import { describe, expect, test } from "bun:test";

import {
  buildCiRunMetadata,
  CI_RUN_EMITTED_KEYS,
  CI_RUN_META_VERSION,
  CI_RUN_NO_SUCCESS_SIGNAL,
  normalizeCircleciPipelineState,
  normalizeGithubActionsConclusion,
  normalizeGitlabPipelineStatus,
  normalizeJenkinsResult,
} from "./ci-run-meta.ts";

describe("normalizeGithubActionsConclusion", () => {
  test.each([
    ["completed", "success", "success"],
    ["completed", "failure", "failure"],
    ["completed", "timed_out", "failure"],
    ["completed", "startup_failure", "failure"],
    ["completed", "cancelled", "cancelled"],
    ["completed", "skipped", "unknown"],
    ["completed", "neutral", "unknown"],
    ["completed", "action_required", "unknown"],
    ["completed", "stale", "unknown"],
    ["completed", undefined, "unknown"],
    ["in_progress", undefined, "running"],
    ["queued", undefined, "running"],
    ["waiting", "failure", "running"],
    [undefined, "success", "success"],
    [undefined, undefined, "unknown"],
  ] as const)("status=%p conclusion=%p -> %p", (status, conclusion, want) => {
    expect(normalizeGithubActionsConclusion(status, conclusion)).toBe(want);
  });
});

describe("normalizeCircleciPipelineState", () => {
  test("a pipeline state is never a success signal", () => {
    expect(normalizeCircleciPipelineState("errored")).toBe("failure");
    for (const s of ["created", "setup-pending", "setup", "pending", undefined, ""]) {
      expect(normalizeCircleciPipelineState(s)).toBe("unknown");
    }
    expect(CI_RUN_NO_SUCCESS_SIGNAL.has("circleci")).toBe(true);
  });
});

describe("normalizeGitlabPipelineStatus", () => {
  test.each([
    ["success", "success"],
    ["failed", "failure"],
    ["canceled", "cancelled"],
    ["canceling", "cancelled"],
    ["created", "running"],
    ["waiting_for_resource", "running"],
    ["preparing", "running"],
    ["pending", "running"],
    ["running", "running"],
    ["scheduled", "running"],
    ["manual", "running"],
    ["skipped", "unknown"],
    ["brand_new_status", "unknown"],
  ] as const)("%p -> %p", (status, want) => {
    expect(normalizeGitlabPipelineStatus(status)).toBe(want);
  });
});

describe("normalizeJenkinsResult", () => {
  test("building wins over any result", () => {
    expect(normalizeJenkinsResult("FAILURE", true)).toBe("running");
  });
  test.each([
    ["SUCCESS", "success"],
    ["FAILURE", "failure"],
    ["UNSTABLE", "failure"],
    ["ABORTED", "cancelled"],
    ["NOT_BUILT", "unknown"],
    ["success", "unknown"], // case-sensitive: Jenkins only ever sends upper case
  ] as const)("%p -> %p", (result, want) => {
    expect(normalizeJenkinsResult(result, false)).toBe(want);
  });
});

describe("prototype-named vendor values", () => {
  test("never resolve to an inherited Object member", () => {
    for (const v of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(normalizeGithubActionsConclusion("completed", v)).toBe("unknown");
      expect(normalizeCircleciPipelineState(v)).toBe("unknown");
      expect(normalizeGitlabPipelineStatus(v)).toBe("unknown");
      expect(normalizeJenkinsResult(v, false)).toBe("unknown");
    }
  });
});

describe("buildCiRunMetadata", () => {
  test("drops colliding raw keys and writes canonical ones, stamping meta_v", () => {
    const out = buildCiRunMetadata(
      { conclusion: "timed_out", branch: "v1.0.0", runId: 7 },
      { conclusion: "failure", conclusionRaw: "timed_out", repo: "acme/app" },
    );
    expect(out).toEqual({
      runId: 7,
      conclusion: "failure",
      conclusion_raw: "timed_out",
      repo: "acme/app",
      meta_v: CI_RUN_META_VERSION,
    });
    expect("branch" in out).toBe(false);
  });

  test("omits empty and undefined optional fields rather than writing null or empty string", () => {
    const out = buildCiRunMetadata(
      {},
      { conclusion: "unknown", conclusionRaw: "", branch: undefined, headSha: "" },
    );
    expect(out).toEqual({ conclusion: "unknown", meta_v: CI_RUN_META_VERSION });
  });

  test("a raw vendor null smuggled past the types is omitted, not written as null", () => {
    const fields = { conclusion: "unknown", branch: null, repo: 42 } as unknown as Parameters<
      typeof buildCiRunMetadata
    >[1];
    expect(buildCiRunMetadata({}, fields)).toEqual({
      conclusion: "unknown",
      meta_v: CI_RUN_META_VERSION,
    });
  });

  test("keeps identifiers verbatim", () => {
    const out = buildCiRunMetadata(
      {},
      { conclusion: "success", workflowName: "folder/sub/Deploy Prod " },
    );
    expect(out["workflow_name"]).toBe("folder/sub/Deploy Prod ");
  });

  test("the emitted-keys table always includes conclusion and meta_v", () => {
    for (const keys of Object.values(CI_RUN_EMITTED_KEYS)) {
      expect(keys.has("conclusion")).toBe(true);
      expect(keys.has("meta_v")).toBe(true);
    }
  });
});
