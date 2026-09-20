import { describe, expect, test } from "bun:test";

import { cliEnvFor } from "./local-auth-env.ts";

const FULL = {
  GH_CONFIG_DIR: "/cfg/gh",
  XDG_CONFIG_HOME: "/cfg",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  XDG_RUNTIME_DIR: "/run/user/1000",
  AWS_CONFIG_FILE: "/cfg/aws/config",
  AWS_SHARED_CREDENTIALS_FILE: "/cfg/aws/credentials",
  // Credentials that must NEVER be forwarded:
  GH_TOKEN: "ghp_SENTINEL",
  GITHUB_TOKEN: "ghp_SENTINEL",
  AWS_SECRET_ACCESS_KEY: "SECRET_SENTINEL",
  AWS_ACCESS_KEY_ID: "AKIA_SENTINEL",
};

describe("cliEnvFor", () => {
  test("gh forwards config-location variables only", () => {
    expect(cliEnvFor("gh", FULL)).toEqual({ GH_CONFIG_DIR: "/cfg/gh", XDG_CONFIG_HOME: "/cfg" });
  });

  test("gh with keyring adds the session-bus variables gh auth token needs on Linux", () => {
    expect(cliEnvFor("gh", FULL, { keyring: true })).toEqual({
      GH_CONFIG_DIR: "/cfg/gh",
      XDG_CONFIG_HOME: "/cfg",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
  });

  test("aws forwards the two config-file paths and nothing else", () => {
    expect(cliEnvFor("aws", FULL)).toEqual({
      AWS_CONFIG_FILE: "/cfg/aws/config",
      AWS_SHARED_CREDENTIALS_FILE: "/cfg/aws/credentials",
    });
  });

  test("no credential variable is ever forwarded, for any source or option", () => {
    const all = JSON.stringify([
      cliEnvFor("gh", FULL),
      cliEnvFor("gh", FULL, { keyring: true }),
      cliEnvFor("aws", FULL),
    ]);
    expect(all).not.toContain("SENTINEL");
  });

  test("unset and blank variables are omitted, not forwarded empty", () => {
    expect(cliEnvFor("aws", { AWS_CONFIG_FILE: "  " })).toEqual({});
    expect(cliEnvFor("gh", {})).toEqual({});
  });

  test("gcloud forwards CLOUDSDK_CONFIG only", () => {
    expect(
      cliEnvFor("gcloud", { CLOUDSDK_CONFIG: "/cfg/gcloud", GOOGLE_APPLICATION_CREDENTIALS: "/x" }),
    ).toEqual({
      CLOUDSDK_CONFIG: "/cfg/gcloud",
    });
  });
});
