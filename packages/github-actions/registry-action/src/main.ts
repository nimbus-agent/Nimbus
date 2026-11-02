import { isAbsolute, join } from "node:path";
import { emitAnnotation, getInput, inputEnvName } from "../../shared/gha-io.ts";
import { runCheck } from "./check.ts";
import { runLivenessCheck } from "./liveness-check.ts";
import { runLivenessSign } from "./liveness-sign.ts";
import { runScore } from "./score.ts";
import { runScorePackage } from "./score-package.ts";
import { runSign, type SignOptions } from "./sign.ts";
import { runTrustCheck } from "./trust-check.ts";
import { runTrustSign } from "./trust-sign.ts";

export type Mode =
  | "check"
  | "sign"
  | "score"
  | "score-package"
  | "liveness-check"
  | "liveness-sign"
  | "trust-check"
  | "trust-sign";

const MODES: readonly Mode[] = [
  "check",
  "sign",
  "score",
  "score-package",
  "liveness-check",
  "liveness-sign",
  "trust-check",
  "trust-sign",
];

/** The `mode` input, refused unless it is exactly one of `MODES`. */
export function parseMode(raw: string): Mode {
  const mode = MODES.find((m) => m === raw);
  if (mode !== undefined) return mode;
  throw new Error(
    `input "mode" must be "check", "sign", "score", "score-package", "liveness-check", "liveness-sign", "trust-check" or "trust-sign"; got ${JSON.stringify(raw)}`,
  );
}

/** The `root-key` input, masked and dropped from the environment before anything else runs. */
function takeRootKey(): string {
  const rootKey = requireInput("root-key");
  maskSecret(rootKey);
  // Every git child inherits this process's environment: the key must not ride along.
  delete process.env[inputEnvName("root-key")];
  return rootKey;
}

/**
 * The `liveness-sign` inputs: `liveness-key` and `root-key` are both read, masked and dropped from
 * the environment BEFORE either is validated, so no refusal can leave one of them behind. Then a
 * missing liveness key and a set root key are refused.
 */
function takeLivenessSignKeys(): string {
  const key = getInput("liveness-key");
  const root = getInput("root-key");
  for (const [name, value] of [
    ["liveness-key", key],
    ["root-key", root],
  ] as const) {
    if (value !== "") maskSecret(value);
    // Every git child inherits this process's environment: a key must not ride along.
    delete process.env[inputEnvName(name)];
  }
  if (key === "") throw new Error('input "liveness-key" is required');
  if (root !== "") {
    throw new Error(
      'input "root-key" must not be set in liveness-sign mode: liveness-sign signs with the liveness key alone',
    );
  }
  return key;
}

function requireInput(name: string): string {
  const v = getInput(name);
  if (v === "") throw new Error(`input "${name}" is required`);
  return v;
}

/**
 * Register `secret` with the runner's log masking (`::add-mask::`) before anything else touches it.
 * Each line is masked on its own too, since a multi-line value is masked line by line, and the
 * value is escaped with the runner's command encoding so a `%` in it cannot alter what is masked.
 */
export function maskSecret(
  secret: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
): void {
  const parts = new Set([secret, secret.trim(), ...secret.split(/[\r\n]+/).map((l) => l.trim())]);
  parts.delete("");
  for (const p of parts) {
    if (/[\r\n]/.test(p)) continue; // covered by its lines
    write(`::add-mask::${p.replaceAll("%", "%25")}\n`);
  }
}

/**
 * What `sign` runs with. The `default-branch` input is passed on when set; empty (an older
 * workflow, or none given) leaves `sign` to ask origin's HEAD, which is gh-pages when that branch
 * was pushed first to an empty repository. `repository` (`GITHUB_REPOSITORY`) is passed on when
 * set; the caller reads it, so this stays a pure function of its arguments.
 */
export function signOptions(
  workspace: string,
  rootKey: string,
  defaultBranch: string,
  repository: string | undefined,
): SignOptions {
  return {
    workspace,
    rootKey,
    ...(defaultBranch !== "" && { defaultBranch }),
    ...(repository !== undefined && repository !== "" && { repository }),
  };
}

/**
 * The optional `github-token` input (provenance: `gh attestation verify` fetches with it), masked
 * and dropped from the environment like the root key; empty means no provenance is verified.
 */
function takeGithubToken(): string {
  const token = getInput("github-token");
  if (token !== "") maskSecret(token);
  delete process.env[inputEnvName("github-token")];
  return token;
}

/**
 * Ruling R8: a job that runs untrusted extension code must hold no secret. Every input in `names`
 * is read, masked when set and dropped from the environment BEFORE the first one set is refused
 * with `refusal(name)`; the role gets a minimal environment of its own regardless.
 */
function refuseSecrets(names: readonly string[], refusal: (name: string) => string): void {
  const set: string[] = [];
  for (const name of names) {
    const value = getInput(name);
    delete process.env[inputEnvName(name)];
    if (value !== "") {
      maskSecret(value);
      set.push(name);
    }
  }
  const [first] = set;
  if (first !== undefined) throw new Error(refusal(first));
}

/** `score` and `score-package` run extension code: a `root-key` or `github-token` handed to them is refused. */
function refuseSecretsInScore(mode: "score" | "score-package"): void {
  refuseSecrets(
    ["root-key", "github-token", "liveness-key"],
    (name) =>
      `input "${name}" must not be set in ${mode} mode: ${mode} runs extension code and holds no secrets`,
  );
}

/** `liveness-check` runs extension code: a root, GitHub or liveness key handed to it is refused. */
function refuseSecretsInLivenessCheck(): void {
  refuseSecrets(
    ["root-key", "github-token", "liveness-key"],
    (name) =>
      `input "${name}" must not be set in liveness-check mode: liveness-check runs extension code and holds no secrets`,
  );
}

/**
 * The `check` mode's inputs. With `nimbus-gateway` set, check runs extension code, so a
 * `github-token` is refused (and provenance is left to the sign job); without it, as before.
 */
function checkInputs(): { githubToken?: string; gateway?: string } {
  const gateway = getInput("nimbus-gateway");
  if (gateway === "") return { githubToken: takeGithubToken() };
  refuseSecrets(
    ["github-token", "root-key", "liveness-key"],
    (name) =>
      `input "${name}" must not be set with "nimbus-gateway" in check mode: scoring runs extension code and holds no secrets`,
  );
  return { gateway };
}

/** Where `score` writes: the `scores` input (relative to the workspace), or `scores.json`. */
export function scoresPath(ws: string, input: string): string {
  const rel = input === "" ? "scores.json" : input;
  return isAbsolute(rel) ? rel : join(ws, rel);
}

/** A path input: absolute as given, otherwise relative to the workspace. */
function resolveInWorkspace(ws: string, input: string): string {
  return isAbsolute(input) ? input : join(ws, input);
}

function workspace(): string {
  return process.env["GITHUB_WORKSPACE"] ?? process.cwd();
}

type ModeHandler = (baseRef: string) => Promise<void>;

/** The `results` input (a path), defaulting to `liveness-results.json` in the workspace. */
function livenessResultsPath(): string {
  const results = getInput("results");
  return resolveInWorkspace(workspace(), results === "" ? "liveness-results.json" : results);
}

async function runScorePackageMode(): Promise<void> {
  refuseSecretsInScore("score-package");
  await runScorePackage({
    package: resolveInWorkspace(workspace(), requireInput("package")),
    gateway: getInput("nimbus-gateway"),
    out: scoresPath(workspace(), getInput("scores")),
  });
}

async function runScoreMode(): Promise<void> {
  refuseSecretsInScore("score");
  const defaultBranch = getInput("default-branch");
  await runScore({
    workspace: workspace(),
    gateway: getInput("nimbus-gateway"),
    out: scoresPath(workspace(), getInput("scores")),
    ...(defaultBranch !== "" && { defaultBranch }),
  });
}

async function runLivenessCheckMode(): Promise<void> {
  refuseSecretsInLivenessCheck();
  await runLivenessCheck({
    workspace: workspace(),
    gateway: getInput("nimbus-gateway"),
    nimbusVersion: getInput("nimbus-version"),
    out: livenessResultsPath(),
  });
}

async function runLivenessSignMode(): Promise<void> {
  const livenessKey = takeLivenessSignKeys();
  const defaultBranch = getInput("default-branch");
  await runLivenessSign({
    workspace: workspace(),
    livenessKey,
    results: livenessResultsPath(),
    nimbusVersion: getInput("nimbus-version"),
    ...(defaultBranch !== "" && { defaultBranch }),
  });
}

async function runTrustSignMode(): Promise<void> {
  const rootKey = takeRootKey();
  const defaultBranch = getInput("default-branch");
  await runTrustSign({
    workspace: workspace(),
    rootKey,
    ...(defaultBranch !== "" && { defaultBranch }),
  });
}

async function runSignMode(): Promise<void> {
  const rootKey = takeRootKey();
  const githubToken = takeGithubToken();
  // Unlike score, sign has no default: no input means no quality is signed.
  const scores = getInput("scores");
  await runSign({
    ...signOptions(
      workspace(),
      rootKey,
      getInput("default-branch"),
      process.env["GITHUB_REPOSITORY"],
    ),
    githubToken,
    ...(scores !== "" && { scores: scoresPath(workspace(), scores) }),
  });
}

/** The mode to handler table; each handler takes its own secrets and refuses the ones it must not hold. */
const HANDLERS: Readonly<Record<string, ModeHandler>> = {
  check: (baseRef) => runCheck({ workspace: workspace(), baseRef, ...checkInputs() }),
  "score-package": runScorePackageMode,
  score: runScoreMode,
  "liveness-check": runLivenessCheckMode,
  "liveness-sign": runLivenessSignMode,
  "trust-check": (baseRef) => runTrustCheck({ workspace: workspace(), baseRef }),
  "trust-sign": runTrustSignMode,
  sign: runSignMode,
};

export async function main(): Promise<void> {
  try {
    const mode = parseMode(getInput("mode"));
    const baseRef = process.env["GITHUB_BASE_REF"] ?? "";
    const handler = HANDLERS[mode];
    if (handler === undefined) throw new Error(`mode ${JSON.stringify(mode)} has no handler`);
    await handler(baseRef);
  } catch (err) {
    emitAnnotation("error", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// Run only as the action entrypoint, so unit tests can import `parseMode` without running a mode.
if (import.meta.main) {
  await main();
}
