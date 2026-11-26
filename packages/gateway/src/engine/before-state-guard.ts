/**
 * The pure helpers of the before-state runner (`before-state.ts`, I53): one read's input, the guard
 * context snapshot and the guard's two questions. Moved out of the runner so its read phases fit in
 * one readable list; nothing here reads, gates or dispatches anything.
 */

import { isPlainObject, sanitisePreviewText } from "../connectors/connector-writes/preview.ts";
import {
  BEFORE_STATE_MAX_FIELDS,
  type BeforeGuardContext,
  type BeforeStateField,
  type BeforeStateRead,
  type BeforeStateReader,
  type ConnectorWriteBeforeState,
  type ConnectorWriteRow,
  pickBeforeReaderArgs,
} from "../connectors/connector-writes/types.ts";

/** What the selection and the guard see; `alsoReply` is `undefined` exactly when there is no `also`. */
export interface Replies {
  readonly reply: unknown;
  readonly alsoReply: unknown;
  readonly picked: Readonly<Record<string, unknown>>;
}

/** One read's input from its OWN `argKeys` only; `undefined` when it cannot be built. */
export function readArgs(
  read: BeforeStateRead,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  try {
    const args = read.args(pickBeforeReaderArgs(read.argKeys, input));
    return isPlainObject(args) ? args : undefined;
  } catch {
    return undefined;
  }
}

/** `v` and everything reachable from it frozen (a value already frozen is not walked again). */
function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const inner of Object.values(v)) deepFreeze(inner);
  }
  return v;
}

/**
 * ONE snapshot of the guard context: the accessor's `kb`, deep-copied and frozen. `undefined`
 * (the config could not be read) when there is no accessor, it throws, it returns a non-object,
 * its `kb` is present but not a plain object (`null`, a string, an array), or the copy fails.
 */
export function snapshotGuardContext(
  accessor: (() => BeforeGuardContext) | undefined,
): BeforeGuardContext | undefined {
  if (accessor === undefined) return undefined;
  try {
    const raw: unknown = accessor();
    if (!isPlainObject(raw)) return undefined;
    const kb = raw["kb"];
    if (kb !== undefined && !isPlainObject(kb)) return undefined;
    return deepFreeze(structuredClone({ kb }) as BeforeGuardContext);
  } catch {
    return undefined;
  }
}

/**
 * Whether the reader's guard applies to this write. Fail closed: a non-object input (nothing to
 * pick) or a throwing `appliesTo` applies; only an exact `false` does not.
 */
export function guardApplies(
  reader: BeforeStateReader,
  picked: Readonly<Record<string, unknown>> | undefined,
  ctx: BeforeGuardContext | undefined,
): boolean {
  const guard = reader.guard;
  if (guard === undefined) return false;
  if (picked === undefined) return true;
  try {
    return guard.appliesTo(picked, ctx) !== false;
  } catch {
    return true;
  }
}

/** Whether the guard allows the write over these replies: exactly `true`, never a throw. */
export function guardAllows(
  reader: BeforeStateReader,
  replies: Replies,
  ctx: BeforeGuardContext | undefined,
): boolean {
  try {
    return reader.guard?.allows(replies.reply, replies.picked, replies.alsoReply, ctx) === true;
  } catch {
    return false;
  }
}

/**
 * The reader's fields, sanitised and capped; `undefined` when `select` throws or returns anything
 * but an array of `{ label: string, value: string }`, and, for a Wave 4 row, when no field has a
 * non-blank value. Values are never cut; fields past the cap are
 * counted.
 */
export function selectFields(
  row: ConnectorWriteRow,
  reader: BeforeStateReader,
  replies: Replies,
): ConnectorWriteBeforeState | undefined {
  let raw: unknown;
  try {
    raw = reader.select(replies.reply, replies.picked, replies.alsoReply);
  } catch {
    return undefined;
  }
  if (!Array.isArray(raw)) return undefined;
  const fields: BeforeStateField[] = [];
  for (const entry of raw as unknown[]) {
    if (!isPlainObject(entry)) return undefined;
    const { label, value } = entry;
    if (typeof label !== "string" || typeof value !== "string") return undefined;
    fields.push({ label: sanitisePreviewText(label), value: sanitisePreviewText(value) });
  }
  // D1: a Wave 4 prompt must show the target as it is now, so a selection that shows nothing (no
  // field, or only blank values) counts as a failed read, which a Wave 4 row turns into a refusal.
  if (row.wave === 4 && fields.every((f) => f.value.trim() === "")) return undefined;
  const shown = fields.slice(0, BEFORE_STATE_MAX_FIELDS);
  const notShown = fields.length - shown.length;
  return notShown > 0 ? { status: "ok", fields: shown, notShown } : { status: "ok", fields: shown };
}
