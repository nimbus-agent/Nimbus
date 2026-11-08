// packages/gateway/src/connectors/connector-writes/commit-limits.ts
// The size and shape limits of a multi-file commit write (Phase 9.7 D1c, spec § 15.3), one table,
// and the PURE input check the commit rows hand to the prepare step (`PrepareRead.inputRefusal`).
// Imports nothing from the row table or the executor. The connector's own caps are looser (192 KiB
// combined, `shared/commit-files.ts`); the gateway's are tighter on purpose, so the diff the owner
// is shown in full is always small enough to read and to carry in one IPC frame.

/** The three caps (and their backstops) of a commit the gateway will prepare and show. */
export const COMMIT_LIMITS = Object.freeze({
  /** Files in one commit. */
  maxFiles: 20,
  /** UTF-8 bytes of new content, summed over the files (checked on the input, before any read). */
  maxNewContentBytes: 32 * 1024,
  /** UTF-8 bytes of old content, summed over the files (checked on the prepare reply). */
  maxOldContentBytes: 32 * 1024,
  /** UTF-8 bytes of the rendered, sanitised diff text (checked after the diff is built). */
  maxDiffBytes: 65_536,
  /** Blunt backstop on the serialised input (JSON characters). */
  maxInputChars: 96 * 1024,
  /** The prepare reply, serialised (JSON characters). */
  maxReplyChars: 262_144,
  /** One timer over the prepare read (the connector walks each path's directories). */
  budgetMs: 30_000,
  /** The connector's own `message` bound. */
  maxMessageChars: 5000,
});

/**
 * Every reason {@link commitInputRefusal} can give: fixed text, never built from the input (so an
 * input cannot put its own words in front of the model or the owner).
 */
export const COMMIT_INPUT_REFUSALS = Object.freeze({
  filesInvalid: "commit: files must be a list of 1 to 20 files",
  fileInvalid: "commit: each file must be exactly a path and its whole new text",
  pathUnsafe: "commit: a file path is not a safe repository path",
  duplicatePath: "commit: the same path appears twice",
  messageInvalid: "commit: the message must be 1 to 5000 characters",
  contentBad: "commit: file text may not contain a NUL or an unpaired surrogate",
  contentTooLarge: "commit: the new file text is over 32 KiB in total",
});

/**
 * A character the approval preview cannot be trusted to show as it is: control (Cc), format (Cf),
 * line and paragraph separator (Zl, Zp) and surrogate (Cs). The connector's own set.
 */
const UNSHOWABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/** NTFS and HFS+ fold trailing dots and spaces and case, and NTFS knows the short name `GIT~1`. */
function isGitSpelling(segment: string): boolean {
  const folded = segment.replace(/[. ]+$/u, "").toLowerCase();
  return folded === "" || folded === ".git" || folded === "git~1";
}

/**
 * Whether `path` is a repository file path a commit may name. This re-implements the connector's
 * `isSafeCommitPath` (`@nimbus-dev/connectors` `shared/commit-files.ts`, which the gateway may not
 * import) and is pinned against it by a table test over the same cases. It is STRICTER in one way:
 * a path that is not NFC-normalised is refused, so two spellings of one name cannot slip past a
 * later prefix check. Run FIRST on every door, before any refusal list, read or diff.
 */
export function isSafeCommitPathGateway(path: string): boolean {
  if (path.length < 1 || path.length > 1024) return false;
  if (path.startsWith("/") || path.endsWith("/") || path.includes("//") || path.includes("\\")) {
    return false;
  }
  if (UNSHOWABLE.test(path)) return false;
  if (path.normalize("NFC") !== path) return false;
  return path.split("/").every((seg) => seg !== "." && seg !== ".." && !isGitSpelling(seg));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** `{path, content}` and nothing else. */
function isCommitFile(v: unknown): v is { path: string; content: string } {
  if (!isRecord(v)) return false;
  const keys = Object.keys(v);
  return (
    keys.length === 2 &&
    Object.hasOwn(v, "path") &&
    Object.hasOwn(v, "content") &&
    typeof v["path"] === "string" &&
    typeof v["content"] === "string"
  );
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Why a commit input may not enter the prepare step, or `undefined`. PURE and fixed-text. Order:
 * shape of `files`, each entry, path safety of EVERY path, uniqueness, the message, then the
 * content (NUL, unpaired surrogate) and the 32 KiB total. Run before any read or prompt.
 */
export function commitInputRefusal(input: Readonly<Record<string, unknown>>): string | undefined {
  if (!isRecord(input)) return COMMIT_INPUT_REFUSALS.filesInvalid;
  const files = input["files"];
  if (!Array.isArray(files) || files.length < 1 || files.length > COMMIT_LIMITS.maxFiles) {
    return COMMIT_INPUT_REFUSALS.filesInvalid;
  }
  const list: unknown[] = files;
  if (!list.every(isCommitFile)) return COMMIT_INPUT_REFUSALS.fileInvalid;
  const typed = list as Array<{ path: string; content: string }>;
  if (!typed.every((f) => isSafeCommitPathGateway(f.path))) return COMMIT_INPUT_REFUSALS.pathUnsafe;
  if (new Set(typed.map((f) => f.path)).size !== typed.length) {
    return COMMIT_INPUT_REFUSALS.duplicatePath;
  }
  const message = input["message"];
  if (
    typeof message !== "string" ||
    message.length < 1 ||
    message.length > COMMIT_LIMITS.maxMessageChars
  ) {
    return COMMIT_INPUT_REFUSALS.messageInvalid;
  }
  if (typed.some((f) => f.content.includes("\u0000") || !f.content.isWellFormed())) {
    return COMMIT_INPUT_REFUSALS.contentBad;
  }
  const bytes = typed.reduce((n, f) => n + utf8Length(f.content), 0);
  if (bytes > COMMIT_LIMITS.maxNewContentBytes) return COMMIT_INPUT_REFUSALS.contentTooLarge;
  return undefined;
}
