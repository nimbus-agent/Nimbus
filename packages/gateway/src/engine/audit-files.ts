// packages/gateway/src/engine/audit-files.ts
// What the audit row and the egress ledger record of a `files: [{path, content}]` input (Phase 9.7
// D1c): the count and the total content size, never the file text. The audit payload is capped at
// 4096 characters (`audit/format-audit-payload.ts`), so a 32 KiB commit would be cut mid-file, and
// file text can hold anything (the credential patterns the redactor knows are not all of them).
// What was approved is reconciled by the row's `diffSha256` and `filesSha256` instead, not by
// storing the diff or the files.
import { createHash } from "node:crypto";
import { isPlainObject } from "../connectors/connector-writes/preview.ts";
import type { PlannedAction } from "./types.ts";

/**
 * The action types whose `files` list is file TEXT: the two multi-file commit writes and the
 * prepare reads of their two services (`<service>.write.prepare`, recognised by its segments so
 * this module names no prepare action-type literal, D42(a)). Any other action keeps its audit
 * detail (a user-MCP tool's own `files` argument, I42, is not rewritten). A test pins this to the
 * bound rows.
 */
export const COMMIT_WRITE_ACTION_TYPES: ReadonlySet<string> = new Set([
  "github.file.commit",
  "gitlab.commit.create",
]);
const COMMIT_SERVICES: ReadonlySet<string> = new Set(["github", "gitlab"]);

/** Whether `type` is a commit write or the prepare read of a commit service. */
export function carriesFileText(type: string): boolean {
  if (COMMIT_WRITE_ACTION_TYPES.has(type)) return true;
  const [service, write, prepare, ...rest] = type.split(".");
  return (
    service !== undefined &&
    COMMIT_SERVICES.has(service) &&
    write === "write" &&
    prepare === "prepare" &&
    rest.length === 0
  );
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

function isFilePair(f: unknown): f is { path: string; content: string } {
  return isPlainObject(f) && typeof f["path"] === "string" && typeof f["content"] === "string";
}

/** Where the action's `files` live: `payload.input` when it is an object, else the payload root. */
function holderOf(payload: Readonly<Record<string, unknown>>): {
  holder: Readonly<Record<string, unknown>>;
  inInput: boolean;
} {
  const nested = payload["input"];
  const inInput = Object.hasOwn(payload, "input") && isPlainObject(nested);
  return { holder: inInput ? nested : payload, inInput };
}

/**
 * `payload` with its `files` value (at `payload.input` when the action carries one, else at the
 * root) replaced by a summary: `{ count, contentBytes }` for a well-formed list (every entry an
 * object holding a string `path` and a string `content`), or `{ count, malformed: true }` for
 * anything else, so the text of a list the gate is about to refuse is never recorded either.
 * `undefined` when there is no `files` key.
 */
export function omitFileText(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const { holder, inInput } = holderOf(payload);
  if (!Object.hasOwn(holder, "files")) return undefined;
  const files: unknown = holder["files"];
  let summary: Record<string, unknown>;
  if (Array.isArray(files) && (files as unknown[]).every(isFilePair)) {
    const pairs = files as Array<{ content: string }>;
    summary = {
      count: pairs.length,
      contentBytes: pairs.reduce((n, f) => n + utf8Length(f.content), 0),
    };
  } else {
    summary = { count: Array.isArray(files) ? files.length : 0, malformed: true };
  }
  return inInput
    ? { ...payload, input: { ...holder, files: summary } }
    : { ...payload, files: summary };
}

/**
 * `action` with its file text omitted when it is one of the commit action types; every other
 * action (and a commit action without `files`) is returned as it is. The ONE rewrite the audit row
 * and the egress ledger both use.
 */
export function withoutFileText(action: PlannedAction): PlannedAction {
  if (action.payload === undefined || !carriesFileText(action.type)) return action;
  const omitted = omitFileText(action.payload);
  return omitted === undefined ? action : { ...action, payload: omitted };
}

/** An 8-byte big-endian length, so concatenated fields cannot be shifted into one another. */
function lengthPrefix(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/**
 * SHA-256 (hex) over the EXACT files a commit write dispatches, in dispatch order: for each file,
 * the 8-byte length and the UTF-8 bytes of its path, then of its content. `undefined` when the
 * action carries no well-formed `files` list. The audit row's `filesSha256`, so what was sent can
 * be reconciled with the connector's own log without storing the text.
 */
export function commitFilesDigest(
  payload: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (payload === undefined) return undefined;
  const files: unknown = holderOf(payload).holder["files"];
  if (!Array.isArray(files) || !(files as unknown[]).every(isFilePair)) return undefined;
  const hash = createHash("sha256");
  for (const f of files as Array<{ path: string; content: string }>) {
    for (const text of [f.path, f.content]) {
      const bytes = Buffer.from(text, "utf8");
      hash.update(lengthPrefix(bytes.length)).update(bytes);
    }
  }
  return hash.digest("hex");
}
