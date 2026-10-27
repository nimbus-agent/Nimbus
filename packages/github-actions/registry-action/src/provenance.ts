/**
 * Verifying a version's build provenance at sign (and check) time (marketplace trust layer, spec
 * G8, § 6.12). `gh attestation verify <package.tgz> --repo <repository> --format json` does the
 * cryptography against GitHub's attestation service; `provenanceFromGhVerify` (registry-format)
 * decides what its output proves. Optional throughout: every failure is a reason, never a throw,
 * and never blocks the version.
 *
 * `gh` runs from an argv array (no shell) with a deadline, `GH_TOKEN` only in its own environment;
 * a missing `gh` (spawn `ENOENT`) is a reason, not a crash. A failure that is not a definitive answer
 * (a timeout, a spawn error, an exit without "no attestations found") is retried once.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  provenanceFromGhVerify,
  type VersionProvenance,
} from "../../../registry-format/src/index.ts";

export interface GhRun {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not run at all (e.g. `ENOENT`) or was killed at the deadline. */
  error?: { code?: string; killed?: boolean };
}

/** Runs `gh` with `args`; injected so tests feed recorded output. */
export type RunGh = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
) => Promise<GhRun>;

export interface ProvenanceDeps {
  run: RunGh;
  /** The token `gh` fetches attestations with; empty means none (the result is a reason). */
  token: string;
  sleep: (ms: number) => Promise<void>;
}

export type ProvenanceResult =
  | { ok: true; provenance: VersionProvenance }
  | { ok: false; reason: string };

const TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 5_000;

/** What `execFile`'s callback reports, as a `GhRun`: an exit code, or the reason there is none. */
export function ghRunOf(
  err: { code?: unknown; killed?: boolean } | null,
  stdout: unknown,
  stderr: unknown,
): GhRun {
  const out = { stdout: String(stdout), stderr: String(stderr) };
  if (err === null) return { code: 0, ...out };
  // A process that exited has a numeric code; one that never ran (ENOENT) or was killed has none.
  const exitCode = typeof err.code === "number" ? err.code : null;
  return {
    code: exitCode,
    ...out,
    error: {
      ...(typeof err.code === "string" && { code: err.code }),
      ...(err.killed === true && { killed: true }),
    },
  };
}

export const runGh: RunGh = (args, env, timeoutMs) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      [...args],
      { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => resolve(ghRunOf(err, stdout, stderr)),
    );
  });

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/** gh's first stderr line, flattened and capped: what a reason may quote. */
function firstLine(s: string): string {
  const line = s.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return line.replace(CONTROL_CHARS, " ").trim().slice(0, 200);
}

/** A run that answered the question (definitive), or one worth one more try. */
function classify(r: GhRun): { definitive: boolean; reason: string } {
  if (r.error?.code === "ENOENT") {
    return { definitive: true, reason: "the gh CLI is not installed on this runner" };
  }
  if (r.error?.killed === true) {
    return { definitive: false, reason: "gh attestation verify timed out" };
  }
  const line = firstLine(r.stderr);
  if (/no attestations found/i.test(r.stderr)) {
    return { definitive: true, reason: "no attestation found for the package" };
  }
  // Anything else (a 5xx, a network error, an attestation not yet visible) may pass on a retry.
  return { definitive: false, reason: line === "" ? `gh exited ${String(r.code)}` : `gh: ${line}` };
}

/** One `gh` call: a provenance, a definitive refusal, or a retryable failure. */
async function attempt(
  pkgPath: string,
  repository: string,
  verifiedAt: string,
  deps: ProvenanceDeps,
): Promise<ProvenanceResult & { retry?: boolean }> {
  const env = { ...process.env, GH_TOKEN: deps.token };
  const r = await deps.run(
    ["attestation", "verify", pkgPath, "--repo", repository, "--format", "json"],
    env,
    TIMEOUT_MS,
  );
  if (r.code !== 0 || r.error !== undefined) {
    const c = classify(r);
    return { ok: false, reason: c.reason, retry: !c.definitive };
  }
  let output: unknown;
  try {
    output = JSON.parse(r.stdout);
  } catch {
    return { ok: false, reason: "gh printed output that is not JSON" };
  }
  return provenanceFromGhVerify(output, repository, verifiedAt);
}

/** The provenance of the package at `pkgPath` for `repository`, or why there is none. */
export async function verifyProvenance(
  pkgPath: string,
  repository: string,
  verifiedAt: string,
  deps: ProvenanceDeps,
): Promise<ProvenanceResult> {
  if (deps.token === "") return { ok: false, reason: "no GitHub token to fetch attestations with" };
  const first = await attempt(pkgPath, repository, verifiedAt, deps);
  if (first.ok || first.retry !== true) return strip(first);
  await deps.sleep(RETRY_DELAY_MS);
  return strip(await attempt(pkgPath, repository, verifiedAt, deps));
}

/**
 * Writes the package bytes and runs `verify`, turning ANY throw (a write error, an unexpected
 * rejection) into a reason: provenance never blocks a sign or a check.
 */
export async function verifyNeverThrowing(
  verify: VerifyPackage,
  at: { pkgPath: string; packageBytes: Uint8Array; repository: string; verifiedAt: string },
): Promise<ProvenanceResult> {
  try {
    writeFileSync(at.pkgPath, at.packageBytes);
    return await verify(at.pkgPath, at.repository, at.verifiedAt);
  } catch (e) {
    return {
      ok: false,
      reason: `verification failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** A package-provenance verifier: what `sign` and `check` call; tests inject one. */
export type VerifyPackage = (
  pkgPath: string,
  repository: string,
  verifiedAt: string,
) => Promise<ProvenanceResult>;

/** The production verifier: `gh` with `token`, waiting with a real timer. */
export function ghProvenance(token: string): VerifyPackage {
  return (pkgPath, repository, verifiedAt) =>
    verifyProvenance(pkgPath, repository, verifiedAt, {
      run: runGh,
      token,
      sleep: (ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }),
    });
}

function strip(r: ProvenanceResult & { retry?: boolean }): ProvenanceResult {
  return r.ok ? { ok: true, provenance: r.provenance } : { ok: false, reason: r.reason };
}
