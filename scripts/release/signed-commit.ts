#!/usr/bin/env bun

/**
 * signed-commit — publish files to a branch through the GitHub GraphQL
 * `createCommitOnBranch` mutation instead of `git commit` + `git push`.
 *
 * WHY THIS EXISTS. A commit pushed over HTTPS with an App installation token is
 * UNSIGNED: git builds the commit object on the runner and the server stores it
 * verbatim, so `verification.verified` is false. Every commit in homebrew-tap,
 * scoop-bucket and linux-repo looks exactly like one an attacker holding a
 * leaked token would produce — and those repos are what `brew install`,
 * `scoop install` and `yum install` read, which makes them the shortest path
 * from a stolen token to code on a user's machine.
 *
 * `createCommitOnBranch` moves commit construction server-side: GitHub builds
 * the tree, writes the commit, and signs it with its own key, so the result is
 * Verified. That is the prerequisite for `required_signatures` on those repos'
 * rulesets — which is a SEPARATE, LATER change. Turning on `required_signatures`
 * before every publisher has moved to this path breaks the next publish.
 *
 * SELF-PROVING. "The commit is signed" is not taken on faith. The mutation asks
 * for the created commit's `signature { isValid state wasSignedByGitHub }` and
 * the publish ABORTS unless it comes back `isValid: true` + `state: VALID` —
 * see `readCommitVerification` / `assertCommitVerified`. Without that assertion
 * a silent regression (GitHub stops signing, the selection set drifts, someone
 * reverts to a runner-side commit) would look exactly like success right up
 * until `required_signatures` is enabled and every publish starts failing.
 *
 * WHAT IT DOES NOT CHANGE. The file contents published are byte-for-byte what
 * the caller passes; only the mechanism that creates the commit differs.
 *
 * SIZE. The whole commit travels as one base64 JSON request body, so this is
 * only appropriate for small text manifests. `linux-repo` publishes .deb/.rpm
 * payloads (two Bun-compiled binaries each) plus regenerated repo metadata and
 * is deliberately NOT converted — see MAX_PAYLOAD_BYTES.
 *
 * CONCURRENCY. The mutation requires `expectedHeadOid` and is rejected if the
 * branch moved since we read it. That is a feature: we re-read and rebuild
 * rather than force anything. There is no force path here by design.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const GITHUB_GRAPHQL_ENDPOINT = "https://api.github.com/graphql";

/**
 * Self-imposed ceiling on the serialized `fileChanges` payload. GitHub rejects
 * oversized GraphQL request bodies with an opaque 4xx that is miserable to
 * diagnose from a release job; failing locally with the actual byte count is
 * far more actionable. Base64 inflates by ~4/3, which this counts because it
 * measures the encoded payload, not the source bytes.
 */
export const MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;

/** Default number of read→mutate attempts before giving up on a moving branch. */
export const DEFAULT_MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One `FileAddition` as the GraphQL API wants it: repo path + base64 contents. */
export interface FileAddition {
  readonly path: string;
  /** Base64-encoded file contents (`Base64String` in the GraphQL schema). */
  readonly contents: string;
}

/** One `FileDeletion`. Deletions are a SEPARATE array from additions. */
export interface FileDeletion {
  readonly path: string;
}

/** The `fileChanges` half of `CreateCommitOnBranchInput`. */
export interface FileChanges {
  readonly additions?: readonly FileAddition[];
  readonly deletions?: readonly FileDeletion[];
}

/** A file we want the branch to contain, as raw (possibly binary) bytes. */
export interface DesiredFile {
  readonly path: string;
  readonly contents: Uint8Array;
}

export interface CommitMessage {
  readonly headline: string;
  readonly body?: string;
}

export interface CreateCommitOnBranchInput {
  readonly branch: { readonly repositoryNameWithOwner: string; readonly branchName: string };
  readonly expectedHeadOid: string;
  readonly message: CommitMessage;
  readonly fileChanges: FileChanges;
}

export interface GraphQLError {
  readonly message: string;
  readonly type?: string;
}

export interface GraphQLResponse {
  readonly data?: unknown;
  readonly errors?: readonly GraphQLError[];
}

export interface GraphQLClient {
  request(query: string, variables: Record<string, unknown>): Promise<GraphQLResponse>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Normalize a path to the forward-slash, repo-relative form the API requires.
 *
 * Load-bearing on Windows: a path built with `path.join()` arrives with
 * backslashes, and GitHub would create a file literally NAMED `Formula\nimbus.rb`
 * rather than one inside `Formula/`.
 */
export function toRepoPath(p: string): string {
  const slashed = p.replaceAll("\\", "/");
  return slashed.replace(/^\.\//, "").replace(/^\/+/, "");
}

/** Base64-encode file bytes. Binary-safe (no text decoding anywhere). */
export function encodeContents(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/**
 * The git object id (SHA-1 of `blob <len>\0<bytes>`) the given bytes would have.
 *
 * Used to decide whether a file actually changed WITHOUT downloading it: the API
 * hands us the remote blob's oid, and comparing oids is exact for binary content
 * and immune to any text/encoding round-trip.
 */
export function gitBlobOid(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${String(bytes.byteLength)}\0`, "utf8");
  return createHash("sha1").update(header).update(bytes).digest("hex");
}

export interface FileChangePlan {
  readonly changes: FileChanges;
  /** Desired paths already at the wanted content on the branch. */
  readonly unchanged: readonly string[];
  /** Requested deletions for paths that do not exist on the branch. */
  readonly alreadyAbsent: readonly string[];
  /** True when there is nothing to commit — the caller should skip the mutation. */
  readonly isNoOp: boolean;
}

/**
 * Decide the exact `fileChanges` to send, given what we want and what the branch
 * already has (`remoteBlobOids`: path → blob oid, or null when absent).
 *
 * - additions carry only files whose content differs (or are new);
 * - deletions are emitted only for paths that actually exist — the API errors on
 *   deleting a missing path, which would turn a re-run into a hard failure;
 * - empty arrays are omitted so a no-op never sends a degenerate mutation.
 */
export function planFileChanges(
  desired: readonly DesiredFile[],
  deletions: readonly string[],
  remoteBlobOids: ReadonlyMap<string, string | null>,
): FileChangePlan {
  const additions: FileAddition[] = [];
  const unchanged: string[] = [];
  for (const file of desired) {
    const path = toRepoPath(file.path);
    if (remoteBlobOids.get(path) === gitBlobOid(file.contents)) {
      unchanged.push(path);
      continue;
    }
    additions.push({ path, contents: encodeContents(file.contents) });
  }

  const toDelete: FileDeletion[] = [];
  const alreadyAbsent: string[] = [];
  for (const raw of deletions) {
    const path = toRepoPath(raw);
    const oid = remoteBlobOids.get(path);
    if (oid === undefined || oid === null) alreadyAbsent.push(path);
    else toDelete.push({ path });
  }

  const changes: FileChanges = {
    ...(additions.length > 0 ? { additions } : {}),
    ...(toDelete.length > 0 ? { deletions: toDelete } : {}),
  };
  return {
    changes,
    unchanged,
    alreadyAbsent,
    isNoOp: additions.length === 0 && toDelete.length === 0,
  };
}

/** Serialized size of the file payload, in bytes. */
export function payloadByteLength(changes: FileChanges): number {
  return Buffer.byteLength(JSON.stringify(changes), "utf8");
}

/**
 * Throw with an actionable message when the payload is too large to be a
 * sensible GraphQL request body.
 */
export function assertPayloadWithinLimit(changes: FileChanges, max = MAX_PAYLOAD_BYTES): void {
  const size = payloadByteLength(changes);
  if (size <= max) return;
  const mib = (n: number): string => (n / (1024 * 1024)).toFixed(1);
  throw new Error(
    `signed-commit: file payload is ${mib(size)} MiB (base64), over the ${mib(max)} MiB ceiling. ` +
      "createCommitOnBranch sends the whole commit as one request body, so it is only viable for " +
      "small text manifests. Publish large/binary trees another way.",
  );
}

/** Build the mutation input. Kept pure so the exact wire shape is testable. */
export function buildCommitInput(opts: {
  nameWithOwner: string;
  branchName: string;
  expectedHeadOid: string;
  message: CommitMessage;
  changes: FileChanges;
}): CreateCommitOnBranchInput {
  return {
    branch: {
      repositoryNameWithOwner: opts.nameWithOwner,
      branchName: opts.branchName,
    },
    expectedHeadOid: opts.expectedHeadOid,
    message: opts.message,
    fileChanges: opts.changes,
  };
}

/**
 * Messages GitHub returns when `expectedHeadOid` no longer matches the branch.
 * Kept deliberately broad: a MISS costs one loud failure (safe), while treating
 * an unrelated error as "stale" would retry something that will never succeed.
 */
const STALE_HEAD_PATTERNS: readonly RegExp[] = [
  /expected .*head/i,
  /but it did not/i,
  /is at .* but expected/i,
  /head of .* branch/i,
  /stale/i,
];

/** True when the errors indicate the branch head moved between read and write. */
export function isStaleHeadError(errors: readonly GraphQLError[]): boolean {
  return errors.some(
    (e) =>
      e.type === "STALE_DATA" || STALE_HEAD_PATTERNS.some((pattern) => pattern.test(e.message)),
  );
}

function commitNodeOf(data: unknown): Record<string, unknown> | null {
  if (!isRecord(data)) return null;
  const mutation = data["createCommitOnBranch"];
  if (!isRecord(mutation)) return null;
  const commit = mutation["commit"];
  return isRecord(commit) ? commit : null;
}

function commitOidOf(data: unknown): string | null {
  const commit = commitNodeOf(data);
  if (commit === null) return null;
  const oid = commit["oid"];
  return typeof oid === "string" ? oid : null;
}

// ---------------------------------------------------------------------------
// Signature verification — the assertion that makes this workflow self-proving
// ---------------------------------------------------------------------------

/** The one `GitSignatureState` that means "GitHub shows this commit as Verified". */
export const VERIFIED_SIGNATURE_STATE = "VALID";

/**
 * What the mutation told us about the created commit's signature.
 *
 * Every field is nullable on purpose: this describes an UNTRUSTED response, and
 * "we could not read it" must be representable so it can be reported as
 * unverified rather than silently coerced into a boolean.
 */
export interface CommitVerification {
  /** The only field callers should gate on. False whenever anything is off. */
  readonly verified: boolean;
  /** `GitSignatureState`, or null when absent/not a string. */
  readonly state: string | null;
  readonly isValid: boolean | null;
  /**
   * Informational, deliberately NOT gated on: it reports WHICH key signed, not
   * whether the signature verifies. `createCommitOnBranch` cannot be made to
   * emit a non-GitHub signature, so gating on it would add no security while
   * coupling every release to GitHub's key-attribution reporting.
   */
  readonly wasSignedByGitHub: boolean | null;
  /** Human-readable reason, always populated — this is what lands in the log. */
  readonly detail: string;
}

function unverified(detail: string): CommitVerification {
  return { verified: false, state: null, isValid: null, wasSignedByGitHub: null, detail };
}

/**
 * Read the signature block out of a `createCommitOnBranch` response `data`.
 *
 * FAIL-CLOSED IN EVERY DIRECTION. A null signature is what GitHub returns for an
 * unsigned commit (confirmed against a real runner-pushed commit), so null is
 * "not verified" — never "no data, assume fine". A MISSING `signature` key means
 * the mutation's selection set drifted and is treated the same way, because a
 * silently-unasserted publish is the exact regression this guards.
 */
export function readCommitVerification(data: unknown): CommitVerification {
  const commit = commitNodeOf(data);
  if (commit === null) return unverified("the response carried no commit node");
  if (!("signature" in commit)) {
    return unverified(
      "the response carried no `signature` field — CREATE_COMMIT_MUTATION no longer requests it",
    );
  }
  const signature = commit["signature"];
  if (signature === null || signature === undefined) {
    return unverified("`signature` was null — GitHub recorded this commit as UNSIGNED");
  }
  if (!isRecord(signature)) return unverified("`signature` was not an object");

  const rawIsValid = signature["isValid"];
  const rawState = signature["state"];
  const rawByGitHub = signature["wasSignedByGitHub"];
  const isValid = typeof rawIsValid === "boolean" ? rawIsValid : null;
  const state = typeof rawState === "string" ? rawState : null;
  const wasSignedByGitHub = typeof rawByGitHub === "boolean" ? rawByGitHub : null;
  const verified = isValid === true && state === VERIFIED_SIGNATURE_STATE;
  return {
    verified,
    state,
    isValid,
    wasSignedByGitHub,
    detail:
      `signature state=${state ?? "<missing>"} isValid=${isValid === null ? "<missing>" : String(isValid)} ` +
      `wasSignedByGitHub=${wasSignedByGitHub === null ? "<missing>" : String(wasSignedByGitHub)}`,
  };
}

/**
 * Stop the publish unless GitHub signed the commit it just created.
 *
 * Loud on purpose. The commit has already landed by the time we can look at it,
 * so this cannot prevent it — what it prevents is a release that QUIETLY stops
 * producing Verified commits, which would only surface later as a hard publish
 * failure once `required_signatures` is on the ruleset.
 */
export function assertCommitVerified(
  verification: CommitVerification,
  ctx: { readonly repo: string; readonly oid: string },
): void {
  if (verification.verified) return;
  throw new Error(
    `signed-commit: ${ctx.repo} commit ${ctx.oid} is NOT GitHub-verified — ${verification.detail}. ` +
      "createCommitOnBranch is supposed to build and sign the commit server-side, so this means " +
      "either the commit was not created through that mutation, GitHub did not sign it, or the " +
      "mutation's signature selection drifted. Do NOT enable required_signatures on this repo's " +
      "ruleset until a publish reports a verified commit; investigate the commit above first.",
  );
}

export type MutationOutcome =
  | { readonly kind: "ok"; readonly oid: string; readonly verification: CommitVerification }
  | { readonly kind: "stale"; readonly message: string }
  | { readonly kind: "error"; readonly message: string };

/**
 * Classify a mutation response into commit / retry / fail. Pure: this is the
 * stale-head retry DECISION, separated from the network so it can be tested.
 *
 * `ok` means "a commit exists", NOT "the commit is acceptable" — the signature
 * verdict rides along and is enforced by the caller via `assertCommitVerified`.
 */
export function classifyMutationResult(res: GraphQLResponse): MutationOutcome {
  const errors = res.errors ?? [];
  if (errors.length > 0) {
    const message = errors.map((e) => e.message).join("; ");
    return isStaleHeadError(errors) ? { kind: "stale", message } : { kind: "error", message };
  }
  const oid = commitOidOf(res.data);
  if (oid === null) {
    return {
      kind: "error",
      message: "createCommitOnBranch returned no commit oid (unexpected response shape)",
    };
  }
  return { kind: "ok", oid, verification: readCommitVerification(res.data) };
}

/** Split `owner/name` into its parts. Throws on anything else. */
export function parseNameWithOwner(nwo: string): { owner: string; name: string } {
  const parts = nwo.split("/");
  const owner = parts[0];
  const name = parts[1];
  if (
    parts.length !== 2 ||
    owner === undefined ||
    owner === "" ||
    name === undefined ||
    name === ""
  )
    throw new Error(`signed-commit: --repo must be "owner/name", got "${nwo}"`);
  return { owner, name };
}

/** Accept `main` or `refs/heads/main`; the API wants the qualified form. */
export function qualifyBranch(branch: string): string {
  return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

const DEFAULT_BRANCH_QUERY = `query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){ defaultBranchRef{ name target{ oid } } }
}`;

const NAMED_BRANCH_QUERY = `query($owner:String!,$name:String!,$qn:String!){
  repository(owner:$owner,name:$name){ ref(qualifiedName:$qn){ name target{ oid } } }
}`;

/**
 * The publish mutation. The `signature` selection is what makes this workflow
 * self-proving — do NOT drop it to "simplify" the document.
 *
 * `Commit.signature` is a nullable `GitSignature` interface; `isValid`, `state`
 * and `wasSignedByGitHub` are declared on the interface itself, so no inline
 * fragment is needed (verified against the live GitHub schema — the concrete
 * types are GpgSignature / SmimeSignature / SshSignature / UnknownSignature).
 * A commit GitHub built and signed answers `{isValid:true,state:VALID,
 * wasSignedByGitHub:true}`; an unsigned commit answers `signature: null`.
 */
export const CREATE_COMMIT_MUTATION = `mutation($input:CreateCommitOnBranchInput!){
  createCommitOnBranch(input:$input){
    commit{ oid url signature{ isValid state wasSignedByGitHub } }
  }
}`;

export interface BlobQuery {
  readonly query: string;
  readonly variables: Record<string, string>;
}

/**
 * Build an aliased query reading one blob oid per path at a fixed commit, so the
 * "did it change?" check costs a single round trip regardless of file count.
 * Paths travel as variables — never interpolated into the document.
 */
export function buildBlobQuery(
  owner: string,
  name: string,
  headOid: string,
  paths: readonly string[],
): BlobQuery {
  const variables: Record<string, string> = { owner, name };
  const declarations = ["$owner:String!", "$name:String!"];
  const fields: string[] = [];
  paths.forEach((path, i) => {
    const key = `e${String(i)}`;
    variables[key] = `${headOid}:${toRepoPath(path)}`;
    declarations.push(`$${key}:String!`);
    fields.push(`b${String(i)}: object(expression:$${key}){ ... on Blob { oid } }`);
  });
  return {
    query: `query(${declarations.join(",")}){repository(owner:$owner,name:$name){${fields.join(" ")}}}`,
    variables,
  };
}

/** Map the aliased blob response back onto the requested paths. */
export function parseBlobQueryResult(
  data: unknown,
  paths: readonly string[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const repository = isRecord(data) ? data["repository"] : undefined;
  paths.forEach((path, i) => {
    const node = isRecord(repository) ? repository[`b${String(i)}`] : undefined;
    const oid = isRecord(node) ? node["oid"] : undefined;
    out.set(toRepoPath(path), typeof oid === "string" ? oid : null);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function parseGraphQLResponse(raw: unknown): GraphQLResponse {
  if (!isRecord(raw)) throw new Error("GitHub GraphQL: response was not a JSON object");
  const rawErrors = raw["errors"];
  const errors = Array.isArray(rawErrors)
    ? rawErrors.map((e): GraphQLError => {
        const rec = isRecord(e) ? e : {};
        const message = rec["message"];
        const type = rec["type"];
        return {
          message: typeof message === "string" ? message : JSON.stringify(e),
          ...(typeof type === "string" ? { type } : {}),
        };
      })
    : undefined;
  return { data: raw["data"], ...(errors !== undefined ? { errors } : {}) };
}

export function createGraphQLClient(opts: {
  token: string;
  fetchFn?: typeof fetch;
  endpoint?: string;
}): GraphQLClient {
  const f = opts.fetchFn ?? fetch;
  const endpoint = opts.endpoint ?? GITHUB_GRAPHQL_ENDPOINT;
  return {
    async request(query, variables) {
      const res = await f(endpoint, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          authorization: `Bearer ${opts.token}`,
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!res.ok) {
        throw new Error(
          `GitHub GraphQL: HTTP ${String(res.status)} — ${(await res.text()).slice(0, 300)}`,
        );
      }
      return parseGraphQLResponse((await res.json()) as unknown);
    },
  };
}

function throwOnErrors(res: GraphQLResponse, label: string): void {
  const errors = res.errors ?? [];
  if (errors.length > 0) throw new Error(`${label}: ${errors.map((e) => e.message).join("; ")}`);
}

export interface BranchHead {
  readonly branchName: string;
  readonly headOid: string;
}

function branchHeadOf(data: unknown, key: string): BranchHead | null {
  const repository = isRecord(data) ? data["repository"] : undefined;
  const ref = isRecord(repository) ? repository[key] : undefined;
  if (!isRecord(ref)) return null;
  const target = ref["target"];
  const name = ref["name"];
  const oid = isRecord(target) ? target["oid"] : undefined;
  if (typeof name !== "string" || typeof oid !== "string") return null;
  return { branchName: name, headOid: oid };
}

/** Resolve the branch (or the repo's default branch) and its current head oid. */
export async function readBranchHead(
  client: GraphQLClient,
  target: { owner: string; name: string; branch?: string | undefined },
): Promise<BranchHead> {
  const nwo = `${target.owner}/${target.name}`;
  if (target.branch === undefined) {
    const res = await client.request(DEFAULT_BRANCH_QUERY, {
      owner: target.owner,
      name: target.name,
    });
    throwOnErrors(res, `signed-commit: reading the default branch of ${nwo}`);
    const head = branchHeadOf(res.data, "defaultBranchRef");
    if (head === null) throw new Error(`signed-commit: ${nwo} has no resolvable default branch`);
    return head;
  }
  const res = await client.request(NAMED_BRANCH_QUERY, {
    owner: target.owner,
    name: target.name,
    qn: qualifyBranch(target.branch),
  });
  throwOnErrors(res, `signed-commit: reading branch ${target.branch} of ${nwo}`);
  const head = branchHeadOf(res.data, "ref");
  if (head === null) {
    throw new Error(
      `signed-commit: ${nwo} has no branch "${target.branch}" — createCommitOnBranch cannot create one`,
    );
  }
  return head;
}

/** Read the current blob oid of each path at `headOid` (null when absent). */
export async function readBlobOids(
  client: GraphQLClient,
  target: { owner: string; name: string },
  headOid: string,
  paths: readonly string[],
): Promise<Map<string, string | null>> {
  if (paths.length === 0) return new Map();
  const { query, variables } = buildBlobQuery(target.owner, target.name, headOid, paths);
  const res = await client.request(query, variables);
  throwOnErrors(res, `signed-commit: reading existing files in ${target.owner}/${target.name}`);
  return parseBlobQueryResult(res.data, paths);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface PublishOptions {
  readonly client: GraphQLClient;
  /** "owner/name". */
  readonly repo: string;
  /** Branch name; omitted means the repository's default branch. */
  readonly branch?: string | undefined;
  readonly message: CommitMessage;
  readonly files: readonly DesiredFile[];
  readonly deletions?: readonly string[];
  readonly maxAttempts?: number;
  readonly maxPayloadBytes?: number;
  readonly log?: (line: string) => void;
}

export type PublishResult =
  | { readonly status: "unchanged"; readonly attempts: number }
  | {
      readonly status: "committed";
      readonly oid: string;
      readonly attempts: number;
      /** Always `verified: true` — an unverified commit throws instead of returning. */
      readonly verification: CommitVerification;
    };

/**
 * Read → plan → commit, retrying from a fresh read when the branch head moved.
 *
 * The retry re-reads the head AND the existing blobs, so a concurrent publish
 * that already wrote our exact content collapses to "unchanged" instead of an
 * empty commit. Nothing here forces or overwrites: exhausting the attempts
 * raises, it does not push harder.
 */
export async function publishSignedCommit(opts: PublishOptions): Promise<PublishResult> {
  const { owner, name } = parseNameWithOwner(opts.repo);
  const log = opts.log ?? ((line: string): void => console.log(line));
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const deletions = opts.deletions ?? [];
  const paths = [...opts.files.map((f) => f.path), ...deletions];

  let lastStale = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const head = await readBranchHead(opts.client, { owner, name, branch: opts.branch });
    const remote = await readBlobOids(opts.client, { owner, name }, head.headOid, paths);
    const plan = planFileChanges(opts.files, deletions, remote);
    for (const absent of plan.alreadyAbsent) log(`skip delete (not present): ${absent}`);
    if (plan.isNoOp) {
      log(`${opts.repo}@${head.branchName}: no change (${plan.unchanged.join(", ")})`);
      return { status: "unchanged", attempts: attempt };
    }
    assertPayloadWithinLimit(plan.changes, opts.maxPayloadBytes ?? MAX_PAYLOAD_BYTES);

    const input = buildCommitInput({
      nameWithOwner: opts.repo,
      branchName: head.branchName,
      expectedHeadOid: head.headOid,
      message: opts.message,
      changes: plan.changes,
    });
    const outcome = classifyMutationResult(
      await opts.client.request(CREATE_COMMIT_MUTATION, { input }),
    );
    if (outcome.kind === "ok") {
      // Prove it, do not assume it: throws unless GitHub reports the commit as
      // Verified. Deliberately BEFORE the success log, so a failed publish can
      // never leave a "created signed commit …" line behind to be believed.
      assertCommitVerified(outcome.verification, { repo: opts.repo, oid: outcome.oid });
      log(
        `${opts.repo}@${head.branchName}: created VERIFIED commit ${outcome.oid} (${outcome.verification.detail})`,
      );
      return {
        status: "committed",
        oid: outcome.oid,
        attempts: attempt,
        verification: outcome.verification,
      };
    }
    if (outcome.kind === "error") {
      throw new Error(`signed-commit: createCommitOnBranch failed — ${outcome.message}`);
    }
    lastStale = outcome.message;
    log(`branch head moved during attempt ${String(attempt)}; re-reading (${outcome.message})`);
  }
  throw new Error(
    `signed-commit: branch head kept moving after ${String(maxAttempts)} attempts — ` +
      `refusing to force. Last error: ${lastStale}`,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CliArgs {
  readonly repo: string;
  readonly branch?: string;
  readonly headline: string;
  readonly body?: string;
  /** `repoPath` → local file to read. */
  readonly adds: readonly { readonly repoPath: string; readonly localPath: string }[];
  readonly deletes: readonly string[];
}

/** `Formula/nimbus.rb=out/nimbus.rb` → both halves. Splits on the FIRST `=`. */
export function parseAddSpec(spec: string): { repoPath: string; localPath: string } {
  const at = spec.indexOf("=");
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`signed-commit: --add expects "<repo-path>=<local-path>", got "${spec}"`);
  }
  return { repoPath: toRepoPath(spec.slice(0, at)), localPath: spec.slice(at + 1) };
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let repo: string | undefined;
  let branch: string | undefined;
  let headline: string | undefined;
  let body: string | undefined;
  const adds: { repoPath: string; localPath: string }[] = [];
  const deletes: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === undefined || !flag.startsWith("--")) continue;
    if (value === undefined) throw new Error(`signed-commit: ${flag} requires a value`);
    i++;
    if (flag === "--repo") repo = value;
    else if (flag === "--branch") branch = value;
    else if (flag === "--message") headline = value;
    else if (flag === "--body") body = value;
    else if (flag === "--add") adds.push(parseAddSpec(value));
    else if (flag === "--delete") deletes.push(toRepoPath(value));
    else throw new Error(`signed-commit: unknown flag ${flag}`);
  }

  if (repo === undefined) throw new Error("signed-commit: --repo <owner/name> is required");
  if (headline === undefined) throw new Error("signed-commit: --message <headline> is required");
  if (adds.length === 0 && deletes.length === 0) {
    throw new Error("signed-commit: at least one --add or --delete is required");
  }
  return {
    repo,
    ...(branch !== undefined ? { branch } : {}),
    headline,
    ...(body !== undefined ? { body } : {}),
    adds,
    deletes,
  };
}

const USAGE = `Usage: bun scripts/release/signed-commit.ts \\
  --repo <owner/name> [--branch <name>] \\
  --message <headline> [--body <text>] \\
  [--add <repo-path>=<local-path> ...] [--delete <repo-path> ...]

Requires GH_TOKEN (or GITHUB_TOKEN) with contents:write on the target repo.`;

if (import.meta.main) {
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"];
  if (token === undefined || token === "") {
    console.error(`signed-commit: GH_TOKEN (or GITHUB_TOKEN) is required.\n\n${USAGE}`);
    process.exit(2);
  }
  let args: CliArgs;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exit(2);
  }
  // Any failure — including "the commit GitHub created is not Verified" — must
  // surface as a red step with an Actions annotation, never a stack trace that
  // scrolls past. A verification failure is not a warning: it exits non-zero.
  let result: PublishResult;
  try {
    result = await publishSignedCommit({
      client: createGraphQLClient({ token }),
      repo: args.repo,
      branch: args.branch,
      message: {
        headline: args.headline,
        ...(args.body !== undefined ? { body: args.body } : {}),
      },
      files: args.adds.map((a) => ({ path: a.repoPath, contents: readFileSync(a.localPath) })),
      deletions: args.deletes,
    });
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (result.status === "unchanged") process.exit(0);
  console.log(`::notice::verified signed commit ${result.oid} on ${args.repo}`);
}
