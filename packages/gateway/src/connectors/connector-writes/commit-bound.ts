// packages/gateway/src/connectors/connector-writes/commit-bound.ts
// The bound declarations of the two multi-file commit writes (Phase 9.7 D1c, I54): GitHub's
// `github_file_commit` and GitLab's `gitlab_commit_create`. Each is bound to the head of the branch
// its PREPARE tool (`github_commit_prepare`, `gitlab_commit_prepare`, connectors 0.8) read, injected
// as `expectedHeadSha` by the gateway; the caller can never supply it. The prepare reply also carries
// each file's current text, which the prepare step turns into the unified diff the owner approves
// (`diff.ts`). Imported BY `vcs-ci.ts`; imports nothing from the row table or the executor.
//
// What the connectors reply (read from the installed 0.8.0 source, `connectors/{github,gitlab}/src/
// tools.ts`):
//  - GitHub: `{headSha, files:[{path, exists, mode, oldSha?, oldContent?}]}`; a new file is
//    `{path, exists:false, mode:"100644"}`.
//  - GitLab: `{headSha, files:[{path, exists, lastCommitId?, executable?, oldContent?}]}`.
// GitLab's per-file `last_commit_id` is not a bound field: the write re-reads each existing file at
// `expectedHeadSha` and sends that file's id itself.

import { arrayAt, beforeReplyJson, boolAt, nonEmptyString, stringAt } from "./before-select.ts";
import {
  COMMIT_LIMITS,
  commitInputRefusal,
  GITHUB_COMMIT_KEYS,
  GITLAB_COMMIT_KEYS,
} from "./commit-limits.ts";
import type { DiffInputFile } from "./diff.ts";
import type { BeforeStateField, BoundField, BoundWrite, PrepareRead } from "./types.ts";

/** A plain object. Local: `preview.ts` imports the row table, which imports this module. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

/** The branch head the prepare tool read, lower-cased, or `undefined` unless it is a full 40-hex sha. */
export function commitHeadFrom(reply: unknown): string | undefined {
  try {
    const sha = stringAt(beforeReplyJson(reply), ["headSha"]);
    return sha !== undefined && FULL_SHA.test(sha) ? sha.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const EXPECTED_HEAD: BoundField = { field: "expectedHeadSha", from: commitHeadFrom };

/** `{path, content}` pairs from the write input, or `undefined` when the input is not that shape. */
function filePairs(files: unknown): Array<{ path: string; content: string }> | undefined {
  if (!Array.isArray(files)) return undefined;
  const out: Array<{ path: string; content: string }> = [];
  for (const f of files as unknown[]) {
    if (!isPlainObject(f)) return undefined;
    const { path, content } = f;
    if (typeof path !== "string" || typeof content !== "string") return undefined;
    out.push({ path, content });
  }
  return out;
}

/** The prepare tool's input from the write's own keys, `files` rebuilt as bare `{path, content}` pairs. */
function prepareArgsOf(
  input: Readonly<Record<string, unknown>>,
  target: readonly string[],
): Record<string, unknown> | undefined {
  const files = filePairs(input["files"]);
  if (files === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of target) {
    const v = input[key];
    const named = nonEmptyString(v);
    if (named === undefined) return undefined;
    out[key] = named;
  }
  out["files"] = files;
  return out;
}

/** An own string property, as a string and nothing else (no number is turned into text). */
function strictString(entry: unknown, key: string): string | undefined {
  if (!isPlainObject(entry) || !Object.hasOwn(entry, key)) return undefined;
  const v = entry[key];
  return typeof v === "string" ? v : undefined;
}

/** What the reply says about one file; the BEFORE side is the connector's claim (stated bound). */
interface ReplyFile {
  readonly exists: boolean;
  readonly oldContent: string | undefined;
  readonly mode: string;
}

type ModeOf = (entry: unknown, exists: boolean) => string | undefined;

function replyFiles(reply: unknown, modeOf: ModeOf): Map<string, ReplyFile> | undefined {
  const entries = arrayAt(beforeReplyJson(reply), ["files"]);
  if (entries === undefined) return undefined;
  const byPath = new Map<string, ReplyFile>();
  for (const entry of entries) {
    const path = strictString(entry, "path");
    const exists = boolAt(entry, ["exists"]);
    if (path === undefined || exists === undefined || byPath.has(path)) return undefined;
    const old = strictString(entry, "oldContent");
    // An existing file must carry its text; a new file must not (the connector never sends one).
    if (exists ? old === undefined : old !== undefined) return undefined;
    const mode = modeOf(entry, exists);
    if (mode === undefined) return undefined;
    byPath.set(path, { exists, oldContent: old, mode });
  }
  return byPath;
}

/**
 * Pairs EACH input file with exactly one reply entry of the same path. A missing, extra or
 * duplicate entry, an existing file with no old text or a new one with some, or a mode that cannot
 * be labelled, is `undefined` (the write is refused). The AFTER side is the caller's own text.
 */
function pairFiles(
  picked: Readonly<Record<string, unknown>>,
  reply: unknown,
  modeOf: ModeOf,
): readonly DiffInputFile[] | undefined {
  try {
    const input = filePairs(picked["files"]);
    const got = replyFiles(reply, modeOf);
    if (input === undefined || got?.size !== input.length) return undefined;
    const out: DiffInputFile[] = [];
    for (const f of input) {
      const r = got.get(f.path);
      if (r === undefined) return undefined;
      out.push({
        path: f.path,
        oldContent: r.exists ? r.oldContent : undefined,
        newContent: f.content,
        mode: r.mode,
      });
    }
    return out;
  } catch {
    return undefined;
  }
}

/** GitHub: the mode string the connector reports (`100644`, `100755`). */
const githubModeOf: ModeOf = (entry) => {
  const mode = strictString(entry, "mode");
  return mode !== undefined && /^[0-7]{6}$/.test(mode) ? mode : undefined;
};

/** GitLab: a file that exists reports `executable`; a new one is written as a regular file. */
const gitlabModeOf: ModeOf = (entry, exists) => {
  if (!exists) return "regular";
  const x = boolAt(entry, ["executable"]);
  if (x === undefined) return undefined;
  return x ? "executable" : "regular";
};

function selectHead(reply: unknown, extra: readonly BeforeStateField[]): BeforeStateField[] {
  const json = beforeReplyJson(reply);
  const head = commitHeadFrom(reply);
  if (head === undefined) throw new Error("prepare reply: no head");
  const files = arrayAt(json, ["files"]) ?? [];
  const fresh = files.filter((f) => boolAt(f, ["exists"]) === false).length;
  return [
    {
      label: "Branch head",
      value: `${head} (the commit this change was prepared against; the commit is refused if the branch has moved)`,
    },
    {
      label: "Files",
      value: `${String(fresh)} new, ${String(files.length - fresh)} already in the branch (each is rewritten whole; the diff below shows what changes)`,
    },
    ...extra,
  ];
}

const COMMON: Pick<PrepareRead, "budgetMs" | "maxInputBytes" | "maxReplyBytes"> = {
  budgetMs: COMMIT_LIMITS.budgetMs,
  maxInputBytes: COMMIT_LIMITS.maxInputChars,
  maxReplyBytes: COMMIT_LIMITS.maxReplyChars,
};

const DIFF_LIMITS = {
  maxOldBytes: COMMIT_LIMITS.maxOldContentBytes,
  maxDiffBytes: COMMIT_LIMITS.maxDiffBytes,
};

/** `github_file_commit` is bound to the head `github_commit_prepare` read. */
export const GITHUB_COMMIT_BOUND: BoundWrite = {
  prepare: {
    tool: "github_commit_prepare",
    argKeys: ["owner", "repo", "branch", "files"],
    args: (input) => prepareArgsOf(input, ["owner", "repo", "branch"]),
    select: (reply) => selectHead(reply, []),
    diff: { files: (picked, reply) => pairFiles(picked, reply, githubModeOf), ...DIFF_LIMITS },
    inputRefusal: (input) => commitInputRefusal(input, GITHUB_COMMIT_KEYS),
    ...COMMON,
  },
  binds: [EXPECTED_HEAD],
};

/**
 * `gitlab_commit_create` is bound to the head `gitlab_commit_prepare` read. GitLab has no
 * head-conditional commit, so the connector's head check is not atomic with its write (what protects
 * each existing file is its `last_commit_id`): the preview says so.
 */
export const GITLAB_COMMIT_BOUND: BoundWrite = {
  prepare: {
    tool: "gitlab_commit_prepare",
    argKeys: ["projectPath", "branch", "files"],
    args: (input) => prepareArgsOf(input, ["projectPath", "branch"]),
    select: (reply) =>
      selectHead(reply, [
        {
          label: "Head check",
          value:
            "GitLab cannot make the head check atomic with the commit: other files may change before this lands (a file you rewrite is refused if it changed)",
        },
      ]),
    diff: { files: (picked, reply) => pairFiles(picked, reply, gitlabModeOf), ...DIFF_LIMITS },
    inputRefusal: (input) => commitInputRefusal(input, GITLAB_COMMIT_KEYS),
    ...COMMON,
  },
  binds: [EXPECTED_HEAD],
};
