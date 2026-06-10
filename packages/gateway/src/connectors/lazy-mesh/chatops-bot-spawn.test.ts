import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { chatopsSlackBotServers, chatopsTeamsBotServers } from "./chatops-bot-spawn.ts";

function fakeVault(entries: Record<string, string>): NimbusVault {
  return {
    get: (key: string) => Promise.resolve(entries[key] ?? null),
    set: () => Promise.reject(new Error("read-only")),
    delete: () => Promise.reject(new Error("read-only")),
    listKeys: (prefix?: string) =>
      Promise.resolve(Object.keys(entries).filter((k) => k.startsWith(prefix ?? ""))),
  };
}

describe("chatopsSlackBotServers (I1/I15 bot-token spawn spec)", () => {
  test("returns undefined when slack.bot_token is missing (fail-closed: no spawn)", async () => {
    const servers = await chatopsSlackBotServers(
      fakeVault({ "slack.app_token": "xapp-1" }),
      "/cwd",
    );
    expect(servers).toBeUndefined();
  });

  test("returns undefined when slack.app_token is missing", async () => {
    const servers = await chatopsSlackBotServers(
      fakeVault({ "slack.bot_token": "xoxb-1" }),
      "/cwd",
    );
    expect(servers).toBeUndefined();
  });

  test("injects SLACK_BOT_TOKEN + SLACK_APP_TOKEN into a sandbox-wrapped slack spec", async () => {
    const servers = await chatopsSlackBotServers(
      fakeVault({ "slack.bot_token": "xoxb-1", "slack.app_token": "xapp-1" }),
      "/cwd",
    );
    expect(servers).toBeDefined();
    const spec = servers?.["slack"];
    expect(spec).toBeDefined();
    expect(spec?.env["SLACK_BOT_TOKEN"]).toBe("xoxb-1");
    expect(spec?.env["SLACK_APP_TOKEN"]).toBe("xapp-1");
    // I15: the spec must be sandbox-wrapped (wrapServerSpec adds the manifest + cwd env).
    expect(spec?.env["NIMBUS_SANDBOX_MANIFEST_JSON"]).toBeDefined();
    expect(spec?.env["NIMBUS_SANDBOX_CWD"]).toBe("/cwd");
    expect(spec?.args.join(" ")).toContain("slack");
  });
});

describe("chatopsTeamsBotServers (I1/I15 bot-credential spawn spec)", () => {
  test("returns undefined when teams.bot_app_id / teams.bot_app_password are missing", async () => {
    expect(await chatopsTeamsBotServers(fakeVault({}), "/cwd")).toBeUndefined();
    expect(
      await chatopsTeamsBotServers(fakeVault({ "teams.bot_app_id": "app-1" }), "/cwd"),
    ).toBeUndefined();
  });

  test("injects TEAMS_BOT_APP_ID + TEAMS_BOT_APP_PASSWORD into a sandbox-wrapped teams spec", async () => {
    const servers = await chatopsTeamsBotServers(
      fakeVault({ "teams.bot_app_id": "app-1", "teams.bot_app_password": "pw-1" }),
      "/cwd",
    );
    const spec = servers?.["teams"];
    expect(spec).toBeDefined();
    expect(spec?.env["TEAMS_BOT_APP_ID"]).toBe("app-1");
    expect(spec?.env["TEAMS_BOT_APP_PASSWORD"]).toBe("pw-1");
    expect(spec?.env["NIMBUS_SANDBOX_MANIFEST_JSON"]).toBeDefined();
    // No serviceUrl given → no TEAMS_BOT_SERVICE_URL key.
    expect(spec?.env["TEAMS_BOT_SERVICE_URL"]).toBeUndefined();
    // No microsoft.oauth in the bot vault entry → no Graph token injected (teams_user_info will
    // fail closed in the connector; identity mapping then reports unmapped).
    expect(spec?.env["MICROSOFT_OAUTH_ACCESS_TOKEN"]).toBeUndefined();
  });

  test("threads the per-activity TEAMS_BOT_SERVICE_URL into the spawn env", async () => {
    const servers = await chatopsTeamsBotServers(
      fakeVault({ "teams.bot_app_id": "app-1", "teams.bot_app_password": "pw-1" }),
      "/cwd",
      { serviceUrl: "https://smba.example/emea/" },
    );
    expect(servers?.["teams"]?.env["TEAMS_BOT_SERVICE_URL"]).toBe("https://smba.example/emea/");
  });
});
