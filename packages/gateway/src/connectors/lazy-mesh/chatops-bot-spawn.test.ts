import { describe, expect, test } from "bun:test";
import { parseSandboxPolicy, SANDBOX_POLICY_ENV } from "../../platform/sandbox/sandbox-policy.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  chatopsSlackBotServers,
  chatopsTeamsBotServers,
  TEAMS_BOT_SERVICE_HOSTS,
} from "./chatops-bot-spawn.ts";

async function teamsBotNetwork(serviceUrl?: string): Promise<readonly string[]> {
  const servers = await chatopsTeamsBotServers(
    fakeVault({ "teams.bot_app_id": "app-1", "teams.bot_app_password": "pw-1" }),
    "/cwd",
    serviceUrl === undefined ? undefined : { serviceUrl },
  );
  const raw = servers?.["teams"]?.env[SANDBOX_POLICY_ENV];
  if (raw === undefined) throw new Error("no sandbox policy on the teams bot spawn");
  return parseSandboxPolicy(raw).permissions.network;
}

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
    expect(spec?.env["NIMBUS_SANDBOX_POLICY_JSON"]).toBeDefined();
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
    expect(spec?.env["NIMBUS_SANDBOX_POLICY_JSON"]).toBeDefined();
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

  describe("sandbox allowlist for the Bot Framework reply host (#1533)", () => {
    test("the connector's default reply host is reachable even with no serviceUrl", async () => {
      expect(await teamsBotNetwork()).toContain("smba.trafficmanager.net");
    });

    test("a sovereign-cloud serviceUrl from the fixed set is added", async () => {
      for (const host of TEAMS_BOT_SERVICE_HOSTS) {
        expect(await teamsBotNetwork(`https://${host}/teams/`)).toContain(host);
      }
    });

    test("a serviceUrl outside the fixed set never widens the policy", async () => {
      // The bot sends its credential to serviceUrl; an activity must not be able to add a host.
      for (const url of [
        "https://attacker.example/teams/",
        "https://evil.trafficmanager.net/teams/",
        "https://smba.trafficmanager.net.attacker.example/",
      ]) {
        const network = await teamsBotNetwork(url);
        expect(network).not.toContain(new URL(url).hostname);
        expect(network).toContain("smba.trafficmanager.net");
      }
    });
  });

  test("no microsoft.oauth in the bot entry → Graph lookup degrades (no MICROSOFT_OAUTH_ACCESS_TOKEN)", async () => {
    // Graph-token enrichment is best-effort: with no microsoft.oauth credential the token resolve
    // fails closed (caught) and the spawn env omits MICROSOFT_OAUTH_ACCESS_TOKEN — teams_user_info
    // then fails closed in the connector and identity mapping reports the user unmapped.
    const servers = await chatopsTeamsBotServers(
      fakeVault({ "teams.bot_app_id": "app-1", "teams.bot_app_password": "pw-1" }),
      "/cwd",
    );
    expect(servers?.["teams"]?.env["MICROSOFT_OAUTH_ACCESS_TOKEN"]).toBeUndefined();
  });

  test("a non-empty Graph token resolve injects MICROSOFT_OAUTH_ACCESS_TOKEN into the spawn env", async () => {
    // When the bot entry carries a usable microsoft.oauth credential the best-effort resolve yields
    // a non-empty token and it is threaded into the env for teams_user_info Graph lookups.
    const servers = await chatopsTeamsBotServers(
      fakeVault({ "teams.bot_app_id": "app-1", "teams.bot_app_password": "pw-1" }),
      "/cwd",
      { graphTokenResolver: () => Promise.resolve("graph-access-token") },
    );
    expect(servers?.["teams"]?.env["MICROSOFT_OAUTH_ACCESS_TOKEN"]).toBe("graph-access-token");
  });

  test("an empty-string Graph token is treated as absent (no MICROSOFT_OAUTH_ACCESS_TOKEN key)", async () => {
    // The resolver may return "" (configured but no current token); the `t !== ""` guard then
    // leaves graphToken undefined and the env omits the key.
    const servers = await chatopsTeamsBotServers(
      fakeVault({ "teams.bot_app_id": "app-1", "teams.bot_app_password": "pw-1" }),
      "/cwd",
      { graphTokenResolver: () => Promise.resolve("") },
    );
    expect(servers?.["teams"]?.env["MICROSOFT_OAUTH_ACCESS_TOKEN"]).toBeUndefined();
  });

  test("a throwing Graph token resolve degrades fail-closed (caught; key omitted)", async () => {
    const servers = await chatopsTeamsBotServers(
      fakeVault({ "teams.bot_app_id": "app-1", "teams.bot_app_password": "pw-1" }),
      "/cwd",
      {
        graphTokenResolver: () => Promise.reject(new Error("no microsoft.oauth")),
      },
    );
    expect(servers?.["teams"]?.env["MICROSOFT_OAUTH_ACCESS_TOKEN"]).toBeUndefined();
  });
});
