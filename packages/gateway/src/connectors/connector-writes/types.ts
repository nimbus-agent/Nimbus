// packages/gateway/src/connectors/connector-writes/types.ts

/** `write` rows have a dispatch path (the credential-aware transport); `mesh` rows are refused by
 *  the I26 predicate and run only through the executor's mesh path behind the owner's HITL gate. */
export type ConnectorWriteTransport = "write" | "mesh";

/**
 * Which credential kind a write to `service` will use. Config-derived (never read from the
 * payload). Lives here, not in the executor, so the preview builder never imports the executor.
 */
export type PreviewCredentialResolver = (service: string) => "personal" | "team";

/** The migration wave the row was classified in. */
export type ConnectorWriteWave = 2 | 3 | 4;

export interface ConnectorWriteRow {
  readonly toolId: string;
  readonly actionType: string;
  readonly transport: ConnectorWriteTransport;
  readonly wave: ConnectorWriteWave;
  /** Set only for a tool that mutates while upstream registers it as a READ (invisible to the scanner). */
  readonly registeredAs?: "read";
  /** How the owner's consent prompt shows this write's input; absent = today's raw prompt. */
  readonly preview?: ConnectorWritePreviewTemplate;
  /**
   * Reads the target's current state for the typed preview (spec § 5.4), shown beside the new
   * values on the model door's prompt only. Set with {@link withBefore}. No row has one in B0b.
   */
  readonly before?: BeforeStateReader;
}

/** At most this many before-state fields are shown; the rest are counted, never cut. */
export const BEFORE_STATE_MAX_FIELDS = 20;

export interface BeforeStateField {
  readonly label: string;
  readonly value: string;
}

/** Why a before-state could not be shown. A closed set: error text never reaches the prompt. */
export type BeforeStateUnavailableReason =
  | "timeout"
  | "failed"
  | "not configured"
  | "policy requires approval";

/**
 * The current state shown beside a write's new values on the model door's prompt. `fields` are
 * sanitised and at most {@link BEFORE_STATE_MAX_FIELDS}; `notShown` counts the rest (present only
 * when some were dropped).
 */
export type ConnectorWriteBeforeState =
  | {
      readonly status: "ok";
      readonly fields: readonly BeforeStateField[];
      readonly notShown?: number;
    }
  | { readonly status: "unavailable"; readonly reason: BeforeStateUnavailableReason };

/**
 * How a write row reads its target's current state: one READ tool of the row's own connector
 * (never a write id; `connectors/connector-writes/before-reader.ts` validates it), called with
 * `args` built from the write input's `argKeys` only (the runner hands `args` nothing else), and a
 * `select` that turns the reply into labelled values. The reply never reaches the model or the
 * write's audit row; only the selected, sanitised values reach the owner's prompt.
 */
export interface BeforeStateReader {
  /** The bare MCP tool id of a read on the same connector, e.g. `jira_issue_get`. */
  readonly tool: string;
  /** The write-input keys the read depends on; each must be a key the preview template names. */
  readonly argKeys: readonly string[];
  /** The read's input from those keys, or `undefined` when they cannot name a target. */
  args(input: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined;
  /** The labelled current values from the read's reply. */
  select(reply: unknown): readonly BeforeStateField[];
}

/**
 * A frozen, null-prototype copy of `input` holding only `argKeys` (each own key present). The
 * runner hands `reader.args` this and nothing else, so a reader can never base its read on a key
 * it did not declare.
 */
export function pickBeforeReaderArgs(
  argKeys: readonly string[],
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const k of argKeys) {
    if (Object.hasOwn(input, k)) out[k] = input[k];
  }
  return Object.freeze(out);
}

/** A `{key}` placeholder in a preview template's target or summary (global: use with matchAll/replace). */
export const TEMPLATE_PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Every input key a template names: each `fields[].key` (including fields that carry `whenUnset`)
 * and each `{key}` placeholder in `target` and `summary`. The connector-write door's drift check
 * and the before-reader check read the same set.
 */
export function previewTemplateKeys(t: ConnectorWritePreviewTemplate): Set<string> {
  const named = new Set<string>(t.fields.map((f) => f.key));
  for (const text of [t.target, t.summary]) {
    for (const m of text.matchAll(TEMPLATE_PLACEHOLDER)) {
      if (m[1] !== undefined) named.add(m[1]);
    }
  }
  return named;
}

/**
 * A frozen copy of `r` carrying `before`. Structural checks only (no import of the read/write
 * classifiers, which import this table): the row has a typed preview, at least one argKey, no
 * duplicate, and every argKey is a key the template names. The read-tool checks are
 * `beforeReaderProblems`, run over every row by its test.
 */
export function withBefore(r: ConnectorWriteRow, before: BeforeStateReader): ConnectorWriteRow {
  if (r.preview === undefined) {
    throw new Error(`connector write before reader: row ${r.toolId} needs a typed preview`);
  }
  if (before.argKeys.length === 0) {
    throw new Error(`connector write before reader: row ${r.toolId} needs at least one argKey`);
  }
  if (new Set(before.argKeys).size !== before.argKeys.length) {
    throw new Error(`connector write before reader: row ${r.toolId} has a duplicate argKey`);
  }
  const named = previewTemplateKeys(r.preview);
  for (const k of before.argKeys) {
    if (!named.has(k)) {
      throw new Error(
        `connector write before reader: argKey ${k} is not a key the preview of ${r.toolId} names`,
      );
    }
  }
  return Object.freeze({ ...r, before });
}

export type PreviewFieldKind = "text" | "markdown" | "list" | "secret";

export interface PreviewFieldTemplate {
  readonly key: string;
  readonly label: string;
  readonly kind: PreviewFieldKind;
  /** Text shown when the input omits the key (its real default), instead of `(not set)`. */
  readonly whenUnset?: string;
}

/** A plain text preview field; the label defaults to the key. */
export function textField(key: string, label?: string, whenUnset?: string): PreviewFieldTemplate {
  return {
    key,
    label: label ?? key,
    kind: "text",
    ...(whenUnset === undefined ? {} : { whenUnset }),
  };
}

export interface ConnectorWritePreviewTemplate {
  /** `{key}` placeholders over top-level input keys, e.g. "{namespace}/{name}". */
  readonly target: string;
  readonly summary: string;
  readonly fields: readonly PreviewFieldTemplate[];
}

/** A frozen copy of `r` carrying `preview`. */
export function withPreview(
  r: ConnectorWriteRow,
  preview: ConnectorWritePreviewTemplate,
): ConnectorWriteRow {
  const secrets = new Set(preview.fields.filter((f) => f.kind === "secret").map((f) => f.key));
  for (const text of [preview.target, preview.summary]) {
    for (const m of text.matchAll(TEMPLATE_PLACEHOLDER)) {
      if (m[1] !== undefined && secrets.has(m[1])) {
        throw new Error(
          `connector write preview: placeholder {${m[1]}} names a secret field (row ${r.toolId})`,
        );
      }
    }
  }
  return Object.freeze({ ...r, preview });
}

/** One-line builder. Argument order: tool id FIRST, then action type. */
export function row(
  toolId: string,
  actionType: string,
  transport: ConnectorWriteTransport,
  wave: ConnectorWriteWave,
  registeredAs?: "read",
): ConnectorWriteRow {
  return Object.freeze(
    registeredAs === undefined
      ? { toolId, actionType, transport, wave }
      : { toolId, actionType, transport, wave, registeredAs },
  );
}

/** One dispatchable connector write: its HITL action.type, its MCP tool id, and its service id.
 *  Derived from the `write`-transport rows (`CONNECTOR_WRITES` in `connector-write-registry.ts`). */
export interface ConnectorWrite {
  readonly actionType: string;
  readonly toolId: string;
  readonly service: string;
}

/** A wave-4 write with no input fields beyond what its target and summary already show. */
export function fieldlessWrite(
  toolId: string,
  actionType: string,
  target: string,
  summary: string,
): ConnectorWriteRow {
  return withPreview(row(toolId, actionType, "write", 4), { target, summary, fields: [] });
}
