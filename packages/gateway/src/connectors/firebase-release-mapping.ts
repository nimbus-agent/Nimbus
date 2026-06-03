import { asRecord, stringField } from "./unknown-record.ts";

export interface FirebaseMappedRow {
  readonly service: "firebase";
  readonly type: "release";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

/** Parse an ISO-8601 timestamp to epoch-ms; null on absent/garbled input. */
function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || value === "") {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function releaseTitle(
  displayVersion: string | undefined,
  buildVersion: string | undefined,
): string {
  const dv = displayVersion !== undefined && displayVersion !== "" ? displayVersion : "?";
  if (buildVersion !== undefined && buildVersion !== "") {
    return `${dv} (${buildVersion})`;
  }
  return dv;
}

/**
 * Map an App Distribution `releases[]` resource to an indexed item.
 *
 * `external_id` = the release resource `name`
 * (`projects/N/apps/A/releases/R`). We index only metadata — display/build
 * version, create time, release notes, and the console URI. The
 * `binaryDownloadUri` is stored as a string but its contents are never fetched
 * (it is a binary download link, not data to index).
 */
export function mapFirebaseReleaseToItem(raw: unknown, syncedAt: number): FirebaseMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const name = stringField(row, "name");
  if (name === undefined || name === "") {
    return null;
  }
  const displayVersion = stringField(row, "displayVersion");
  const buildVersion = stringField(row, "buildVersion");
  const createTime = stringField(row, "createTime");
  const firebaseConsoleUri = stringField(row, "firebaseConsoleUri");
  const testingUri = stringField(row, "testingUri");
  const binaryDownloadUri = stringField(row, "binaryDownloadUri");
  const releaseNotes = asRecord(row["releaseNotes"]) ?? {};
  const releaseNotesText = stringField(releaseNotes, "text");

  // The app id is the 2nd colon-segment up of the release name:
  // projects/N/apps/<appId>/releases/R.
  const appId = name.split("/apps/")[1]?.split("/releases/")[0];

  const title = releaseTitle(displayVersion, buildVersion);
  const createMs = parseIsoMs(createTime);

  const metadata: Record<string, unknown> = {
    app_id: appId ?? null,
    display_version: displayVersion ?? null,
    build_version: buildVersion ?? null,
    create_time: createMs,
    release_notes_text: releaseNotesText ?? null,
    firebase_console_uri: firebaseConsoleUri ?? null,
    testing_uri: testingUri ?? null,
    // Stored only; never fetched.
    binary_download_uri: binaryDownloadUri ?? null,
  };

  return {
    service: "firebase",
    type: "release",
    externalId: name,
    title,
    bodyPreview:
      releaseNotesText !== undefined && releaseNotesText !== "" ? releaseNotesText : title,
    url: firebaseConsoleUri ?? null,
    canonicalUrl: firebaseConsoleUri ?? null,
    modifiedAt: createMs ?? syncedAt,
    metadata,
    syncedAt,
  };
}
