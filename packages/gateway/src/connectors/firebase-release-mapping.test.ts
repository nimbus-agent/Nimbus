import { describe, expect, test } from "bun:test";

import { mapFirebaseReleaseToItem } from "./firebase-release-mapping.ts";

const SYNCED_AT = 1_700_000_000_000;
const NAME = "projects/1234567890/apps/1:1234567890:android:abc/releases/r1";

describe("mapFirebaseReleaseToItem", () => {
  test("maps a full release resource", () => {
    const row = mapFirebaseReleaseToItem(
      {
        name: NAME,
        displayVersion: "1.0.0",
        buildVersion: "100",
        createTime: "2026-05-30T12:00:00Z",
        releaseNotes: { text: "Initial release" },
        firebaseConsoleUri: "https://console.firebase.google.com/x",
        testingUri: "https://appdistribution.firebase.dev/y",
        binaryDownloadUri: "https://firebaseappdistribution.googleapis.com/bin",
      },
      SYNCED_AT,
    );
    expect(row).not.toBeNull();
    expect(row?.service).toBe("firebase");
    expect(row?.type).toBe("release");
    expect(row?.externalId).toBe(NAME);
    expect(row?.title).toBe("1.0.0 (100)");
    expect(row?.bodyPreview).toBe("Initial release");
    expect(row?.url).toBe("https://console.firebase.google.com/x");
    expect(row?.modifiedAt).toBe(Date.parse("2026-05-30T12:00:00Z"));
    expect(row?.metadata).toMatchObject({
      app_id: "1:1234567890:android:abc",
      display_version: "1.0.0",
      build_version: "100",
      create_time: Date.parse("2026-05-30T12:00:00Z"),
      release_notes_text: "Initial release",
      firebase_console_uri: "https://console.firebase.google.com/x",
      testing_uri: "https://appdistribution.firebase.dev/y",
      binary_download_uri: "https://firebaseappdistribution.googleapis.com/bin",
    });
  });

  test("returns null when name is missing", () => {
    expect(mapFirebaseReleaseToItem({ displayVersion: "1.0" }, SYNCED_AT)).toBeNull();
    expect(mapFirebaseReleaseToItem(null, SYNCED_AT)).toBeNull();
    expect(mapFirebaseReleaseToItem("nope", SYNCED_AT)).toBeNull();
  });

  test("title falls back to ? then display-only", () => {
    expect(mapFirebaseReleaseToItem({ name: NAME }, SYNCED_AT)?.title).toBe("?");
    expect(mapFirebaseReleaseToItem({ name: NAME, displayVersion: "2.0" }, SYNCED_AT)?.title).toBe(
      "2.0",
    );
  });

  test("parses createTime; null and falls back to syncedAt when absent/garbled", () => {
    const absent = mapFirebaseReleaseToItem({ name: NAME }, SYNCED_AT);
    expect(absent?.metadata["create_time"]).toBeNull();
    expect(absent?.modifiedAt).toBe(SYNCED_AT);

    const garbled = mapFirebaseReleaseToItem({ name: NAME, createTime: "whenever" }, SYNCED_AT);
    expect(garbled?.metadata["create_time"]).toBeNull();
  });

  test("body preview falls back to the title when there are no release notes", () => {
    const row = mapFirebaseReleaseToItem(
      { name: NAME, displayVersion: "3.1", buildVersion: "9" },
      SYNCED_AT,
    );
    expect(row?.bodyPreview).toBe("3.1 (9)");
  });

  test("stores nulls for absent optional fields without throwing", () => {
    const row = mapFirebaseReleaseToItem({ name: NAME }, SYNCED_AT);
    expect(row?.metadata["display_version"]).toBeNull();
    expect(row?.metadata["binary_download_uri"]).toBeNull();
    expect(row?.url).toBeNull();
  });
});
