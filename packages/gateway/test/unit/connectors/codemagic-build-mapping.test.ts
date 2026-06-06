import { describe, expect, test } from "bun:test";

import {
  mapCodemagicAppToItem,
  mapCodemagicBuildToItem,
} from "../../../src/connectors/codemagic-build-mapping.ts";

function makeApp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    _id: "abc123app",
    appName: "Acme iOS",
    repository: { url: "https://github.com/acme/ios.git" },
    workflowIds: ["primary", "release"],
    branches: ["main", "develop"],
  };
  return { ...base, ...overrides };
}

function makeBuild(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    _id: "build-aaa",
    appId: "abc123app",
    workflowId: "primary",
    branch: "feature/login",
    tag: null,
    version: "1.2.0",
    status: "finished",
    startedAt: "2026-05-21T10:00:30.000Z",
    finishedAt: "2026-05-21T10:08:30.000Z",
    message: "Fix crash on launch",
    commit: { hash: "deadbeefcafebabe" },
  };
  return { ...base, ...overrides };
}

const NOW = 1_700_000_000_000;

describe("mapCodemagicAppToItem", () => {
  test("returns null for non-object input", () => {
    expect(mapCodemagicAppToItem(null, NOW)).toBeNull();
    expect(mapCodemagicAppToItem("nope", NOW)).toBeNull();
    expect(mapCodemagicAppToItem(42, NOW)).toBeNull();
  });

  test("returns null when _id is missing or empty", () => {
    const noId = makeApp();
    delete noId["_id"];
    expect(mapCodemagicAppToItem(noId, NOW)).toBeNull();
    expect(mapCodemagicAppToItem(makeApp({ _id: "" }), NOW)).toBeNull();
  });

  test("uses _id as externalId; service+type are fixed", () => {
    const row = mapCodemagicAppToItem(makeApp(), NOW);
    expect(row).not.toBeNull();
    expect(row?.service).toBe("codemagic");
    expect(row?.type).toBe("app");
    expect(row?.externalId).toBe("abc123app");
  });

  test("title falls back to _id when appName missing", () => {
    const row = mapCodemagicAppToItem(makeApp({ appName: undefined }), NOW);
    expect(row?.title).toBe("abc123app");
  });

  test("canonicalUrl points to the app dashboard", () => {
    const row = mapCodemagicAppToItem(makeApp(), NOW);
    expect(row?.canonicalUrl).toBe("https://codemagic.io/app/abc123app");
  });

  test("metadata surfaces repository, workflow ids, branches", () => {
    const row = mapCodemagicAppToItem(makeApp(), NOW);
    expect(row?.metadata).toMatchObject({
      repository: { url: "https://github.com/acme/ios.git" },
      workflow_ids: ["primary", "release"],
      branches: ["main", "develop"],
    });
  });

  test("syncedAt is propagated to modifiedAt and syncedAt fields", () => {
    const row = mapCodemagicAppToItem(makeApp(), NOW);
    expect(row?.modifiedAt).toBe(NOW);
    expect(row?.syncedAt).toBe(NOW);
  });
});

describe("mapCodemagicBuildToItem", () => {
  const APP_ID = "abc123app";

  test("returns null for non-object input", () => {
    expect(mapCodemagicBuildToItem(null, { appId: APP_ID, syncedAt: NOW })).toBeNull();
    expect(mapCodemagicBuildToItem(42, { appId: APP_ID, syncedAt: NOW })).toBeNull();
  });

  test("returns null when _id is missing or empty", () => {
    const noId = makeBuild();
    delete noId["_id"];
    expect(mapCodemagicBuildToItem(noId, { appId: APP_ID, syncedAt: NOW })).toBeNull();
    expect(
      mapCodemagicBuildToItem(makeBuild({ _id: "" }), { appId: APP_ID, syncedAt: NOW }),
    ).toBeNull();
  });

  test("externalId joins app id and build id for cross-app uniqueness", () => {
    const row = mapCodemagicBuildToItem(makeBuild(), { appId: APP_ID, syncedAt: NOW });
    expect(row?.externalId).toBe("abc123app/build-aaa");
    expect(row?.service).toBe("codemagic");
    expect(row?.type).toBe("build");
  });

  test("title combines version + workflow + branch when present", () => {
    const row = mapCodemagicBuildToItem(makeBuild(), { appId: APP_ID, syncedAt: NOW });
    expect(row?.title).toContain("#1.2.0");
    expect(row?.title).toContain("primary");
    expect(row?.title).toContain("feature/login");
  });

  test("title falls back to short id when version missing", () => {
    const row = mapCodemagicBuildToItem(
      makeBuild({ version: undefined, workflowId: undefined, branch: undefined }),
      { appId: APP_ID, syncedAt: NOW },
    );
    expect(row?.title).toBe("#build-a");
  });

  test("canonicalUrl points to the build page on codemagic.io", () => {
    const row = mapCodemagicBuildToItem(makeBuild(), { appId: APP_ID, syncedAt: NOW });
    expect(row?.canonicalUrl).toBe("https://codemagic.io/app/abc123app/build/build-aaa");
  });

  test("modifiedAt prefers finishedAt, falls back to startedAt, then syncedAt", () => {
    const finished = mapCodemagicBuildToItem(makeBuild(), { appId: APP_ID, syncedAt: NOW });
    expect(finished?.modifiedAt).toBe(Date.parse("2026-05-21T10:08:30.000Z"));

    const startedOnly = mapCodemagicBuildToItem(makeBuild({ finishedAt: undefined }), {
      appId: APP_ID,
      syncedAt: NOW,
    });
    expect(startedOnly?.modifiedAt).toBe(Date.parse("2026-05-21T10:00:30.000Z"));

    const none = mapCodemagicBuildToItem(
      makeBuild({ finishedAt: undefined, startedAt: undefined }),
      { appId: APP_ID, syncedAt: NOW },
    );
    expect(none?.modifiedAt).toBe(NOW);
  });

  test("metadata surfaces the roadmap-required fields", () => {
    const row = mapCodemagicBuildToItem(makeBuild(), { appId: APP_ID, syncedAt: NOW });
    expect(row?.metadata).toMatchObject({
      app_id: APP_ID,
      status: "finished",
      workflow_id: "primary",
      branch: "feature/login",
      version: "1.2.0",
      commit: { hash: "deadbeefcafebabe" },
    });
  });

  test("metadata includes duration_ms when both startedAt and finishedAt are present", () => {
    const row = mapCodemagicBuildToItem(makeBuild(), { appId: APP_ID, syncedAt: NOW });
    expect(row?.metadata["duration_ms"]).toBe(
      Date.parse("2026-05-21T10:08:30.000Z") - Date.parse("2026-05-21T10:00:30.000Z"),
    );
  });

  test("duration_ms is null when one timestamp is missing", () => {
    const row = mapCodemagicBuildToItem(makeBuild({ finishedAt: undefined }), {
      appId: APP_ID,
      syncedAt: NOW,
    });
    expect(row?.metadata["duration_ms"]).toBeNull();
  });

  test("status falls back to a generic label when the API omits it", () => {
    const row = mapCodemagicBuildToItem(makeBuild({ status: undefined }), {
      appId: APP_ID,
      syncedAt: NOW,
    });
    expect(row?.metadata["status"]).toBe("unknown");
  });

  test("bodyPreview falls back to title when message missing", () => {
    const row = mapCodemagicBuildToItem(makeBuild({ message: undefined }), {
      appId: APP_ID,
      syncedAt: NOW,
    });
    expect(row?.bodyPreview).toBe(row?.title);
  });
});
