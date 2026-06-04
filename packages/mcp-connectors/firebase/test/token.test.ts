import { afterEach, describe, expect, test } from "bun:test";

import { configuredAppIds, projectNumberFromAppId, serviceAccountFromEnv } from "../src/token.ts";

function serviceAccountJson(): string {
  return JSON.stringify({
    type: "service_account",
    client_email: "sa@example.iam.gserviceaccount.com",
    private_key: "test-private-key-placeholder",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

describe("projectNumberFromAppId", () => {
  test("extracts the 2nd colon-segment", () => {
    expect(projectNumberFromAppId("1:1234567890:android:abcdef")).toBe("1234567890");
  });

  test("returns null when there is no 2nd segment", () => {
    expect(projectNumberFromAppId("nocolons")).toBeNull();
    expect(projectNumberFromAppId("1::android")).toBeNull();
  });
});

describe("env helpers", () => {
  const savedSa = process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  const savedAppIds = process.env["FIREBASE_APP_IDS"];

  afterEach(() => {
    if (savedSa === undefined) {
      delete process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
    } else {
      process.env["FIREBASE_SERVICE_ACCOUNT_JSON"] = savedSa;
    }
    if (savedAppIds === undefined) {
      delete process.env["FIREBASE_APP_IDS"];
    } else {
      process.env["FIREBASE_APP_IDS"] = savedAppIds;
    }
  });

  test("serviceAccountFromEnv throws when unset", () => {
    delete process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];
    expect(() => serviceAccountFromEnv()).toThrow("FIREBASE_SERVICE_ACCOUNT_JSON is not set");
  });

  test("serviceAccountFromEnv throws on an invalid key", () => {
    process.env["FIREBASE_SERVICE_ACCOUNT_JSON"] = "{not json";
    expect(() => serviceAccountFromEnv()).toThrow("not a valid service-account key");
  });

  test("serviceAccountFromEnv parses a valid key", () => {
    process.env["FIREBASE_SERVICE_ACCOUNT_JSON"] = serviceAccountJson();
    expect(serviceAccountFromEnv().clientEmail).toBe("sa@example.iam.gserviceaccount.com");
  });

  test("configuredAppIds splits, trims, and drops blanks", () => {
    process.env["FIREBASE_APP_IDS"] = " 1:1:android:a , 1:2:ios:b ,, ";
    expect(configuredAppIds()).toEqual(["1:1:android:a", "1:2:ios:b"]);
  });

  test("configuredAppIds is empty when unset", () => {
    delete process.env["FIREBASE_APP_IDS"];
    expect(configuredAppIds()).toEqual([]);
  });
});
