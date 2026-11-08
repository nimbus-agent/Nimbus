// packages/gateway/src/engine/audit-files.ts
// What a write's audit row records of a `files: [{path, content}]` input (Phase 9.7 D1c): the count
// and the total content size, never the file text. The audit payload is capped at 4096 characters
// (`audit/format-audit-payload.ts`), so a 32 KiB commit would be cut mid-file, and file text can hold
// anything (the credential patterns the redactor knows are not all of them). What was approved is
// reconciled by the row's `diffSha256` instead, not by storing the diff.
import { isPlainObject } from "../connectors/connector-writes/preview.ts";

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/**
 * `payload` with its `files` list (at `payload.input` when the action carries one, else at the
 * root) replaced by `{ count, contentBytes }`, or `undefined` when there is no such list: a list
 * whose every entry is an object holding a string `path` and a string `content`.
 */
export function omitFileText(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const nested = payload["input"];
  const inInput = Object.hasOwn(payload, "input") && isPlainObject(nested);
  const holder: Readonly<Record<string, unknown>> = inInput ? nested : payload;
  const files = holder["files"];
  if (!Array.isArray(files) || files.length === 0) return undefined;
  let bytes = 0;
  for (const f of files as unknown[]) {
    if (!isPlainObject(f) || typeof f["path"] !== "string" || typeof f["content"] !== "string") {
      return undefined;
    }
    bytes += utf8Length(f["content"]);
  }
  const summary = { count: files.length, contentBytes: bytes };
  return inInput
    ? { ...payload, input: { ...holder, files: summary } }
    : { ...payload, files: summary };
}
