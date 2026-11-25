/**
 * Installed copies carry their build provenance (offline provenance re-verification, slice 2; owner
 * rulings OR-PROV-1 to OR-PROV-5; I51 bound 6). The ONLY module that names the V105 columns
 * `extension.provenance_json` and `extension.provenance_bundle` (a source pin holds it).
 *
 * A registry install that showed provenance keeps what it showed: the five recorded fields, the
 * package hash the signed index pinned, and the offline re-check's result; and, when it was fetched
 * and matched the index, the Sigstore bundle itself, so it can be re-checked offline later
 * (`reverifyInstalledProvenance`). Everything here is evidence for the owner, never a decision:
 * nothing reads it to allow, refuse, enable or rank anything.
 *
 * The record names the version it describes; a read for any other installed version is none, so an
 * update that replaced the code can never be described by the old record.
 */
import type { Database } from "bun:sqlite";
import { MAX_PROVENANCE_BUNDLE_BYTES, type VersionProvenance } from "@nimbus-dev/registry-format";
import { dbRun } from "../../db/write.ts";
import { readIndexedUserVersion } from "../../index/migrations/runner.ts";
import { recheckedProvenanceNote } from "./provenance-recheck.ts";
import {
  type ProvenanceRecheck,
  type ProvenanceRecheckReason,
  verifyProvenanceBundle,
} from "./provenance-verify.ts";

/** The schema version that added the two columns. */
const PROVENANCE_SCHEMA_VERSION = 105;

export interface InstalledProvenanceRecord {
  readonly v: 1;
  readonly version: string;
  readonly registry: string;
  readonly packageSha256: string;
  readonly provenance: VersionProvenance;
  /** Absent when the install made no re-check (the signed entry named no bundle). */
  readonly recheck?: ProvenanceRecheck;
  /** When the install ran the re-check (ms since epoch). */
  readonly checkedAt: number;
}

/** What `extension.info` shows for an installed copy's provenance. */
export interface InstalledProvenanceView {
  readonly note: string;
  readonly recheck?: ProvenanceRecheck;
  readonly checkedAt: number;
  readonly bundleStored: boolean;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const RUNNERS = new Set(["github-hosted", "self-hosted"]);
const REASONS: ReadonlySet<string> = new Set<ProvenanceRecheckReason>([
  "bundle_unavailable",
  "bundle_too_large",
  "bundle_hash_mismatch",
  "bundle_malformed",
  "signature_unverified",
  "not_build_provenance",
  "subject_mismatch",
  "identity_mismatch",
]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === "string" ? (o[k] as string) : undefined;

function readProvenanceFields(v: unknown): VersionProvenance | undefined {
  if (!isObject(v)) return undefined;
  const sourceRepository = str(v, "sourceRepository");
  const commit = str(v, "commit");
  const workflow = str(v, "workflow");
  const runner = str(v, "runner");
  const verifiedAt = str(v, "verifiedAt");
  if (
    sourceRepository === undefined ||
    commit === undefined ||
    workflow === undefined ||
    verifiedAt === undefined ||
    runner === undefined ||
    !RUNNERS.has(runner)
  ) {
    return undefined;
  }
  return {
    sourceRepository,
    commit,
    workflow,
    runner: runner as VersionProvenance["runner"],
    verifiedAt,
  };
}

function readRecheck(v: unknown): ProvenanceRecheck | undefined {
  if (!isObject(v)) return undefined;
  if (
    v["status"] === "verified" &&
    (v["instance"] === "public-good" || v["instance"] === "github")
  ) {
    return { status: "verified", instance: v["instance"] };
  }
  const reason = v["reason"];
  if (v["status"] === "unverified" && typeof reason === "string" && REASONS.has(reason)) {
    return { status: "unverified", reason: reason as ProvenanceRecheckReason };
  }
  return undefined;
}

/** The stored record, shape-checked; `undefined` for anything off-shape. */
function parseRecord(text: string): InstalledProvenanceRecord | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(raw) || raw["v"] !== 1) return undefined;
  const version = str(raw, "version");
  const registry = str(raw, "registry");
  const packageSha256 = str(raw, "packageSha256");
  const checkedAt = raw["checkedAt"];
  const provenance = readProvenanceFields(raw["provenance"]);
  if (
    version === undefined ||
    registry === undefined ||
    packageSha256 === undefined ||
    !HEX64_RE.test(packageSha256) ||
    typeof checkedAt !== "number" ||
    !Number.isSafeInteger(checkedAt) ||
    provenance === undefined
  ) {
    return undefined;
  }
  const recheck = raw["recheck"] === undefined ? undefined : readRecheck(raw["recheck"]);
  if (raw["recheck"] !== undefined && recheck === undefined) return undefined;
  return {
    v: 1,
    version,
    registry,
    packageSha256,
    provenance,
    checkedAt,
    ...(recheck === undefined ? {} : { recheck }),
  };
}

const hasColumns = (db: Database): boolean =>
  readIndexedUserVersion(db) >= PROVENANCE_SCHEMA_VERSION;

/**
 * Stores what a registry install showed of `id`'s provenance. `bundle` is stored only when it is at
 * most `MAX_PROVENANCE_BUNDLE_BYTES` (the caller passes it only after its hash matched the signed
 * index). A database before V105 stores nothing.
 */
export function recordInstalledProvenance(
  db: Database,
  id: string,
  record: InstalledProvenanceRecord,
  bundle: string | null,
): void {
  if (!hasColumns(db)) return;
  const kept =
    bundle !== null && new TextEncoder().encode(bundle).byteLength <= MAX_PROVENANCE_BUNDLE_BYTES
      ? bundle
      : null;
  dbRun(db, "UPDATE extension SET provenance_json = ?, provenance_bundle = ? WHERE id = ?", [
    JSON.stringify(record),
    kept,
    id,
  ]);
}

/** The stored record and bundle for `id` at `version`, or `undefined` (none, stale or off-shape). */
function readStored(
  db: Database,
  id: string,
  version: string,
): { record: InstalledProvenanceRecord; bundle: string | null } | undefined {
  if (!hasColumns(db)) return undefined;
  const row = db
    .query("SELECT provenance_json, provenance_bundle FROM extension WHERE id = ?")
    .get(id) as { provenance_json: string | null; provenance_bundle: string | null } | null;
  if (row?.provenance_json == null) return undefined;
  const record = parseRecord(row.provenance_json);
  if (record?.version !== version) return undefined;
  return { record, bundle: row.provenance_bundle };
}

/** What `extension.info` shows for `id` at its installed `version`, or `undefined`. */
export function readInstalledProvenance(
  db: Database,
  id: string,
  version: string,
): InstalledProvenanceView | undefined {
  const stored = readStored(db, id, version);
  if (stored === undefined) return undefined;
  const { record, bundle } = stored;
  return {
    note: recheckedProvenanceNote(record.provenance, record.registry, record.recheck),
    ...(record.recheck === undefined ? {} : { recheck: record.recheck }),
    checkedAt: record.checkedAt,
    bundleStored: bundle !== null,
  };
}

export type ReverifyResult =
  | { readonly status: "none" }
  | { readonly status: "no_bundle"; readonly note: string }
  | ({ readonly note: string } & ProvenanceRecheck);

/**
 * Re-runs the offline verifier over the STORED bundle against the roots of the running release. No
 * network, no write: the result is shown, never stored or acted on.
 */
export function reverifyInstalledProvenance(
  db: Database,
  id: string,
  version: string,
): ReverifyResult {
  const stored = readStored(db, id, version);
  if (stored === undefined) return { status: "none" };
  const { record, bundle } = stored;
  if (bundle === null) {
    return {
      status: "no_bundle",
      note: recheckedProvenanceNote(record.provenance, record.registry, undefined),
    };
  }
  const recheck = verifyProvenanceBundle({
    bundleBytes: new TextEncoder().encode(bundle),
    packageSha256: record.packageSha256,
    expected: record.provenance,
  });
  return { ...recheck, note: recheckedProvenanceNote(record.provenance, record.registry, recheck) };
}
