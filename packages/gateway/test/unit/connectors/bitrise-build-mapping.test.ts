import { describe, expect, test } from "bun:test";

import {
  mapBitriseAppToItem,
  mapBitriseBuildToItem,
} from "../../../src/connectors/bitrise-build-mapping.ts";

function makeApp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    slug: "abc123app",
    title: "Acme iOS",
    project_type: "ios",
    repo_url: "https://github.com/acme/ios.git",
    default_branch_name: "main",
    is_disabled: false,
  };
  return { ...base, ...overrides };
}

function makeBuild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    slug: "build-aaa",
    build_number: 42,
    status: 1,
    status_text: "success",
    triggered_workflow: "primary",
    triggered_at: "2026-05-21T10:00:00.000Z",
    started_on_worker_at: "2026-05-21T10:00:30.000Z",
    finished_at: "2026-05-21T10:08:30.000Z",
    branch: "feature/login",
    commit_hash: "deadbeefcafebabe",
    commit_message: "Fix crash on launch",
    pull_request_id: 17,
    triggered_by: "asaf@acme.example",
  };
  return { ...base, ...overrides };
}

const NOW = 1_700_000_000_000;

describe("mapBitriseAppToItem", () => {
  test("returns null for non-object input", () => {
    expect(mapBitriseAppToItem(null, NOW)).toBeNull();
    expect(mapBitriseAppToItem("nope", NOW)).toBeNull();
    expect(mapBitriseAppToItem(42, NOW)).toBeNull();
  });

  test("returns null when slug is missing or empty", () => {
    const noSlug = makeApp();
    delete (noSlug as Record<string, unknown>)["slug"];
    expect(mapBitriseAppToItem(noSlug, NOW)).toBeNull();
    expect(mapBitriseAppToItem(makeApp({ slug: "" }), NOW)).toBeNull();
  });

  test("uses slug as externalId; service+type are fixed", () => {
    const row = mapBitriseAppToItem(makeApp(), NOW);
    expect(row).not.toBeNull();
    expect(row?.service).toBe("bitrise");
    expect(row?.type).toBe("app");
    expect(row?.externalId).toBe("abc123app");
  });

  test("title falls back to slug when missing", () => {
    const row = mapBitriseAppToItem(makeApp({ title: undefined }), NOW);
    expect(row?.title).toBe("abc123app");
  });

  test("canonicalUrl points to the app dashboard", () => {
    const row = mapBitriseAppToItem(makeApp(), NOW);
    expect(row?.canonicalUrl).toBe("https://app.bitrise.io/app/abc123app");
  });

  test("metadata surfaces project_type, repo_url, default_branch", () => {
    const row = mapBitriseAppToItem(makeApp(), NOW);
    expect(row?.metadata).toMatchObject({
      project_type: "ios",
      repo_url: "https://github.com/acme/ios.git",
      default_branch: "main",
      is_disabled: false,
    });
  });

  test("syncedAt is propagated to modifiedAt and syncedAt fields", () => {
    const row = mapBitriseAppToItem(makeApp(), NOW);
    expect(row?.modifiedAt).toBe(NOW);
    expect(row?.syncedAt).toBe(NOW);
  });
});

describe("mapBitriseBuildToItem", () => {
  const APP_SLUG = "abc123app";

  test("returns null for non-object input", () => {
    expect(mapBitriseBuildToItem(null, { appSlug: APP_SLUG, syncedAt: NOW })).toBeNull();
    expect(mapBitriseBuildToItem(42, { appSlug: APP_SLUG, syncedAt: NOW })).toBeNull();
  });

  test("returns null when slug is missing or empty", () => {
    const noSlug = makeBuild();
    delete (noSlug as Record<string, unknown>)["slug"];
    expect(mapBitriseBuildToItem(noSlug, { appSlug: APP_SLUG, syncedAt: NOW })).toBeNull();
    expect(
      mapBitriseBuildToItem(makeBuild({ slug: "" }), { appSlug: APP_SLUG, syncedAt: NOW }),
    ).toBeNull();
  });

  test("externalId joins app slug and build slug for cross-app uniqueness", () => {
    const row = mapBitriseBuildToItem(makeBuild(), { appSlug: APP_SLUG, syncedAt: NOW });
    expect(row?.externalId).toBe("abc123app/build-aaa");
    expect(row?.service).toBe("bitrise");
    expect(row?.type).toBe("build");
  });

  test("title combines build number + workflow + branch when present", () => {
    const row = mapBitriseBuildToItem(makeBuild(), { appSlug: APP_SLUG, syncedAt: NOW });
    expect(row?.title).toContain("#42");
    expect(row?.title).toContain("primary");
    expect(row?.title).toContain("feature/login");
  });

  test("title falls back to slug-only when no number/workflow/branch", () => {
    const row = mapBitriseBuildToItem(
      makeBuild({
        build_number: undefined,
        triggered_workflow: undefined,
        branch: undefined,
      }),
      { appSlug: APP_SLUG, syncedAt: NOW },
    );
    expect(row?.title).toBe("build-aaa");
  });

  test("canonicalUrl points to the build page on app.bitrise.io", () => {
    const row = mapBitriseBuildToItem(makeBuild(), { appSlug: APP_SLUG, syncedAt: NOW });
    expect(row?.canonicalUrl).toBe("https://app.bitrise.io/build/build-aaa");
  });

  test("modifiedAt prefers finished_at, falls back to started, then triggered, then syncedAt", () => {
    const finished = mapBitriseBuildToItem(makeBuild(), { appSlug: APP_SLUG, syncedAt: NOW });
    expect(finished?.modifiedAt).toBe(Date.parse("2026-05-21T10:08:30.000Z"));

    const startedOnly = mapBitriseBuildToItem(makeBuild({ finished_at: undefined }), {
      appSlug: APP_SLUG,
      syncedAt: NOW,
    });
    expect(startedOnly?.modifiedAt).toBe(Date.parse("2026-05-21T10:00:30.000Z"));

    const triggeredOnly = mapBitriseBuildToItem(
      makeBuild({ finished_at: undefined, started_on_worker_at: undefined }),
      { appSlug: APP_SLUG, syncedAt: NOW },
    );
    expect(triggeredOnly?.modifiedAt).toBe(Date.parse("2026-05-21T10:00:00.000Z"));

    const none = mapBitriseBuildToItem(
      makeBuild({
        finished_at: undefined,
        started_on_worker_at: undefined,
        triggered_at: undefined,
      }),
      { appSlug: APP_SLUG, syncedAt: NOW },
    );
    expect(none?.modifiedAt).toBe(NOW);
  });

  test("metadata surfaces the roadmap-required fields", () => {
    const row = mapBitriseBuildToItem(makeBuild(), { appSlug: APP_SLUG, syncedAt: NOW });
    expect(row?.metadata).toMatchObject({
      status: "success",
      status_code: 1,
      workflow_id: "primary",
      app_slug: APP_SLUG,
      branch: "feature/login",
      commit_hash: "deadbeefcafebabe",
      commit_message: "Fix crash on launch",
      triggered_by: "asaf@acme.example",
      pull_request_id: 17,
    });
  });

  test("metadata includes duration_ms when both started_on_worker_at and finished_at are present", () => {
    const row = mapBitriseBuildToItem(makeBuild(), { appSlug: APP_SLUG, syncedAt: NOW });
    expect(row?.metadata["duration_ms"]).toBe(
      Date.parse("2026-05-21T10:08:30.000Z") - Date.parse("2026-05-21T10:00:30.000Z"),
    );
  });

  test("duration_ms is null when one timestamp is missing", () => {
    const row = mapBitriseBuildToItem(makeBuild({ finished_at: undefined }), {
      appSlug: APP_SLUG,
      syncedAt: NOW,
    });
    expect(row?.metadata["duration_ms"]).toBeNull();
  });

  test("status_text falls back to a generic label when the API omits it", () => {
    const row = mapBitriseBuildToItem(makeBuild({ status_text: undefined }), {
      appSlug: APP_SLUG,
      syncedAt: NOW,
    });
    expect(row?.metadata["status"]).toBe("unknown");
  });
});
