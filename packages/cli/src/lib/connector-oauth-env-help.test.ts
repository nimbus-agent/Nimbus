// packages/cli/src/lib/connector-oauth-env-help.test.ts
//
// Covers the four exported help-text constants + two console.log
// printer functions. Captures console output via the shared helper.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import { captureOutput } from "../../test/helpers/cli-output.ts";

import {
  GOOGLE_OAUTH_CLIENT_ID_HELP,
  MICROSOFT_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_ENV_HELP,
  printConnectorAuthHelpPointer,
  printConnectorAuthPatOnlyHelp,
  SLACK_OAUTH_CLIENT_ID_HELP,
} from "./connector-oauth-env-help.ts";

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("OAuth env-help constants", () => {
  it("Google help mentions the env var and Desktop client guidance", () => {
    expect(GOOGLE_OAUTH_CLIENT_ID_HELP).toContain("NIMBUS_OAUTH_GOOGLE_CLIENT_ID");
    expect(GOOGLE_OAUTH_CLIENT_ID_HELP).toContain("Desktop");
    expect(GOOGLE_OAUTH_CLIENT_ID_HELP).toContain("NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET");
  });

  it("Microsoft help mentions Azure / Entra and the env var", () => {
    expect(MICROSOFT_OAUTH_CLIENT_ID_HELP).toContain("NIMBUS_OAUTH_MICROSOFT_CLIENT_ID");
    expect(MICROSOFT_OAUTH_CLIENT_ID_HELP).toContain("Azure");
  });

  it("Slack help mentions PKCE and the env var", () => {
    expect(SLACK_OAUTH_CLIENT_ID_HELP).toContain("NIMBUS_OAUTH_SLACK_CLIENT_ID");
    expect(SLACK_OAUTH_CLIENT_ID_HELP).toContain("PKCE");
  });

  it("Notion help mentions both ID and SECRET env vars", () => {
    expect(NOTION_OAUTH_ENV_HELP).toContain("NIMBUS_OAUTH_NOTION_CLIENT_ID");
    expect(NOTION_OAUTH_ENV_HELP).toContain("NIMBUS_OAUTH_NOTION_CLIENT_SECRET");
  });
});

describe("printConnectorAuthHelpPointer", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    out.reset();
  });

  it("prints the multi-service usage pointer to stdout", () => {
    printConnectorAuthHelpPointer();
    expect(out.stdout).toContain("OAuth PKCE services");
    expect(out.stdout).toContain("nimbus connector auth google_drive --help");
    expect(out.stdout).toContain("nimbus connector auth onedrive --help");
    expect(out.stdout).toContain("nimbus connector auth slack --help");
    expect(out.stdout).toContain("nimbus connector auth notion --help");
    expect(out.stdout).toContain("Usage: nimbus connector auth");
  });
});

describe("printConnectorAuthPatOnlyHelp", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    out.reset();
  });

  it("prints the PAT-only fallback message naming the requested service", () => {
    printConnectorAuthPatOnlyHelp("github");
    expect(out.stdout).toContain('No OAuth environment-variable help for "github"');
    expect(out.stdout).toContain("nimbus connector help");
  });

  it("handles an empty service name gracefully", () => {
    printConnectorAuthPatOnlyHelp("");
    expect(out.stdout).toContain('No OAuth environment-variable help for ""');
  });
});
