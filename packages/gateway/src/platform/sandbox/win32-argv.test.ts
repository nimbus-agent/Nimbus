import { describe, expect, it } from "bun:test";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import { buildHelperArgv } from "./win32-argv.ts";

// NO `describe.skipIf(process.platform !== "win32")` here — deliberately. See the comment at
// the top of win32.test.ts: buildHelperArgv is pure string/array derivation, no OS calls, and
// gating this file on the host platform made a sibling file read 0% on the CI-Linux-authoritative
// coverage run.

function policy(over: Partial<SandboxPolicy["permissions"]> = {}): SandboxPolicy {
  return {
    id: "com.nimbus.github",
    permissions: { network: [], filesystem: { read: [], write: [] }, ...over },
  };
}

describe("buildHelperArgv", () => {
  it("names the profile from the policy id", () => {
    const argv = buildHelperArgv(policy(), { cwd: "C:\\data" });
    expect(argv.slice(0, 2)).toEqual(["--profile", "nimbus-ext-com.nimbus.github"]);
  });

  it("passes the cwd under its own flag, not as a policy grant", () => {
    // The helper treats the cwd differently from a policy path: Modify + inheritable on the
    // leaf, and NOTHING granted on any ancestor — Windows bypasses traverse checking by default,
    // so a known full path opens without listing rights on the way down, and an ancestor grant
    // would only risk exposing sibling subtrees for no benefit. That distinction (cwd vs. policy
    // path) is only possible if the helper knows which path is the cwd, so it travels under
    // --cwd rather than folded into --grant-write. See docs/sandbox.md for the one case this
    // still fails: a `bun <script>` child under a cwd nested inside the user profile, where
    // Bun's own upward package.json walk hits an ancestor Windows would not let a non-elevated
    // token re-ACL (e.g. C:\Users itself) — a plain Win32 binary at the same path is unaffected.
    const argv = buildHelperArgv(policy(), { cwd: "C:\\data" });
    expect(argv).toEqual(expect.arrayContaining(["--cwd", "C:\\data"]));
    expect(argv).not.toContain("--grant-write");
  });

  it("requests internetClient only when the policy declares a network host", () => {
    expect(buildHelperArgv(policy(), { cwd: "C:\\d" })).not.toContain("--capability");
    const withNet = buildHelperArgv(policy({ network: ["api.github.com"] }), { cwd: "C:\\d" });
    expect(withNet).toContain("--capability");
    expect(withNet).toContain("internetClient");
  });

  it("grants internetClient exactly once regardless of host count", () => {
    const argv = buildHelperArgv(
      policy({ network: ["api.github.com", "gitlab.com", "slack.com"] }),
      { cwd: "C:\\d" },
    );
    expect(argv.filter((a) => a === "internetClient")).toHaveLength(1);
  });

  it("maps filesystem read and write permissions to their own grant flags", () => {
    const argv = buildHelperArgv(policy({ filesystem: { read: ["C:\\ro"], write: ["C:\\rw"] } }), {
      cwd: "C:\\d",
    });
    expect(argv).toEqual(expect.arrayContaining(["--grant-read", "C:\\ro"]));
    expect(argv).toEqual(expect.arrayContaining(["--grant-write", "C:\\rw"]));
  });

  it("terminates the helper flags with a bare -- so child argv cannot be read as flags", () => {
    expect(buildHelperArgv(policy(), { cwd: "C:\\d" }).at(-1)).toBe("--");
  });
});
