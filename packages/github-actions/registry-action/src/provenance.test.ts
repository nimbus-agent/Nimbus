import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type GhRun,
  ghProvenance,
  ghRunOf,
  type ProvenanceDeps,
  verifyNeverThrowing,
  verifyProvenance,
} from "./provenance.ts";

/** Real `gh attestation verify --repo cli/cli --format json` output, as registry-format tests it. */
const SAMPLE = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "registry-format",
    "src",
    "testdata",
    "gh-attestation-verify-cli-cli.json",
  ),
  "utf8",
);
const AT = "2026-10-27T12:00:00.000Z";

function deps(runs: GhRun[], token = "ghs_secret") {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number }> = [];
  const slept: number[] = [];
  const d: ProvenanceDeps = {
    token,
    run: (args, env, timeoutMs) => {
      calls.push({ args, env, timeoutMs });
      const r = runs.shift();
      if (r === undefined) throw new Error("unexpected extra gh call");
      return Promise.resolve(r);
    },
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
  };
  return { d, calls, slept };
}

const ok: GhRun = { code: 0, stdout: SAMPLE, stderr: "" };

describe("ghRunOf", () => {
  test("maps execFile's callback: success, an exit code, a missing binary, a kill", () => {
    expect(ghRunOf(null, "out", "err")).toEqual({ code: 0, stdout: "out", stderr: "err" });
    expect(ghRunOf({ code: 1 }, "", "no attestations")).toEqual({
      code: 1,
      stdout: "",
      stderr: "no attestations",
      error: {},
    });
    expect(ghRunOf({ code: "ENOENT" }, "", "")).toMatchObject({
      code: null,
      error: { code: "ENOENT" },
    });
    expect(ghRunOf({ code: null, killed: true }, "", "")).toMatchObject({
      code: null,
      error: { killed: true },
    });
  });

  test("the production verifier refuses before running gh when there is no token", async () => {
    expect(await ghProvenance("")("p", "cli/cli", AT)).toEqual({
      ok: false,
      reason: "no GitHub token to fetch attestations with",
    });
  });
});

describe("verifyNeverThrowing", () => {
  test("a throwing verifier, or an unwritable path, is a reason, never a rejection", async () => {
    const at = {
      pkgPath: join(tmpdir(), `nimbus-prov-${String(process.pid)}.tgz`),
      packageBytes: new Uint8Array([1]),
      repository: "cli/cli",
      verifiedAt: AT,
    };
    expect(await verifyNeverThrowing(() => Promise.reject(new Error("boom")), at)).toEqual({
      ok: false,
      reason: "verification failed: boom",
    });
    const bad = { ...at, pkgPath: join(tmpdir(), "no-such-dir-nimbus", "x", "p.tgz") };
    const r = await verifyNeverThrowing(
      () => Promise.resolve({ ok: false, reason: "unreached" }),
      bad,
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.reason).toStartWith("verification failed:");
  });
});

describe("verifyProvenance", () => {
  test("a verified attestation is provenance; gh gets argv only and the token in its env", async () => {
    const { d, calls } = deps([ok]);
    const r = await verifyProvenance("/w/pkg.tgz", "cli/cli", AT, d);
    expect(r).toMatchObject({ ok: true, provenance: { sourceRepository: "cli/cli" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "attestation",
      "verify",
      "/w/pkg.tgz",
      "--repo",
      "cli/cli",
      "--format",
      "json",
    ]);
    expect(calls[0]?.args.join(" ")).not.toContain("ghs_secret");
    expect(calls[0]?.env["GH_TOKEN"]).toBe("ghs_secret");
    expect(calls[0]?.timeoutMs).toBe(60_000);
  });

  test("no attestations found is definitive: no retry", async () => {
    const { d, calls, slept } = deps([
      { code: 1, stdout: "", stderr: "Error: no attestations found\n" },
    ]);
    expect(await verifyProvenance("p", "cli/cli", AT, d)).toEqual({
      ok: false,
      reason: "no attestation found for the package",
    });
    expect(calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });

  test("a timeout is retried once, then reported", async () => {
    const timedOut: GhRun = { code: null, stdout: "", stderr: "", error: { killed: true } };
    const { d, calls, slept } = deps([timedOut, timedOut]);
    expect(await verifyProvenance("p", "cli/cli", AT, d)).toEqual({
      ok: false,
      reason: "gh attestation verify timed out",
    });
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([5_000]);
    const second = deps([timedOut, ok]);
    expect((await verifyProvenance("p", "cli/cli", AT, second.d)).ok).toBe(true);
  });

  test("a missing gh is a reason, not a crash, and is not retried", async () => {
    const { d, calls } = deps([{ code: null, stdout: "", stderr: "", error: { code: "ENOENT" } }]);
    expect(await verifyProvenance("p", "cli/cli", AT, d)).toEqual({
      ok: false,
      reason: "the gh CLI is not installed on this runner",
    });
    expect(calls).toHaveLength(1);
  });

  test("another failure is retried once, then quotes gh's first stderr line, flattened and capped", async () => {
    const failing: GhRun = {
      code: 1,
      stdout: "",
      stderr: `\nHTTP 404: Not Found\u001b[31m ${"x".repeat(300)}\nmore`,
    };
    const { d, calls, slept } = deps([failing, failing]);
    const r = await verifyProvenance("p", "acme/private", AT, d);
    expect(calls).toHaveLength(2);
    expect(slept).toEqual([5_000]);
    expect(r.ok).toBe(false);
    const reason = r.ok ? "" : r.reason;
    expect(reason.startsWith("gh: HTTP 404: Not Found")).toBe(true);
    expect(reason).not.toContain("\u001b");
    expect(reason.length).toBeLessThanOrEqual(204);
    const transient = deps([{ code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" }, ok]);
    expect((await verifyProvenance("p", "cli/cli", AT, transient.d)).ok).toBe(true);
    const silent = deps([
      { code: 2, stdout: "", stderr: "" },
      { code: 2, stdout: "", stderr: "" },
    ]);
    expect(await verifyProvenance("p", "cli/cli", AT, silent.d)).toEqual({
      ok: false,
      reason: "gh exited 2",
    });
  });

  test("non-JSON output, an empty token and another repository's attestation are refused", async () => {
    const junk = deps([{ code: 0, stdout: "not json", stderr: "" }]);
    expect(await verifyProvenance("p", "cli/cli", AT, junk.d)).toEqual({
      ok: false,
      reason: "gh printed output that is not JSON",
    });
    const none = deps([], "");
    expect(await verifyProvenance("p", "cli/cli", AT, none.d)).toEqual({
      ok: false,
      reason: "no GitHub token to fetch attestations with",
    });
    expect(none.calls).toEqual([]);
    const other = deps([ok]);
    expect((await verifyProvenance("p", "evil/cli", AT, other.d)).ok).toBe(false);
  });
});
