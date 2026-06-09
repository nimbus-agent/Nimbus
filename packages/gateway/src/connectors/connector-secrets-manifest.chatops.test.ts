import { describe, expect, test } from "bun:test";
import { CONNECTOR_VAULT_SECRET_KEYS } from "./connector-secrets-manifest.ts";

describe("chatops bot token keys", () => {
  test("slack carries a bot token key", () => {
    expect(CONNECTOR_VAULT_SECRET_KEYS.slack).toContain("slack.bot_token");
  });
  test("teams carries bot app credentials", () => {
    expect(CONNECTOR_VAULT_SECRET_KEYS.teams).toContain("teams.bot_app_id");
    expect(CONNECTOR_VAULT_SECRET_KEYS.teams).toContain("teams.bot_app_password");
  });
});
