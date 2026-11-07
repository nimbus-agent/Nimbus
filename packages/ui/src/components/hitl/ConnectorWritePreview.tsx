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

function RowValue({ row }: { readonly row: Row }): ReactNode {
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

function Rows({ rows }: { readonly rows: readonly Row[] }): ReactNode {
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
      {rows.map((r) => (
        <div key={r.id} className="contents">
          <dt className="text-[var(--color-fg-muted)] break-words">{r.label}</dt>
          <dd className="text-[var(--color-fg)] break-words">
            <RowValue row={r} />
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
      {fields.length > 0 && <Rows rows={fields} />}
      {others.length > 0 && (
        <section data-testid="connector-write-other-fields" className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">Other fields</h3>
          <Rows rows={others} />
        </section>
      )}
      <BeforeState raw={details["before"]} title="Before" testId="connector-write-before" />
      <BeforeState raw={details["prepared"]} title="Prepared" testId="connector-write-prepared" />
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
