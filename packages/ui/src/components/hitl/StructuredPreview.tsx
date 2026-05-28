import { type ReactNode, useState } from "react";

interface Props {
  readonly details?: Record<string, unknown> | undefined;
  readonly action?: string;
}

const LONG_STRING = 80;

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function ScalarValue({ v }: { readonly v: string | number | boolean }): ReactNode {
  const s = String(v);
  const [expanded, setExpanded] = useState(false);
  if (typeof v === "string" && s.length > LONG_STRING) {
    return (
      <span>
        {expanded ? s : `${s.slice(0, LONG_STRING)}…`}{" "}
        <button
          type="button"
          className="text-[var(--color-accent)] underline"
          onClick={() => setExpanded((x) => !x)}
        >
          {expanded ? "Hide" : "Show full"}
        </button>
      </span>
    );
  }
  return <>{s}</>;
}

function PreviewRows({
  record,
  depth,
}: {
  readonly record: Record<string, unknown>;
  readonly depth: number;
}): ReactNode {
  const keys = Object.keys(record).filter((k) => record[k] !== null && record[k] !== undefined);
  return (
    <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-sm">
      {keys.map((k) => (
        <div key={k} className="contents">
          <dt className="text-[var(--color-fg-muted)]">{k}</dt>
          <dd className="text-[var(--color-fg)] break-words">
            <Value v={record[k]} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Value({ v, depth }: { readonly v: unknown; readonly depth: number }): ReactNode {
  if (v === null || v === undefined) return null;
  if (isScalar(v)) return <ScalarValue v={v} />;
  if (Array.isArray(v)) {
    if (v.every(isScalar)) return <>{v.map(String).join(", ")}</>;
    if (depth >= 1) return <code className="text-xs">{JSON.stringify(v)}</code>;
    return (
      <ul className="list-disc pl-4">
        {v.map((item) => (
          <li key={JSON.stringify(item)}>
            <Value v={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof v === "object") {
    if (depth >= 1) return <code className="text-xs">{JSON.stringify(v)}</code>;
    return <PreviewRows record={v as Record<string, unknown>} depth={depth + 1} />;
  }
  return null;
}

interface AutoUpdatePayload {
  displayName?: string;
  fromVersion?: string;
  toVersion?: string;
  channel?: string;
  changelog?: string;
  publisherStatus?: "verified" | "unverified";
  addedPermissions?: {
    network?: string[];
    filesystem?: { read?: string[]; write?: string[] };
  };
  removedPermissions?: {
    network?: string[];
    filesystem?: { read?: string[]; write?: string[] };
  };
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === "string" ? v : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

function readAutoUpdatePayload(details: Record<string, unknown>): AutoUpdatePayload {
  const added = (details["addedPermissions"] ?? {}) as Record<string, unknown>;
  const removed = (details["removedPermissions"] ?? {}) as Record<string, unknown>;
  const addedFs = (added["filesystem"] ?? {}) as Record<string, unknown>;
  const removedFs = (removed["filesystem"] ?? {}) as Record<string, unknown>;
  const publisherStatusRaw = details["publisherStatus"];
  const publisherStatus =
    publisherStatusRaw === "verified" || publisherStatusRaw === "unverified"
      ? publisherStatusRaw
      : undefined;
  const out: AutoUpdatePayload = {
    addedPermissions: {
      network: readStringArray(added["network"]),
      filesystem: {
        read: readStringArray(addedFs["read"]),
        write: readStringArray(addedFs["write"]),
      },
    },
    removedPermissions: {
      network: readStringArray(removed["network"]),
      filesystem: {
        read: readStringArray(removedFs["read"]),
        write: readStringArray(removedFs["write"]),
      },
    },
  };
  const dn = readStringField(details, "displayName");
  if (dn !== undefined) out.displayName = dn;
  const fv = readStringField(details, "fromVersion");
  if (fv !== undefined) out.fromVersion = fv;
  const tv = readStringField(details, "toVersion");
  if (tv !== undefined) out.toVersion = tv;
  const ch = readStringField(details, "channel");
  if (ch !== undefined) out.channel = ch;
  const cl = readStringField(details, "changelog");
  if (cl !== undefined) out.changelog = cl;
  if (publisherStatus !== undefined) out.publisherStatus = publisherStatus;
  return out;
}

function PermissionRow({
  axis,
  added,
  removed,
}: {
  readonly axis: string;
  readonly added: string[];
  readonly removed: string[];
}): ReactNode {
  if (added.length === 0 && removed.length === 0) return null;
  return (
    <tr>
      <td className="py-1 pr-3 text-[var(--color-fg-muted)] align-top text-sm">{axis}</td>
      <td className="py-1 pr-3 align-top text-sm">
        {added.length === 0 ? (
          <span className="text-[var(--color-fg-muted)]">—</span>
        ) : (
          <ul className="list-disc pl-4">
            {added.map((entry) => (
              <li key={entry} className="text-amber-700">
                <code>{entry}</code>
              </li>
            ))}
          </ul>
        )}
      </td>
      <td className="py-1 align-top text-sm">
        {removed.length === 0 ? (
          <span className="text-[var(--color-fg-muted)]">—</span>
        ) : (
          <ul className="list-disc pl-4">
            {removed.map((entry) => (
              <li key={entry} className="text-neutral-500">
                <code>{entry}</code>
              </li>
            ))}
          </ul>
        )}
      </td>
    </tr>
  );
}

function AutoUpdatePreview({
  payload,
  direction,
}: {
  readonly payload: AutoUpdatePayload;
  readonly direction: "upgrade" | "downgrade";
}): ReactNode {
  const added = payload.addedPermissions;
  const removed = payload.removedPermissions;
  const wider =
    (added?.network?.length ?? 0) > 0 ||
    (added?.filesystem?.read?.length ?? 0) > 0 ||
    (added?.filesystem?.write?.length ?? 0) > 0;
  const publisherClass =
    payload.publisherStatus === "verified" ? "text-green-700" : "text-amber-700";

  return (
    <div data-testid="auto-update-preview" className="flex flex-col gap-3">
      <p className="text-sm">
        {direction === "upgrade" ? "Update extension" : "Roll back extension"}{" "}
        <code>{payload.displayName ?? ""}</code>
      </p>
      <p className="text-sm">
        <strong>{payload.fromVersion ?? ""}</strong> → <strong>{payload.toVersion ?? ""}</strong>{" "}
        {payload.channel !== undefined && (
          <span className="px-1.5 py-0.5 rounded bg-neutral-200 text-xs">{payload.channel}</span>
        )}{" "}
        {payload.publisherStatus !== undefined && (
          <span className={`text-xs ${publisherClass}`}>publisher: {payload.publisherStatus}</span>
        )}
      </p>
      {payload.changelog !== undefined && payload.changelog !== "" && (
        <details>
          <summary className="text-sm cursor-pointer">Changelog</summary>
          <pre
            data-testid="auto-update-changelog"
            className="text-xs whitespace-pre-wrap bg-neutral-50 border rounded p-2 mt-1"
          >
            {payload.changelog}
          </pre>
        </details>
      )}
      {wider && (
        <section
          data-testid="auto-update-permission-diff"
          className="border rounded p-2 bg-amber-50 border-amber-300"
        >
          <h3 className="text-sm font-semibold mb-1">Permission changes</h3>
          <table className="w-full">
            <thead>
              <tr className="text-[var(--color-fg-muted)] text-xs text-left">
                <th className="pr-3">Axis</th>
                <th className="pr-3">Added</th>
                <th>Removed</th>
              </tr>
            </thead>
            <tbody>
              <PermissionRow
                axis="network"
                added={added?.network ?? []}
                removed={removed?.network ?? []}
              />
              <PermissionRow
                axis="filesystem.read"
                added={added?.filesystem?.read ?? []}
                removed={removed?.filesystem?.read ?? []}
              />
              <PermissionRow
                axis="filesystem.write"
                added={added?.filesystem?.write ?? []}
                removed={removed?.filesystem?.write ?? []}
              />
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

export function StructuredPreview({ details, action }: Props): ReactNode {
  if (!details) return null;
  if (action === "extension.autoUpdate") {
    return <AutoUpdatePreview payload={readAutoUpdatePayload(details)} direction="upgrade" />;
  }
  if (action === "extension.downgrade") {
    return <AutoUpdatePreview payload={readAutoUpdatePayload(details)} direction="downgrade" />;
  }
  return <PreviewRows record={details} depth={0} />;
}
