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

type SignatureStatus = "verified" | "signature_failed" | "publisher_key_conflict";

/** What the gateway says about the publisher (R6), when it says anything. */
interface PublisherBadge {
  verified: boolean;
  text: string;
}

type Permissions = { network: string[]; filesystem: { read: string[]; write: string[] } };

/**
 * A package the update installs alongside the new version, as the gateway's plan lists it, or an
 * entry that could not be read: it is still shown (and counted), so the list never understates.
 */
type AddedPackageView =
  | {
      unreadable: false;
      id: string;
      version: string;
      registry: string | null;
      starterPack: boolean;
      permissions: Permissions;
    }
  | { unreadable: true };

/** A connector requirement the owner must act on (anything but `met`). */
interface NeedView {
  connector: string;
  text: string;
}

interface AutoUpdatePayload {
  /** What the update adds (absent: nothing, or an older gateway). */
  addedPackages: AddedPackageView[];
  addedUnion?: Permissions;
  needs: NeedView[];
  displayName?: string;
  fromVersion?: string;
  toVersion?: string;
  channel?: string;
  changelog?: string;
  /** Derived from `verificationStatus` (or, from an older gateway, `publisherStatus`). */
  signature?: SignatureStatus;
  badge?: PublisherBadge;
  notes: string[];
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

const SIGNATURE_STATUSES: readonly string[] = [
  "verified",
  "signature_failed",
  "publisher_key_conflict",
];

/**
 * The update's signature status. `publisherStatus` meant "the signature verified" (never "Nimbus
 * verified the publisher"), so an older gateway's `verified` still reads as a verified signature.
 */
function readSignature(details: Record<string, unknown>): SignatureStatus | undefined {
  const v = details["verificationStatus"];
  if (typeof v === "string") {
    return SIGNATURE_STATUSES.includes(v) ? (v as SignatureStatus) : undefined;
  }
  return details["publisherStatus"] === "verified" ? "verified" : undefined;
}

/**
 * The verified-publisher badge, from `verifiedPublisher` (rendered here) or, failing a well-formed
 * one, the gateway's own `publisherBadge` sentence. Neither present (an older gateway, a downgrade):
 * no badge line at all, rather than a claim the gateway did not make.
 */
export function readPublisherBadge(details: Record<string, unknown>): PublisherBadge | undefined {
  const v = details["verifiedPublisher"];
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const github = rec["github"];
    const at = rec["verifiedAt"];
    if (typeof github === "string" && typeof at === "string") {
      return {
        verified: true,
        text: `Verified publisher: @${github} (verified ${at.slice(0, 10)})`,
      };
    }
  }
  const sentence = readStringField(details, "publisherBadge");
  if (sentence !== undefined) return { verified: false, text: "Unverified publisher" };
  return v === null ? { verified: false, text: "Unverified publisher" } : undefined;
}

/** Owner-relevant notes the gateway attaches to a prompt; each is shown as its own line. */
const NOTE_FIELDS: readonly string[] = [
  "publisherChangeNote",
  "runGrantNote",
  "trustFeedNote",
  "provenanceNote",
];

function readNotes(details: Record<string, unknown>): string[] {
  return NOTE_FIELDS.map((k) => readStringField(details, k)).filter(
    (n): n is string => n !== undefined && n !== "",
  );
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function readPermissions(v: unknown): Permissions {
  const rec = asRecord(v);
  const fs = asRecord(rec["filesystem"]);
  return {
    network: readStringArray(rec["network"]),
    filesystem: { read: readStringArray(fs["read"]), write: readStringArray(fs["write"]) },
  };
}

/** One view per entry of the gateway's `addedPackages`; one missing an id or version is unreadable. */
function readAddedPackages(v: unknown): AddedPackageView[] {
  if (!Array.isArray(v)) return [];
  return v.map((entry): AddedPackageView => {
    const rec = asRecord(entry);
    const id = readStringField(rec, "id");
    const version = readStringField(rec, "version");
    if (id === undefined || version === undefined) return { unreadable: true };
    return {
      unreadable: false,
      id,
      version,
      registry: readStringField(rec, "registry") ?? null,
      starterPack: rec["kind"] === "starter-pack",
      permissions: readPermissions(rec["permissions"]),
    };
  });
}

function AddedPackageItem({ p }: { readonly p: AddedPackageView }): ReactNode {
  if (p.unreadable) {
    return <span className="text-red-700">unreadable package entry</span>;
  }
  return (
    <>
      <code>
        {p.id}@{p.version}
      </code>{" "}
      — {p.registry === null ? "a local folder" : `registry ${p.registry}`}
      {p.starterPack && " — starter pack (no code to run)"}
      <div className="text-xs">{permissionsText(p.permissions)}</div>
    </>
  );
}

/** The status after a connector's name, as the CLI's `Needs:` block words it. */
function needText(state: string, fix: readonly string[]): string {
  const run = fix.join(" && ");
  switch (state) {
    case "configured_never_synced":
      return `connected, never synced — run: ${run}`;
    case "not_connected":
      return `not connected — run: ${run}`;
    case "unknown_connector":
      return "not a connector this Nimbus knows";
    case "unknown":
      return "status unavailable";
    default:
      return state;
  }
}

/** The connector requirements the owner must act on: every one whose state is not `met`. */
function readNeeds(v: unknown): NeedView[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((entry) => {
    const rec = asRecord(entry);
    const connector = readStringField(rec, "connector");
    const state = readStringField(rec, "state");
    if (connector === undefined || state === undefined || state === "met") return [];
    return [{ connector, text: needText(state, readStringArray(rec["fix"])) }];
  });
}

function readAutoUpdatePayload(details: Record<string, unknown>): AutoUpdatePayload {
  const added = (details["addedPermissions"] ?? {}) as Record<string, unknown>;
  const removed = (details["removedPermissions"] ?? {}) as Record<string, unknown>;
  const addedFs = (added["filesystem"] ?? {}) as Record<string, unknown>;
  const removedFs = (removed["filesystem"] ?? {}) as Record<string, unknown>;
  const out: AutoUpdatePayload = {
    addedPackages: readAddedPackages(details["addedPackages"]),
    needs: readNeeds(details["connectorRequirements"]),
    notes: readNotes(details),
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
  const signature = readSignature(details);
  if (signature !== undefined) out.signature = signature;
  const badge = readPublisherBadge(details);
  if (badge !== undefined) out.badge = badge;
  if (details["planPermissions"] !== undefined) {
    out.addedUnion = readPermissions(details["planPermissions"]);
  }
  return out;
}

function listOrNone(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

/** One line per axis, as the CLI's plan text shows a package's permissions. */
function permissionsText(p: Permissions): string {
  return `network: ${listOrNone(p.network)} · read: ${listOrNone(p.filesystem.read)} · write: ${listOrNone(p.filesystem.write)}`;
}

/**
 * What the update installs alongside the new version, and the connectors the owner must connect:
 * the same facts the CLI's plan text shows (spec § 4), so a desktop approval never hides a package.
 */
function AddedByUpdate({ payload }: { readonly payload: AutoUpdatePayload }): ReactNode {
  const added = payload.addedPackages;
  return (
    <>
      {added.length > 0 && (
        <section
          data-testid="auto-update-added-packages"
          className="border rounded p-2 bg-amber-50 border-amber-300"
        >
          <h3 className="text-sm font-semibold mb-1">This update adds {added.length} package(s)</h3>
          <ul className="list-disc pl-4 text-sm">
            {added.map((p, i) => (
              // Entries are positional (an unreadable one has no id), and the list never reorders.
              // biome-ignore lint/suspicious/noArrayIndexKey: static list rendered once per prompt
              <li key={i} data-testid="auto-update-added-package">
                <AddedPackageItem p={p} />
              </li>
            ))}
          </ul>
          {payload.addedUnion !== undefined && (
            <p data-testid="auto-update-added-union" className="text-xs mt-1">
              The added packages together: {permissionsText(payload.addedUnion)}
            </p>
          )}
        </section>
      )}
      {payload.needs.length > 0 && (
        <section data-testid="auto-update-needs" className="text-sm">
          <h3 className="font-semibold">Needs</h3>
          <ul className="list-disc pl-4">
            {payload.needs.map((n) => (
              <li key={n.connector}>
                {n.connector}: {n.text}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/** The signature chip: about the SIGNATURE only; none on a key conflict (it was never checked). */
function SignatureChip({ status }: { readonly status: SignatureStatus | undefined }): ReactNode {
  if (status === "verified")
    return <span className="text-xs text-green-700">signature verified</span>;
  if (status === "signature_failed") {
    return <span className="text-xs text-red-700">signature failed</span>;
  }
  return null;
}

function BadgeAndNotes({
  badge,
  notes,
}: {
  readonly badge: PublisherBadge | undefined;
  readonly notes: readonly string[];
}): ReactNode {
  return (
    <>
      {badge !== undefined && (
        <p
          data-testid="publisher-badge"
          className={`text-sm ${badge.verified ? "text-green-700" : "text-[var(--color-fg-muted)]"}`}
        >
          {badge.text}
        </p>
      )}
      {notes.map((n) => (
        <p key={n} className="text-sm">
          {n}
        </p>
      ))}
    </>
  );
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
        <SignatureChip status={payload.signature} />
      </p>
      <BadgeAndNotes badge={payload.badge} notes={payload.notes} />
      <AddedByUpdate payload={payload} />
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

function asText(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function MigrateRow({
  id,
  label,
  value,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string | undefined;
}): ReactNode {
  if (value === undefined) return null;
  return (
    <div className="contents" data-testid={id}>
      <dt className="text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="text-[var(--color-fg)] break-words">{value}</dd>
    </div>
  );
}

/**
 * `extension.migrate` (a bundled connector moving to its signed extension): every field is shown
 * whole and labelled. The generic renderer cuts a string at 80 characters, and the network and
 * known-loss lines are exactly what the owner is deciding on.
 */
const MIGRATE_LABELLED: readonly string[] = [
  "summary",
  "extensionId",
  "version",
  "network",
  "sandbox",
  "readTools",
  "knownLoss",
];

function MigratePreview({ details }: { readonly details: Record<string, unknown> }): ReactNode {
  const publisher = (details["publisher"] ?? {}) as Record<string, unknown>;
  // Anything the gateway adds to the payload that this view does not label is shown generically
  // below, so a new field can never be hidden from the owner. Only the audit-only fields and the
  // ones rendered above (as text) are left out.
  const shown = new Set(["migrationId", "fromRenderer"]);
  for (const key of MIGRATE_LABELLED) {
    if (asText(details[key]) !== undefined) shown.add(key);
  }
  if (asText(publisher["id"]) !== undefined && asText(publisher["fingerprint"]) !== undefined) {
    shown.add("publisher");
  }
  const extras = Object.fromEntries(Object.entries(details).filter(([k]) => !shown.has(k)));
  return (
    <div data-testid="migrate-preview" className="flex flex-col gap-3">
      {asText(details["summary"]) !== undefined && (
        <p className="text-sm">{asText(details["summary"])}</p>
      )}
      <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-1 text-sm">
        <MigrateRow
          id="migrate-extension"
          label="Extension"
          value={asText(details["extensionId"])}
        />
        <MigrateRow id="migrate-version" label="Version" value={asText(details["version"])} />
        <MigrateRow id="migrate-publisher" label="Publisher" value={asText(publisher["id"])} />
        <MigrateRow
          id="migrate-fingerprint"
          label="Key fingerprint"
          value={asText(publisher["fingerprint"])}
        />
        <MigrateRow
          id="migrate-network"
          label="Network access"
          value={asText(details["network"])}
        />
        <MigrateRow id="migrate-sandbox" label="Sandbox" value={asText(details["sandbox"])} />
        <MigrateRow
          id="migrate-read-tools"
          label="Read tools"
          value={asText(details["readTools"])}
        />
        <MigrateRow
          id="migrate-known-loss"
          label="What changes"
          value={asText(details["knownLoss"])}
        />
      </dl>
      {Object.keys(extras).length > 0 && <PreviewRows record={extras} depth={0} />}
    </div>
  );
}

/** Fields `InstallPreview` renders as the badge or a note; everything else is shown generically. */
const INSTALL_RENDERED = new Set(["verifiedPublisher", "publisherBadge", ...NOTE_FIELDS]);

/**
 * `extension.install`: the verified-publisher badge and the notes first, then EVERY other field the
 * gateway sent, generically — a new field can never be hidden from the owner. Not renderer-callable
 * (I7), but a CLI-started install's consent can still reach this popup.
 */
function InstallPreview({ details }: { readonly details: Record<string, unknown> }): ReactNode {
  const rest = Object.fromEntries(
    Object.entries(details).filter(([k]) => !INSTALL_RENDERED.has(k)),
  );
  return (
    <div data-testid="install-preview" className="flex flex-col gap-3">
      <BadgeAndNotes badge={readPublisherBadge(details)} notes={readNotes(details)} />
      <PreviewRows record={rest} depth={0} />
    </div>
  );
}

export function StructuredPreview({ details, action }: Props): ReactNode {
  if (!details) return null;
  if (action === "extension.migrate") return <MigratePreview details={details} />;
  if (action === "extension.install") return <InstallPreview details={details} />;
  if (action === "extension.autoUpdate") {
    return <AutoUpdatePreview payload={readAutoUpdatePayload(details)} direction="upgrade" />;
  }
  if (action === "extension.downgrade") {
    return <AutoUpdatePreview payload={readAutoUpdatePayload(details)} direction="downgrade" />;
  }
  return <PreviewRows record={details} depth={0} />;
}
