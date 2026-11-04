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
    const key = text(rec["key"]);
    if (key === undefined) return [];
    return [{ id: `o${i}`, label: key, kind: "text", value: valueText(rec["value"]) } as Row];
  });
}

function LongText({ value }: { readonly value: string }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= COLLAPSE_AT) return <>{value}</>;
  return (
    <>
      {expanded ? value : `${value.slice(0, COLLAPSE_AT)}…`}
      <span className="block text-xs text-[var(--color-fg-muted)]">
        {value.length.toLocaleString("en-US")} characters
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
    </div>
  );
}
