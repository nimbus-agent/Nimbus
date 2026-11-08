/**
 * The prepare step of a BOUND connector write (Phase 9.7 D0b, invariant I54, static rule D42).
 *
 * A bound row (`ConnectorWriteRow.bound`) cannot be dispatched with what the caller sent: the
 * gateway first runs the row's PREPARE tool (`connectors/connector-writes/prepare-tools.ts`), takes
 * the values the row binds (a plan's digest, a change set's id) from its reply, shows the prepared
 * facts to whoever approves, and injects those values into the write's input itself. This module is
 * the step; `engine/executor.ts` is the only caller, from the gate's `preparePhase`, and the only
 * place the values are injected (`dispatchBoundPhase`). The prepare read:
 *
 *  - is a `<service>.write.prepare` `PlannedAction` through the SAME executor's `gate()` and then
 *    its dispatcher, so it has its own audit row and its own I29 egress row, and a type that would
 *    need approval is refused without asking anyone ({@link PREPARE_HITL_REFUSAL});
 *  - is subject to ONE timer (the row's `budgetMs`) over its gate and dispatch together, after
 *    which a late reply is dropped, and to the row's input and reply size caps;
 *  - fails closed on EVERY door: a refusal is one of the fixed reasons in {@link PREPARE_REFUSALS}
 *    (never error text), and it ends the gate before any prompt;
 *  - never reaches the model: only the selected, sanitised facts reach the approver's preview.
 *
 * The caller can never supply a bound field: an action that arrives holding one, at the payload
 * root or inside `payload.input`, is refused ({@link boundInputRefusal}), and the injection strips
 * both levels before it writes the gateway's own values.
 */

import { type PreviewDiff, renderUnifiedDiff } from "../connectors/connector-writes/diff.ts";
import { isPlainObject, sanitisePreviewText } from "../connectors/connector-writes/preview.ts";
import {
  BEFORE_STATE_MAX_FIELDS,
  type BeforeStateField,
  type BoundField,
  type BoundWrite,
  type ConnectorWriteRow,
  pickBeforeReaderArgs,
} from "../connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { serviceOf } from "./service-of.ts";
import { extractToolInput } from "./tool-input.ts";
import type { ActionResult, PlannedAction } from "./types.ts";

/** The one spelling of the prepare action-type suffix (D42(a): confined to this module and its guards). */
const PREPARE_SUFFIX = ".write.prepare";

/** The audit reason `gate()` records when it refuses a prepare type that would need approval. */
export const PREPARE_HITL_REFUSAL = "policy requires approval";

/** `<service>.write.prepare`: the step's action type, so `serviceOf` names the connector (I29). */
export function prepareActionType(service: string): string {
  return `${service}${PREPARE_SUFFIX}`;
}

export function isPrepareActionType(actionType: string): boolean {
  return actionType.endsWith(PREPARE_SUFFIX);
}

/** Every reason the step can refuse a write: fixed text, never an error message or a value. */
export const PREPARE_REFUSALS = Object.freeze({
  callerBound: "prepare: the request carries a field only the gateway may set",
  notObject: "prepare: the input is not an object",
  inputTooLarge: "prepare: the input is too large",
  toolNotAllowed: "prepare: the row names a tool that is not a declared prepare tool",
  toolUnavailable: "prepare: the prepare tool is unavailable",
  argsFailed: "prepare: the input cannot name a target",
  refused: "prepare: the gate refused the prepare read",
  timeout: "prepare: the prepare read timed out",
  failed: "prepare: the prepare read failed",
  replyTooLarge: "prepare: the prepare reply is too large",
  unbound: "prepare: the prepare reply does not carry a required value",
  unshowable: "prepare: the prepare reply cannot be shown",
  diffTooLarge: "prepare: the change is too large to show in full",
  nothingToCommit: "prepare: the change would change nothing",
});

/** Thrown by {@link runPrepareStep}; `gate()` records it as a rejection with this fixed reason. */
export class PrepareRefusedError extends Error {
  override readonly name = "PrepareRefusedError";
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** What the step needs from the executor that runs it: its own gate and its own dispatcher. */
export interface PrepareOps {
  gate(action: PlannedAction): Promise<ActionResult | "proceed">;
  dispatch(action: PlannedAction): Promise<unknown>;
}

export interface PrepareStepOptions {
  /** The declared prepare tools (production: `PREPARE_TOOL_IDS`; tests: the executor's seam). */
  readonly prepareToolIds: ReadonlySet<string>;
  /** The door found the prepare tool missing from its server's listing. */
  readonly toolUnlisted?: boolean;
  readonly timers?: {
    set(fn: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

/** What a successful step hands the gate: the facts to show and the values to inject. */
export interface PreparedWrite {
  readonly binds: readonly BoundField[];
  /** One string per bound field, produced by this step's prepare reply only. */
  readonly values: Readonly<Record<string, string>>;
  readonly fields: readonly BeforeStateField[];
  readonly notShown?: number;
  /** The change as a unified diff the GATEWAY rendered (D1c, D42(g)); only for a row with `prepare.diff`. */
  readonly diff?: PreviewDiff;
}

/** The JSON length of `v`; `Infinity` when it cannot be encoded (so a cap always refuses it). */
function serialisedLength(v: unknown): number {
  try {
    return (JSON.stringify(v) ?? "").length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Why this action may not enter the prepare step, or `undefined`. Pure, and run FIRST by the gate
 * (before any read or prompt): the input must be an object, none of the gateway-bound fields may
 * be present at the payload root or inside `payload.input` (own keys, so `__proto__`-style names
 * count), the serialised input stays within the row's cap, and the row's own pure input hook (the
 * commit rows' file count, path and content rules) finds nothing to refuse. A hook that throws, or
 * returns anything but a string or `undefined`, refuses: fail closed.
 */
export function boundInputRefusal(bound: BoundWrite, action: PlannedAction): string | undefined {
  const input = extractToolInput(action);
  if (!isPlainObject(input)) return PREPARE_REFUSALS.notObject;
  const root = action.payload ?? {};
  const supplied = bound.binds.some(
    (b) => Object.hasOwn(root, b.field) || Object.hasOwn(input, b.field),
  );
  if (supplied) return PREPARE_REFUSALS.callerBound;
  if (serialisedLength(input) > bound.prepare.maxInputBytes) return PREPARE_REFUSALS.inputTooLarge;
  return rowInputRefusal(bound, input);
}

function rowInputRefusal(
  bound: BoundWrite,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  const hook = bound.prepare.inputRefusal;
  if (hook === undefined) return undefined;
  try {
    const reason: unknown = hook(input);
    if (reason === undefined) return undefined;
    return typeof reason === "string" ? reason : PREPARE_REFUSALS.notObject;
  } catch {
    return PREPARE_REFUSALS.notObject;
  }
}

function omitKeys(
  from: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  // fromEntries defines own properties, so a `__proto__` key is kept as data, never as a prototype.
  return Object.fromEntries(Object.entries(from).filter(([k]) => !keys.includes(k)));
}

/**
 * The action the dispatcher gets: the approved action with every bound field stripped from the
 * payload root and from `payload.input`, then the gateway's own values written where the tool
 * input lives (`payload.input` when the action carries one, else the root, exactly as
 * `extractToolInput` resolves it). A value the prepare step did not produce throws.
 */
export function injectBoundFields(
  action: PlannedAction,
  binds: readonly BoundField[],
  values: Readonly<Record<string, string>>,
): PlannedAction {
  const fields = binds.map((b) => b.field);
  const injected = Object.fromEntries(
    fields.map((f) => {
      const v = values[f];
      if (typeof v !== "string")
        throw new Error("bound field was not produced by the prepare step");
      return [f, v] as const;
    }),
  );
  const payload = action.payload ?? {};
  const root = omitKeys(payload, fields);
  const nested = payload["input"];
  if (Object.hasOwn(payload, "input") && isPlainObject(nested)) {
    return { ...action, payload: { ...root, input: { ...omitKeys(nested, fields), ...injected } } };
  }
  return { ...action, payload: { ...root, ...injected } };
}

type Gated =
  | { readonly kind: "refused" }
  | { readonly kind: "spent" }
  | { readonly kind: "reply"; readonly reply: unknown };

async function gateThenDispatch(
  action: PlannedAction,
  ops: PrepareOps,
  spent: () => boolean,
): Promise<Gated> {
  const gated = await ops.gate(action);
  if (gated !== "proceed") return { kind: "refused" };
  // A budget that ran out while the gate was pending: nothing reaches the connector.
  if (spent()) return { kind: "spent" };
  return { kind: "reply", reply: await ops.dispatch(action) };
}

type Timers = NonNullable<PrepareStepOptions["timers"]>;

/** The reply, or the fixed reason none can be had. */
async function raceWithBudget(
  start: (spent: () => boolean) => Promise<Gated>,
  budgetMs: number,
  timers: Timers,
): Promise<{ readonly reply: unknown } | { readonly refusal: string }> {
  let handle: unknown;
  let expired = false;
  const timedOut = new Promise<"timeout">((resolve) => {
    handle = timers.set(() => {
      expired = true;
      resolve("timeout");
    }, budgetMs);
  });
  const inFlight = start(() => expired);
  // A failure that lands after the budget has no awaiting consumer; keep it handled.
  inFlight.catch(() => undefined);
  try {
    const first = await Promise.race([inFlight, timedOut]);
    if (first === "timeout" || first.kind === "spent") return { refusal: PREPARE_REFUSALS.timeout };
    if (first.kind === "refused") return { refusal: PREPARE_REFUSALS.refused };
    return { reply: first.reply };
  } catch (err) {
    const missing = err instanceof Error && err.message === "Tool not found";
    return { refusal: missing ? PREPARE_REFUSALS.toolUnavailable : PREPARE_REFUSALS.failed };
  } finally {
    timers.clear(handle);
  }
}

function boundValues(bound: BoundWrite, reply: unknown): Record<string, string> | undefined {
  const entries: Array<readonly [string, string]> = [];
  for (const b of bound.binds) {
    let v: unknown;
    try {
      v = b.from(reply);
    } catch {
      return undefined;
    }
    if (typeof v !== "string" || v === "") return undefined;
    entries.push([b.field, v]);
  }
  return Object.fromEntries(entries);
}

function shownFacts(
  bound: BoundWrite,
  reply: unknown,
): { fields: BeforeStateField[]; notShown: number } | undefined {
  let raw: unknown;
  try {
    raw = bound.prepare.select(reply);
  } catch {
    return undefined;
  }
  // An empty selection would let a bound write reach approval showing nothing (I54): unshowable.
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const all: BeforeStateField[] = [];
  for (const entry of raw as unknown[]) {
    if (!isPlainObject(entry)) return undefined;
    const { label, value } = entry;
    if (typeof label !== "string" || typeof value !== "string") return undefined;
    all.push({ label: sanitisePreviewText(label), value: sanitisePreviewText(value) });
  }
  const fields = all.slice(0, BEFORE_STATE_MAX_FIELDS);
  return { fields, notShown: all.length - fields.length };
}

function prepareArgs(
  bound: BoundWrite,
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  try {
    const args = bound.prepare.args(pickBeforeReaderArgs(bound.prepare.argKeys, input));
    return isPlainObject(args) ? args : undefined;
  } catch {
    return undefined;
  }
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The change a bound write will make, rendered by THIS module from the caller's input (the after
 * side) and the reply's old text (the before side); nothing else in the reply is read (D42(g)). A
 * row with no `prepare.diff` has none. Every failure is one of the fixed reasons.
 */
function preparedDiff(
  bound: BoundWrite,
  input: Readonly<Record<string, unknown>>,
  reply: unknown,
): PreviewDiff | undefined {
  const spec = bound.prepare.diff;
  if (spec === undefined) return undefined;
  let files: ReturnType<typeof spec.files>;
  try {
    files = spec.files(pickBeforeReaderArgs(bound.prepare.argKeys, input), reply);
  } catch {
    files = undefined;
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new PrepareRefusedError(PREPARE_REFUSALS.unshowable);
  }
  const oldBytes = files.reduce((n, f) => n + utf8Length(f.oldContent ?? ""), 0);
  if (oldBytes > spec.maxOldBytes) throw new PrepareRefusedError(PREPARE_REFUSALS.replyTooLarge);
  const rendered = renderUnifiedDiff(files, { maxBytes: spec.maxDiffBytes });
  if (!rendered.ok) throw new PrepareRefusedError(PREPARE_REFUSALS.diffTooLarge);
  if (rendered.diff.files.every((f) => f.state === "unchanged")) {
    throw new PrepareRefusedError(PREPARE_REFUSALS.nothingToCommit);
  }
  return rendered.diff;
}

const REAL_TIMERS: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Run `row`'s prepare read for `action` and return the values to bind and the facts to show.
 * Throws {@link PrepareRefusedError} on every failure. `boundInputRefusal` has already passed
 * (the gate runs it first); the one caller is `ToolExecutor.preparePhase`.
 */
export async function runPrepareStep(
  ops: PrepareOps,
  row: ConnectorWriteRow,
  bound: BoundWrite,
  action: PlannedAction,
  opts: PrepareStepOptions,
): Promise<PreparedWrite> {
  const { prepare } = bound;
  if (!opts.prepareToolIds.has(prepare.tool)) {
    throw new PrepareRefusedError(PREPARE_REFUSALS.toolNotAllowed);
  }
  if (opts.toolUnlisted === true) throw new PrepareRefusedError(PREPARE_REFUSALS.toolUnavailable);
  const input = extractToolInput(action) as Record<string, unknown>;
  const args = prepareArgs(bound, input);
  if (args === undefined) throw new PrepareRefusedError(PREPARE_REFUSALS.argsFailed);
  const service = serviceOf(row.actionType);
  const readAction: PlannedAction = {
    type: prepareActionType(service),
    payload: { mcpToolId: mcpClientToolKey(service, prepare.tool), input: args },
  };
  const got = await raceWithBudget(
    (spent) => gateThenDispatch(readAction, ops, spent),
    prepare.budgetMs,
    opts.timers ?? REAL_TIMERS,
  );
  if ("refusal" in got) throw new PrepareRefusedError(got.refusal);
  if (serialisedLength(got.reply) > prepare.maxReplyBytes) {
    throw new PrepareRefusedError(PREPARE_REFUSALS.replyTooLarge);
  }
  const diff = preparedDiff(bound, input, got.reply);
  const values = boundValues(bound, got.reply);
  if (values === undefined) throw new PrepareRefusedError(PREPARE_REFUSALS.unbound);
  const shown = shownFacts(bound, got.reply);
  if (shown === undefined) throw new PrepareRefusedError(PREPARE_REFUSALS.unshowable);
  return {
    binds: bound.binds,
    values,
    fields: shown.fields,
    ...(shown.notShown > 0 ? { notShown: shown.notShown } : {}),
    ...(diff === undefined ? {} : { diff }),
  };
}
