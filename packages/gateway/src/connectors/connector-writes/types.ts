// packages/gateway/src/connectors/connector-writes/types.ts
import {
  confirmTemplateKeys,
  isSensitiveFieldName,
  parseConfirmTemplate,
} from "./confirm-template.ts";
import { PREPARE_TOOL_IDS } from "./prepare-tools.ts";

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
   * values on the model door's prompt only. Set with {@link withBefore}. Since C3 forty rows
   * have one: the seven comment rows (B1), nine issue writes (B2), five page writes (B3), the
   * Drive file create (B4a, its target folder), the Obsidian append (B4b, the note's end) and the
   * eight Wave 3 file, PR and incident writes (C1: Drive move, rename and trash, the OneDrive move,
   * the GitHub pull request close and the three PagerDuty incident writes) and the four C2 VCS rows
   * (the GitHub branch create, the pull request create and update, the GitLab merge request
   * update) and the five C3 flag and alert writes (the LaunchDarkly toggle and rollout, the
   * Flagsmith state set, the two Jira Operations alert writes); the Jira transition and the two
   * file moves take two reads, and eight rows carry a guard (the Linear update, the four
   * Notion/Confluence page updates and appends with the KB-child guard, the two C2 updates that
   * refuse an empty update, and the C3 LaunchDarkly rollout, which must name every variation).
   */
  readonly before?: BeforeStateReader;
  /**
   * What the owner types to approve this write (Phase 9.7 D0a, spec § 15.4): required on every
   * wave 4 row, on every door. Set with {@link withConfirm}; rendered by `renderConfirmText`.
   */
  readonly confirm?: ConfirmTemplate;
  /**
   * A bound write (Phase 9.7 D0b, I54): the gateway runs this row's PREPARE read at the gate and
   * injects the values it binds into the write's input; the caller never supplies them. Set with
   * {@link withBound}. No row declares one yet.
   */
  readonly bound?: BoundWrite;
}

/**
 * The type-to-confirm target of a row: `{field}` placeholders over the write input's required,
 * non-secret fields (`{field:tail8}` for the last 8 characters of an opaque id), rendered after
 * the service name. The confirm text is `<service>/<rendered>`.
 */
export interface ConfirmTemplate {
  readonly template: string;
  /**
   * An alternative template used when the named OPTIONAL input field is absent, for a tool whose
   * effect changes with it (Snowflake's tag set removes the tag when `value` is omitted): the
   * confirm text must name the effect that will run. Its placeholders obey the same rules as
   * the main template's.
   */
  readonly whenUnset?: { readonly field: string; readonly template: string };
}

/**
 * One value a bound write takes from its prepare reply. `field` is a key of the write tool's input
 * that is never owner-visible input and never caller input: the gateway injects it.
 */
export interface BoundField {
  readonly field: string;
  /** The value from the prepare reply, or `undefined` when the reply does not carry it (refuses). */
  from(reply: unknown): string | undefined;
}

/** The prepare read of a bound write: a PREPARE tool of the row's own connector (`prepare-tools.ts`). */
export interface PrepareRead {
  /** The bare MCP tool id, a member of `PREPARE_TOOL_IDS`. */
  readonly tool: string;
  /** The write-input keys the read depends on; each must be a key the preview template names. */
  readonly argKeys: readonly string[];
  /** The read's input from those keys, or `undefined` when they cannot name a target. */
  args(input: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined;
  /** The labelled prepared facts shown to the owner (a plan summary, a digest). */
  select(reply: unknown): readonly BeforeStateField[];
  /** One timer covers the whole prepare step. */
  readonly budgetMs: number;
  /** The caller's write input, serialised, may not exceed this many characters. */
  readonly maxInputBytes: number;
  /** The prepare reply, serialised, may not exceed this many characters. */
  readonly maxReplyBytes: number;
}

export interface BoundWrite {
  readonly prepare: PrepareRead;
  readonly binds: readonly BoundField[];
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
 * One READ of a before-state reader: a READ tool of the row's own connector (never a write id;
 * `connectors/connector-writes/before-reader.ts` validates it), called with `args` built from the
 * write input's `argKeys` only (the runner hands `args` nothing else).
 */
export interface BeforeStateRead {
  /** The bare MCP tool id of a read on the same connector, e.g. `jira_issue_get`. */
  readonly tool: string;
  /**
   * The write-input keys the read or the selection depends on; each must be a key the preview
   * template names.
   */
  readonly argKeys: readonly string[];
  /** The read's input from those keys, or `undefined` when they cannot name a target. */
  args(input: Readonly<Record<string, unknown>>): Record<string, unknown> | undefined;
}

/** The `[tribal]` knowledge-base destinations (`config/nimbus-toml.ts` `NimbusTribalToml`). */
export interface TribalKbConfig {
  readonly notion?: { readonly databaseId: string };
  readonly confluence?: { readonly spaceKey: string; readonly parentPageId: string };
}

/**
 * What a guard may read besides the write's input and the replies (B3, R11): a frozen snapshot of
 * the gateway config, taken ONCE per `read()` (the runner's `guardContext` accessor, deep-copied
 * and frozen), so `appliesTo` and `allows` see the same values. A guard receives `undefined` when
 * the config could not be read (no accessor, a throw, a non-object): it must then fail closed.
 */
export interface BeforeGuardContext {
  readonly kb: TribalKbConfig | undefined;
}

/**
 * A before-state guard (B2a): when `appliesTo` holds for the write's input, the runner REFUSES the
 * write before the owner's prompt unless every read succeeded and `allows` returns exactly `true`.
 * Fail closed: a throw, a failed, slow, unlisted or policy-refused read, or anything but `true`
 * refuses. `reason` is a fixed, non-empty text with no `{placeholder}`; it is what the model and
 * the write's audit row get. Both functions get the same {@link BeforeGuardContext} snapshot
 * (`undefined`: the config could not be read).
 */
export interface BeforeStateGuard {
  readonly reason: string;
  /**
   * Reads the union pick of the write's input and the context only (never a reply); anything but
   * `false` applies.
   */
  appliesTo(
    picked: Readonly<Record<string, unknown>>,
    ctx: BeforeGuardContext | undefined,
  ): boolean;
  allows(
    reply: unknown,
    picked: Readonly<Record<string, unknown>>,
    alsoReply: unknown,
    ctx: BeforeGuardContext | undefined,
  ): boolean;
}

/**
 * How a write row reads its target's current state: one READ (the fields of
 * {@link BeforeStateRead}), optionally a second one (`also`, run after the first, under the same
 * budget), and a `select` that turns the replies into labelled values. `picked` is the frozen,
 * null-prototype pick of the write input over the union of both reads' `argKeys`; `alsoReply` is
 * `undefined` exactly when `also` is absent. The replies never reach the model or the write's
 * audit row; only the selected, sanitised values reach the owner's prompt.
 */
export interface BeforeStateReader extends BeforeStateRead {
  /** A second read of the same connector; at most two reads, by type. */
  readonly also?: BeforeStateRead;
  /** Refuses the write before the prompt unless the reads prove it allowed (B2a). */
  readonly guard?: BeforeStateGuard;
  /** The labelled current values from the replies. */
  select(
    reply: unknown,
    picked: Readonly<Record<string, unknown>>,
    alsoReply: unknown,
  ): readonly BeforeStateField[];
}

/** The union of a reader's reads' `argKeys`, first read first, without repeats. */
export function beforeReaderArgKeys(reader: BeforeStateReader): readonly string[] {
  return [...new Set([...reader.argKeys, ...(reader.also?.argKeys ?? [])])];
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
 * The structural problems with one read's `argKeys` (empty when none): at least one, no duplicate,
 * each a key the template names. `withBefore` throws on the first; `beforeReaderProblems` lists all.
 */
export function beforeReadArgKeyProblems(
  read: BeforeStateRead,
  named: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  if (read.argKeys.length === 0) out.push("needs at least one argKey");
  if (new Set(read.argKeys).size !== read.argKeys.length) out.push("has a duplicate argKey");
  for (const k of read.argKeys) {
    if (!named.has(k)) out.push(`argKey ${k} is not a key the preview names`);
  }
  return out;
}

/** The problem with a guard's fixed reason, if any: empty, or carrying a `{placeholder}`. */
export function beforeGuardReasonProblem(guard: BeforeStateGuard): string | undefined {
  if (typeof guard.reason !== "string" || guard.reason.trim() === "") {
    return "guard reason must be a non-empty fixed text";
  }
  if (/\{\w+\}/.test(guard.reason)) return "guard reason must not carry a {placeholder}";
  return undefined;
}

/**
 * A frozen copy of `r` carrying `before`. Structural checks only (no import of the read/write
 * classifiers, which import this table): the row has a typed preview, and each read (the first and
 * `also`) has at least one argKey, no duplicate, and every argKey is a key the template names; a
 * guard's reason is fixed text. The read-tool checks are `beforeReaderProblems`, run over every
 * row by its test.
 */
export function withBefore(r: ConnectorWriteRow, before: BeforeStateReader): ConnectorWriteRow {
  if (r.preview === undefined) {
    throw new Error(`connector write before reader: row ${r.toolId} needs a typed preview`);
  }
  const named = previewTemplateKeys(r.preview);
  const reads: ReadonlyArray<readonly [string, BeforeStateRead]> =
    before.also === undefined
      ? [["read", before]]
      : [
          ["read", before],
          ["also read", before.also],
        ];
  for (const [which, read] of reads) {
    const problem = beforeReadArgKeyProblems(read, named)[0];
    if (problem !== undefined) {
      throw new Error(`connector write before reader: row ${r.toolId} ${which} ${problem}`);
    }
  }
  const guardProblem =
    before.guard === undefined ? undefined : beforeGuardReasonProblem(before.guard);
  if (guardProblem !== undefined) {
    throw new Error(`connector write before reader: row ${r.toolId} ${guardProblem}`);
  }
  return Object.freeze({ ...r, before });
}

/**
 * A frozen copy of `r` carrying `confirm`. Throws at declaration when the template is malformed or
 * names no placeholder, when a placeholder is a field the row's preview marks secret, or when a
 * placeholder's name looks like a credential (key, token, secret, password, credential, bearer,
 * auth: by word, with or without a preview template). That a placeholder is a REQUIRED field of
 * the tool's input schema is checked against the installed connector source by a test.
 */
export function withConfirm(r: ConnectorWriteRow, confirm: ConfirmTemplate): ConnectorWriteRow {
  const parsed = parseConfirmTemplate(confirm.template);
  if (!parsed.ok) {
    throw new Error(`connector write confirm: row ${r.toolId} template ${parsed.reason}`);
  }
  const secrets = new Set(
    (r.preview?.fields ?? []).filter((f) => f.kind === "secret").map((f) => f.key),
  );
  const names = confirmTemplateKeys(parsed.segments);
  if (confirm.whenUnset !== undefined) {
    const alt = parseConfirmTemplate(confirm.whenUnset.template);
    if (!alt.ok) {
      throw new Error(`connector write confirm: row ${r.toolId} whenUnset template ${alt.reason}`);
    }
    names.push(...confirmTemplateKeys(alt.segments));
    if (names.includes(confirm.whenUnset.field)) {
      throw new Error(
        `connector write confirm: row ${r.toolId} whenUnset field is also a placeholder`,
      );
    }
  }
  for (const name of names) {
    if (secrets.has(name) || isSensitiveFieldName(name)) {
      throw new Error(
        `connector write confirm: placeholder {${name}} names a secret-looking field (row ${r.toolId})`,
      );
    }
  }
  return Object.freeze({ ...r, confirm });
}

/** The structural problems of a bound declaration (empty when none). */
export function boundWriteProblems(
  r: ConnectorWriteRow,
  bound: BoundWrite,
  prepareToolIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  if (r.preview === undefined) return ["needs a typed preview"];
  const named = previewTemplateKeys(r.preview);
  const { prepare, binds } = bound;
  if (!prepareToolIds.has(prepare.tool)) out.push("prepare tool is not a declared prepare tool");
  if (prepare.tool === r.toolId) out.push("prepare tool is the write tool itself");
  for (const p of beforeReadArgKeyProblems(prepare, named)) out.push(`prepare ${p}`);
  if (binds.length === 0) out.push("needs at least one bound field");
  if (new Set(binds.map((b) => b.field)).size !== binds.length)
    out.push("has a duplicate bound field");
  for (const b of binds) {
    if (b.field === "" || b.field === "mcpToolId")
      out.push(`bound field ${JSON.stringify(b.field)} is not allowed`);
    if (named.has(b.field)) out.push(`bound field ${b.field} is a key the preview names`);
  }
  for (const [name, n] of [
    ["budgetMs", prepare.budgetMs],
    ["maxInputBytes", prepare.maxInputBytes],
    ["maxReplyBytes", prepare.maxReplyBytes],
  ] as const) {
    if (!Number.isInteger(n) || n <= 0) out.push(`prepare ${name} must be a positive integer`);
  }
  return out;
}

/**
 * A frozen copy of `r` carrying `bound`. Throws at declaration on the first problem of
 * {@link boundWriteProblems}. `prepareToolIds` is the test seam (default: the production set,
 * which D42(c) says production code may never replace). That the prepare tool is not a connector
 * write id cannot be checked here (the registry imports this table): the dispatcher refuses it at
 * run time, and `prepare-tools.test.ts` and `rows.test.ts` pin it.
 */
export function withBound(
  r: ConnectorWriteRow,
  bound: BoundWrite,
  prepareToolIds: ReadonlySet<string> = PREPARE_TOOL_IDS,
): ConnectorWriteRow {
  const problem = boundWriteProblems(r, bound, prepareToolIds)[0];
  if (problem !== undefined) {
    throw new Error(`connector write bound: row ${r.toolId} ${problem}`);
  }
  return Object.freeze({ ...r, bound });
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

/**
 * A `write`-transport row with no input fields beyond what its target and summary already show.
 * The wave is stated by every caller (spec § 15, OR-W34-3 moved eight of these to wave 3).
 */
export function fieldlessWrite(
  toolId: string,
  actionType: string,
  wave: ConnectorWriteWave,
  target: string,
  summary: string,
): ConnectorWriteRow {
  return withPreview(row(toolId, actionType, "write", wave), { target, summary, fields: [] });
}
