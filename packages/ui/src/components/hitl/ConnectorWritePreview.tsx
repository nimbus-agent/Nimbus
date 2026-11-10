import { type ReactNode, useState } from "react";

/** A value longer than this is collapsed behind "Show full" (never cut: the whole value is one click away). */
const COLLAPSE_AT = 2000;

type FieldKind = "text" | "markdown" | "list" | "secret";

interface Row {
  id: string;
  label: string;
  kind: FieldKind;
  value: string;
}

/** Whether `details` is a typed connector-write preview for this action (the gateway built it for it). */
export function isConnectorWriteDetails(
  details: Record<string, unknown> | undefined,
  action: string | undefined,
): details is Record<string, unknown> {
  return (
    details !== undefined &&
    action !== undefined &&
    details["kind"] === "connector-write" &&
    details["actionType"] === action
  );
}

/**
 * The fixed line the CLI prompt also prints: the gateway sets `requestedBy: "model"` only for an
 * action the model asked for (its top-level origin), so only that exact value draws it.
 */
export function RequestedByModel({
  details,
}: {
  readonly details: Record<string, unknown>;
}): ReactNode {
  if (details["requestedBy"] !== "model") return null;
  return (
    <p data-testid="hitl-requested-by" className="text-sm font-semibold">
      Requested by: the model
    </p>
  );
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** The gateway sends strings; anything else is shown as compact JSON rather than dropped. */
function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? "";
}

function readKind(v: unknown): FieldKind {
  return v === "markdown" || v === "list" || v === "secret" ? v : "text";
}

function readFields(v: unknown): Row[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((entry, i) => {
    const rec = asRecord(entry);
    const label = text(rec["label"]);
    if (label === undefined) return [];
    return [
      { id: `f${i}`, label, kind: readKind(rec["kind"]), value: valueText(rec["value"]) } as Row,
    ];
  });
}

function readOtherFields(v: unknown): Row[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((entry, i) => {
    const rec = asRecord(entry);
    const key = rec["key"];
    if (typeof key !== "string") return [];
    return [
      {
        id: `o${i}`,
        label: key === "" ? "(empty key)" : key,
        kind: "text",
        value: valueText(rec["value"]),
      } as Row,
    ];
  });
}

function LongText({ value }: { readonly value: string }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const points = Array.from(value);
  if (points.length <= COLLAPSE_AT) return <>{value}</>;
  return (
    <>
      {expanded ? value : `${points.slice(0, COLLAPSE_AT).join("")}…`}
      <span className="block text-xs text-[var(--color-fg-muted)]">
        {points.length.toLocaleString("en-US")} characters
      </span>
      <button
        type="button"
        className="text-[var(--color-accent)] underline"
        onClick={() => setExpanded((x) => !x)}
      >
        {expanded ? "Hide" : "Show full"}
      </button>
    </>
  );
}

function RowValue({ row, full }: { readonly row: Row; readonly full: boolean }): ReactNode {
  // A plan-bound write's values (the CloudFormation template above all) are never collapsed: the
  // owner must be able to read every character they are about to approve, in a bounded scroll box.
  if (full) {
    return (
      <div className="max-h-96 overflow-auto rounded border border-[var(--color-border)] p-2">
        <pre
          data-testid="connector-write-full-value"
          className="whitespace-pre-wrap break-words font-mono text-xs"
        >
          {row.value}
        </pre>
      </div>
    );
  }
  // Markdown is shown as plain preformatted text (ruling P2): no HTML, images or links are rendered.
  if (row.kind === "markdown") {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs">
        <LongText value={row.value} />
      </pre>
    );
  }
  return (
    <span className="whitespace-pre-wrap break-words">
      <LongText value={row.value} />
    </span>
  );
}

function Rows({
  rows,
  full = false,
}: {
  readonly rows: readonly Row[];
  readonly full?: boolean;
}): ReactNode {
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map((r) => (
        <div key={r.id} className="contents">
          <dt className="text-[var(--color-fg-muted)] break-words">{r.label}</dt>
          <dd className="text-[var(--color-fg)] break-words">
            <RowValue row={r} full={full} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function headerRows(details: Record<string, unknown>): Row[] {
  const credential = text(asRecord(details["destination"])["credential"]);
  const entries: ReadonlyArray<[string, string, string | undefined]> = [
    ["service", "Service", text(details["service"])],
    ["credential", "Credential", credential],
    ["target", "Target", text(details["target"])],
  ];
  return entries.flatMap(([id, label, value]) =>
    value === undefined ? [] : [{ id, label, kind: "text", value } as Row],
  );
}

/**
 * The gateway's typed preview of a connector write: what will be sent, in the owner's terms. Every
 * string is already sanitised by the gateway and is rendered as a plain text node; the details are
 * read defensively from `unknown`, and nothing is cut.
 */
export function ConnectorWritePreview({
  details,
}: {
  readonly details: Record<string, unknown>;
}): ReactNode {
  const summary = text(details["summary"]);
  const header = headerRows(details);
  const fields = readFields(details["fields"]);
  const others = readOtherFields(details["otherFields"]);
  return (
    <div data-testid="connector-write-preview" className="flex flex-col gap-3">
      <RequestedByModel details={details} />
      {summary !== undefined && (
        <p className="text-sm whitespace-pre-wrap break-words">{summary}</p>
      )}
      {header.length > 0 && <Rows rows={header} />}
      {fields.length > 0 && (
        <Rows rows={fields} full={isPlanBoundAction(asString(details["actionType"]))} />
      )}
      {others.length > 0 && (
        <section data-testid="connector-write-other-fields" className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">Other fields</h3>
          <Rows rows={others} />
        </section>
      )}
      <BeforeState raw={details["before"]} title="Before" testId="connector-write-before" />
      <BeforeState raw={details["prepared"]} title="Prepared" testId="connector-write-prepared" />
      <DiffView raw={details["diff"]} />
      <PlanView raw={details["plan"]} />
      <ProposedBy details={details} />
    </div>
  );
}

/** The four fixed reasons the gateway can send; any other text is not shown. */
const BEFORE_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "timeout",
  "failed",
  "not configured",
  "policy requires approval",
]);

type BeforeView =
  | { readonly status: "ok"; readonly rows: Row[]; readonly notShown: number }
  | { readonly status: "unavailable"; readonly reason: string };

function readBefore(raw: unknown): BeforeView | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const b = asRecord(raw);
  if (b["status"] === "unavailable") {
    const reason = b["reason"];
    return typeof reason === "string" && BEFORE_UNAVAILABLE_REASONS.has(reason)
      ? { status: "unavailable", reason }
      : undefined;
  }
  if (b["status"] !== "ok" || !Array.isArray(b["fields"])) return undefined;
  const rows = (b["fields"] as unknown[]).flatMap((entry, i) => {
    const rec = asRecord(entry);
    const label = rec["label"];
    const value = rec["value"];
    if (typeof label !== "string" || typeof value !== "string") return [];
    return [
      { id: `b${i}`, label: label === "" ? "(empty label)" : label, kind: "text", value } as Row,
    ];
  });
  const n = b["notShown"];
  const notShown = typeof n === "number" && Number.isInteger(n) && n > 0 ? n : 0;
  return { status: "ok", rows, notShown };
}

/**
 * The target's current state, read by the gateway just before this prompt (spec § 5.4), shown
 * after the new values; also the facts a bound write's prepare step produced (I54, titled
 * "Prepared"). Every string is the gateway's sanitised text, rendered as a text node;
 * an unreadable state is one fixed reason, never error text.
 */
function BeforeState({
  raw,
  title,
  testId,
}: {
  readonly raw: unknown;
  readonly title: string;
  readonly testId: string;
}): ReactNode {
  const view = readBefore(raw);
  if (view === undefined) return null;
  return (
    <section data-testid={testId} className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">{title}</h3>
      {view.status === "unavailable" && (
        <p className="text-sm text-[var(--color-fg-muted)]">unavailable ({view.reason})</p>
      )}
      {view.status === "ok" && view.rows.length > 0 && <Rows rows={view.rows} />}
      {view.status === "ok" && view.rows.length === 0 && view.notShown === 0 && (
        <p className="text-sm text-[var(--color-fg-muted)]">(no fields)</p>
      )}
      {view.status === "ok" && view.notShown > 0 && (
        <p className="text-sm text-[var(--color-fg-muted)]">
          ({view.notShown} more {view.notShown === 1 ? "field" : "fields"} not shown)
        </p>
      )}
    </section>
  );
}

function isoTime(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * The MCP act door's proposer (I28), below the gateway-built preview and visually apart from it:
 * who proposed the action and what the agent SAYS it does. That text is the agent's own claim, so
 * it is labelled unverified and never shown as the preview's summary.
 */
function ProposedBy({ details }: { readonly details: Record<string, unknown> }): ReactNode {
  const raw = details["proposedBy"];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = asRecord(raw);
  const label = text(p["clientLabel"]) ?? "unlabelled";
  const entries: ReadonlyArray<[string, string, string | undefined]> = [
    ["client", "MCP client", label],
    [
      "summary",
      "Agent's summary",
      typeof p["unverifiedSummary"] === "string" ? p["unverifiedSummary"] : undefined,
    ],
    ["created", "Proposed at", isoTime(p["createdAt"])],
    ["expires", "Expires", isoTime(p["expiresAt"])],
  ];
  const rows = entries.flatMap(([id, rowLabel, value]) =>
    value === undefined ? [] : [{ id, label: rowLabel, kind: "text", value } as Row],
  );
  return (
    <section
      data-testid="connector-write-proposed-by"
      className="flex flex-col gap-1 rounded border border-dashed border-[var(--color-amber)] p-2"
    >
      <h3 className="text-sm font-semibold">Unverified agent proposal</h3>
      <Rows rows={rows} />
    </section>
  );
}

// ---- The gateway's unified diff of a multi-file commit (D1c, I54) ----------------------------------

interface DiffFileView {
  readonly path: string;
  readonly state: "new" | "modified" | "unchanged";
  readonly mode: string | undefined;
  /** The file's lines exactly as the gateway renders them (header, hunk headers and lines). */
  readonly text: string;
}

interface DiffViewModel {
  readonly files: readonly DiffFileView[];
  readonly additions: number;
  readonly deletions: number;
}

const DIFF_OPS: ReadonlySet<string> = new Set([" ", "+", "-", "\\"]);

function count(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function readHunkText(raw: unknown): string[] | undefined {
  const h = asRecord(raw);
  const nums = [h["oldStart"], h["oldLines"], h["newStart"], h["newLines"]].map(count);
  if (nums.includes(undefined) || !Array.isArray(h["lines"])) return undefined;
  const [oldStart, oldLines, newStart, newLines] = nums as number[];
  const out = [`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`];
  for (const l of h["lines"] as unknown[]) {
    const line = asRecord(l);
    const op = line["op"];
    const t = line["text"];
    if (typeof op !== "string" || !DIFF_OPS.has(op) || typeof t !== "string") return undefined;
    out.push(op === "\\" ? String.raw`\ ${t}` : `${op}${t}`);
  }
  return out;
}

const DIFF_STATE_LABELS = {
  new: "new file",
  unchanged: "no change",
  modified: "modified",
} as const;

function diffFileHeader(path: string, state: DiffFileView["state"], mode: string | undefined) {
  const modeNote = mode === undefined ? "" : `, mode ${mode}`;
  return `=== ${path} (${DIFF_STATE_LABELS[state]}${modeNote})`;
}

function readDiffFile(raw: unknown): DiffFileView | undefined {
  const f = asRecord(raw);
  const path = f["path"];
  const state = f["state"];
  const mode = f["mode"];
  if (typeof path !== "string" || !Array.isArray(f["hunks"])) return undefined;
  if (state !== "new" && state !== "modified" && state !== "unchanged") return undefined;
  if (mode !== undefined && typeof mode !== "string") return undefined;
  const lines = [diffFileHeader(path, state, mode)];
  if (state !== "unchanged") {
    lines.push(state === "new" ? "--- /dev/null" : `--- a/${path}`, `+++ b/${path}`);
    for (const h of f["hunks"] as unknown[]) {
      const hunk = readHunkText(h);
      if (hunk === undefined) return undefined;
      lines.push(...hunk);
    }
  }
  return { path, state, mode, text: lines.join("\n") };
}

/** `undefined` when `raw` is not a well-formed gateway diff. */
function readDiff(raw: unknown): DiffViewModel | undefined {
  const d = asRecord(raw);
  const additions = count(d["additions"]);
  const deletions = count(d["deletions"]);
  if (additions === undefined || deletions === undefined || !Array.isArray(d["files"])) {
    return undefined;
  }
  const files: DiffFileView[] = [];
  for (const entry of d["files"] as unknown[]) {
    const file = readDiffFile(entry);
    if (file === undefined) return undefined;
    files.push(file);
  }
  return { files, additions, deletions };
}

/**
 * The write types whose approval is bound to a diff the gateway renders (the multi-file commits,
 * D1c). For these a MISSING diff is as unapprovable as an unreadable one: the owner would be typing
 * a confirmation for a change the screen never showed.
 */
const DIFF_REQUIRED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "github.file.commit",
  "gitlab.commit.create",
]);

/**
 * Whether the details carry a `diff` the view cannot read, or (for a write type that must carry
 * one) no diff at all. The popup then keeps Approve disabled: an owner is never asked to approve a
 * change the screen could not show in full.
 */
export function isDiffMalformed(
  details: Record<string, unknown> | undefined,
  actionType?: string,
): boolean {
  const required = actionType !== undefined && DIFF_REQUIRED_ACTION_TYPES.has(actionType);
  if (details === undefined || !Object.hasOwn(details, "diff")) return required;
  return readDiff(details["diff"]) === undefined;
}

/**
 * The diff, shown in FULL: every file expanded, ONE `<pre>` text node per file (no per-line
 * elements, no collapse, never cut), inside a bounded scroll box. Text nodes only (I8). Malformed
 * input is an error and nothing else (see {@link isDiffMalformed}).
 */
function DiffView({ raw }: { readonly raw: unknown }): ReactNode {
  if (raw === undefined) return null;
  const diff = readDiff(raw);
  if (diff === undefined) {
    return (
      <p
        data-testid="connector-write-diff-error"
        role="alert"
        className="text-sm text-[var(--color-error)]"
      >
        The change could not be displayed in full, so it cannot be approved here. Reject it.
      </p>
    );
  }
  const n = diff.files.length;
  return (
    <section data-testid="connector-write-diff" className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">
        Changes: {n} {n === 1 ? "file" : "files"}, +{diff.additions} -{diff.deletions}
      </h3>
      <div className="max-h-96 overflow-auto rounded border border-[var(--color-border)] p-2">
        {diff.files.map((file) => (
          <pre
            key={file.path}
            data-testid="connector-write-diff-file"
            className="whitespace-pre-wrap break-words font-mono text-xs"
          >
            {file.text}
          </pre>
        ))}
      </div>
      <p className="text-xs text-[var(--color-fg-muted)]">
        End of diff: {n} {n === 1 ? "file" : "files"}, +{diff.additions} -{diff.deletions}
      </p>
    </section>
  );
}

// ---- The gateway's rendered plan of a plan-bound IaC write (D2, I54) ---------------------------------

interface PlanViewModel {
  /** The plan exactly as the gateway rendered it; its last line is the one footer. */
  readonly lines: readonly string[];
  readonly sha256: string | undefined;
}

/** The footer the gateway's renderers end a plan (Terraform) or a change set (CloudFormation) with. */
const PLAN_FOOTERS: readonly string[] = ["End of plan:", "End of change set:"];
const SHA256_HEX = /^[0-9a-f]{64}$/;

function optionalCount(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isInteger(v) && v >= 0);
}

/**
 * `undefined` unless `raw` is a plan exactly as the gateway builds it: a non-empty list of strings
 * whose LAST line is the renderer's footer (so a cut plan is never taken for a whole one), a
 * 64-character lower-case hex SHA-256, and numeric counts wherever the type has them. A plan that
 * misses any of that is malformed and Approve stays disabled.
 */
function readPlan(raw: unknown): PlanViewModel | undefined {
  const p = asRecord(raw);
  const lines = p["lines"];
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  if (!(lines as unknown[]).every((l) => typeof l === "string")) return undefined;
  const sha = p["sha256"];
  if (typeof sha !== "string" || !SHA256_HEX.test(sha)) return undefined;
  if (!optionalCount(p["changeCount"]) || !optionalCount(p["deleteCount"])) return undefined;
  if (!optionalCount(p["bytes"])) return undefined;
  const last = (lines as string[]).at(-1) as string;
  if (!PLAN_FOOTERS.some((footer) => last.startsWith(footer))) return undefined;
  return { lines: lines as string[], sha256: sha };
}

/**
 * The write types whose approval is bound to a plan or change set the gateway renders (D2, D3a). For
 * these a MISSING plan is as unapprovable as an unreadable one: the owner would be typing a
 * confirmation for a change the screen never showed.
 */
const PLAN_REQUIRED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "iac.terraform.apply",
  "iac.terraform.destroy",
  "iac.cloudformation.deploy",
  // D3a: the Kubernetes apply is plan-bound too (the objects and the diff above the typed text).
  "kubernetes.manifest.apply",
]);

/** Is this a plan-bound write type (IaC or Kubernetes) (its approval must show a plan and carry a typed confirm)? */
export function isPlanBoundAction(actionType: string | undefined): boolean {
  return actionType !== undefined && PLAN_REQUIRED_ACTION_TYPES.has(actionType);
}

/**
 * Whether the details carry a `plan` the view cannot read, or (for a plan-bound write type) no
 * plan at all. The popup then keeps Approve disabled.
 */
export function isPlanMalformed(
  details: Record<string, unknown> | undefined,
  actionType?: string,
): boolean {
  const required = actionType !== undefined && PLAN_REQUIRED_ACTION_TYPES.has(actionType);
  if (details === undefined || !Object.hasOwn(details, "plan")) return required;
  return readPlan(details["plan"]) === undefined;
}

/**
 * The plan, shown in FULL: ONE `<pre>` text node (no per-line elements, no collapse, never cut)
 * inside a bounded scroll box. The gateway's own footer is the last line, so none is added here.
 * Text nodes only (I8). Malformed input is an error and nothing else.
 */
function PlanView({ raw }: { readonly raw: unknown }): ReactNode {
  if (raw === undefined) return null;
  const plan = readPlan(raw);
  if (plan === undefined) {
    return (
      <p
        data-testid="connector-write-plan-error"
        role="alert"
        className="text-sm text-[var(--color-error)]"
      >
        The plan could not be displayed in full, so it cannot be approved here. Reject it.
      </p>
    );
  }
  return (
    <section data-testid="connector-write-plan" className="flex flex-col gap-1">
      <h3 className="text-sm font-semibold">Plan</h3>
      {plan.sha256 !== undefined && (
        <p className="text-xs text-[var(--color-fg-muted)] break-all">SHA-256: {plan.sha256}</p>
      )}
      <div className="max-h-96 overflow-auto rounded border border-[var(--color-border)] p-2">
        <pre
          data-testid="connector-write-plan-text"
          className="whitespace-pre-wrap break-words font-mono text-xs"
        >
          {plan.lines.join("\n")}
        </pre>
      </div>
    </section>
  );
}
