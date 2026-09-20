import { describe, expect, test } from "bun:test";

import { detectGcloud } from "./detect-gcloud.ts";
import type { LocalAuthHostDeps, RunCli } from "./local-auth-host.ts";

function host(run: RunCli, over: Partial<LocalAuthHostDeps> = {}): LocalAuthHostDeps {
  return {
    run,
    which: () => true,
    readFile: () => null,
    exists: () => false,
    env: {},
    platform: "linux",
    homeDir: "/home/u",
    ...over,
  };
}

const LIST = "gcloud config list --format json";

describe("detectGcloud", () => {
  test("active account + project → available", async () => {
    const run: RunCli = async (argv) => ({
      ok: argv.join(" ") === LIST,
      stdout: JSON.stringify({ core: { account: "me@example.com", project: "acme-prod" } }),
      stderr: "",
      code: 0,
    });
    expect(await detectGcloud(host(run), false)).toEqual({
      source: "gcloud",
      account: "me@example.com",
      project: "acme-prod",
      status: "available",
      alreadyConfigured: false,
    });
  });

  test("an account but no default project → needs_project (still offerable)", async () => {
    const run: RunCli = async () => ({
      ok: true,
      stdout: JSON.stringify({ core: { account: "me@example.com" } }),
      stderr: "",
      code: 0,
    });
    const f = await detectGcloud(host(run), false);
    expect(f.status).toBe("needs_project");
    expect(f.project).toBeNull();
  });

  test("a project NUMBER (not an id) → needs_project, agreeing with resolveTarget's GCP_PROJECT_ID check", async () => {
    // `gcloud config set project` accepts a project number as readily as a project id, and
    // `core.project` echoes back whatever was set. Detect and adopt must agree on what counts as
    // "a project" — an owner whose default is a number is asked to name an id, the same shape
    // `adopt-local-auth.ts`'s `resolveTarget` would otherwise refuse at adopt time.
    const run: RunCli = async () => ({
      ok: true,
      stdout: JSON.stringify({ core: { account: "me@example.com", project: "123456789012" } }),
      stderr: "",
      code: 0,
    });
    const f = await detectGcloud(host(run), false);
    expect(f.status).toBe("needs_project");
    expect(f.project).toBeNull();
    expect(f.reason).toContain("123456789012");
    // The reason states the fact and the next step, never a guess at WHY validation failed — a
    // prior version guessed "it may be a project number", which was simply wrong for an owner on
    // the legacy domain-scoped form (see the "domain-scoped project id" test below).
    expect(f.reason).toContain("is not a usable project id");
    expect(f.reason).not.toContain("it may be");
  });

  test("a domain-scoped project id (the legacy example.com:my-proj form) → available", async () => {
    // `example.com:my-proj` is a real, still-valid GCP project id, not a deprecated one — the
    // review round that added the project-id validation above initially rejected it and then told
    // an owner on this form something false ("it may be a project number"). `GCP_PROJECT_ID`
    // itself is pinned in `local-auth-types.test.ts`; this proves the detector actually accepts
    // what that regex accepts, not a narrower shape re-implemented here.
    const run: RunCli = async () => ({
      ok: true,
      stdout: JSON.stringify({
        core: { account: "me@example.com", project: "example.com:my-proj" },
      }),
      stderr: "",
      code: 0,
    });
    const f = await detectGcloud(host(run), false);
    expect(f.status).toBe("available");
    expect(f.project).toBe("example.com:my-proj");
  });

  test("an invalid project on the not_logged_in branch is still reported as null, not the raw value", async () => {
    // `usable()` refuses `not_logged_in` before any caller reads `project` on this branch today,
    // but the field's own invariant must not depend on that — a later reader (the 2.5 CLI render)
    // takes `f.project` off the wire directly. All three branches must agree that an unvalidated
    // value is not a project.
    const run: RunCli = async () => ({
      ok: true,
      stdout: JSON.stringify({ core: { project: "123456789012" } }), // no account → not_logged_in
      stderr: "",
      code: 0,
    });
    const f = await detectGcloud(host(run), false);
    expect(f.status).toBe("not_logged_in");
    expect(f.project).toBeNull();
  });

  test("an oversized invalid project value is bounded before it reaches the reason string", async () => {
    // `core.project` is the owner's own `gcloud config` — no threat model — but an unbounded
    // interpolation is still a new string path that can render garbage in a terminal.
    const garbage = "x".repeat(5_000);
    const run: RunCli = async () => ({
      ok: true,
      stdout: JSON.stringify({ core: { account: "me@example.com", project: garbage } }),
      stderr: "",
      code: 0,
    });
    const f = await detectGcloud(host(run), false);
    expect(f.status).toBe("needs_project");
    expect(f.project).toBeNull();
    expect((f.reason ?? "").length).toBeLessThan(200);
    expect(f.reason).toContain("…");
  });

  test("no active account → not_logged_in naming gcloud auth login", async () => {
    const run: RunCli = async () => ({
      ok: true,
      stdout: JSON.stringify({ core: {} }),
      stderr: "",
      code: 0,
    });
    const f = await detectGcloud(host(run), false);
    expect(f.status).toBe("not_logged_in");
    expect(f.reason).toContain("gcloud auth login");
  });

  test("malformed JSON → not_logged_in, never throws", async () => {
    const run: RunCli = async () => ({ ok: true, stdout: "not json", stderr: "", code: 0 });
    expect((await detectGcloud(host(run), false)).status).toBe("not_logged_in");
  });

  test("gcloud missing → cli_not_found; CLOUDSDK_CONFIG forwarded when present", async () => {
    expect(
      (
        await detectGcloud(
          host(async () => ({ ok: false, stdout: "", stderr: "", code: 1 }), {
            which: () => false,
          }),
          false,
        )
      ).status,
    ).toBe("cli_not_found");
    const seen: Array<Record<string, string>> = [];
    await detectGcloud(
      host(
        async (_a, env) => {
          seen.push(env);
          return { ok: false, stdout: "", stderr: "", code: 1 };
        },
        { env: { CLOUDSDK_CONFIG: "/cfg/g" } },
      ),
      false,
    );
    expect(seen[0]).toEqual({ CLOUDSDK_CONFIG: "/cfg/g" });
  });
});
