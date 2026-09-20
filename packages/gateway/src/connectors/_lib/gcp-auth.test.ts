import { describe, expect, test } from "bun:test";

import { gcloudKeyFileEnv } from "./gcp-auth.ts";

describe("gcloudKeyFileEnv", () => {
  test("sets the variable the gcloud CLI reads, not only the ADC one it ignores", () => {
    expect(gcloudKeyFileEnv("/keys/sa.json")).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json",
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "/keys/sa.json",
    });
  });

  test("carries nothing else — no credential material beyond the path", () => {
    expect(Object.keys(gcloudKeyFileEnv("/k.json")).sort()).toEqual([
      "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE",
      "GOOGLE_APPLICATION_CREDENTIALS",
    ]);
  });
});
