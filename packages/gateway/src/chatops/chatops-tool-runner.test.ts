import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { buildChatopsToolRunner } from "./chatops-tool-runner.ts";

function vaultWith(entries: Record<string, string>): NimbusVault {
  return {
    get: (key: string) => Promise.resolve(entries[key] ?? null),
    set: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    listKeys: () => Promise.resolve(Object.keys(entries)),
  };
}

const SLACK_KEYS = {
  "teamvault.chatops-bot.slack.bot_token": "xoxb-secret",
  "teamvault.chatops-bot.slack.app_token": "xapp-secret",
};
const TEAMS_KEYS = {
  "teamvault.chatops-bot.teams.bot_app_id": "app-1",
  "teamvault.chatops-bot.teams.bot_app_password": "pw-secret",
};

describe("buildChatopsToolRunner (I19-pattern fail-closed bot-tool invocation)", () => {
  test("fail-closed: missing slack bot keys → throws and never spawns", async () => {
    const calls: unknown[] = [];
    const run = buildChatopsToolRunner({
      vault: vaultWith({}),
      botVaultEntry: "chatops-bot",
      sandboxCwd: "/cwd",
      spawnAndCall: (req) => {
        calls.push(req);
        return Promise.resolve({});
      },
    });
    await expect(run("slack", "slack_user_info", { user: "U1" })).rejects.toThrow(
      /missing required bot secret/,
    );
    expect(calls.length).toBe(0);
  });

  test("the missing-key error never contains a secret value", async () => {
    const run = buildChatopsToolRunner({
      vault: vaultWith({ "teamvault.chatops-bot.slack.bot_token": "xoxb-secret" }),
      botVaultEntry: "chatops-bot",
      sandboxCwd: "/cwd",
      spawnAndCall: () => Promise.resolve({}),
    });
    const err = await run("slack", "slack_chat_post", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain("xoxb-secret");
  });

  test("spawns with the team-vault view: bare connector keys resolve to teamvault.<entry>.*", async () => {
    const reqs: { platform: string; toolId: string; args: unknown; viewToken: string | null }[] =
      [];
    const run = buildChatopsToolRunner({
      vault: vaultWith(SLACK_KEYS),
      botVaultEntry: "chatops-bot",
      sandboxCwd: "/cwd",
      spawnAndCall: async (req) => {
        reqs.push({
          platform: req.platform,
          toolId: req.toolId,
          args: req.args,
          viewToken: await req.vaultView.get("slack.bot_token"),
        });
        return { ok: true };
      },
    });
    const out = await run("slack", "slack_user_info", { user: "U1" });
    expect(out).toEqual({ ok: true });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.platform).toBe("slack");
    expect(reqs[0]?.toolId).toBe("slack_user_info");
    expect(reqs[0]?.args).toEqual({ user: "U1" });
    // The view remaps the bare key to the team keyspace — the spawner reads the real secret.
    expect(reqs[0]?.viewToken).toBe("xoxb-secret");
  });

  test("teams: requires bot_app_id + bot_app_password and threads serviceUrl through", async () => {
    const seen: { serviceUrl?: string }[] = [];
    const run = buildChatopsToolRunner({
      vault: vaultWith(TEAMS_KEYS),
      botVaultEntry: "chatops-bot",
      sandboxCwd: "/cwd",
      spawnAndCall: (req) => {
        seen.push({ ...(req.teams?.serviceUrl === undefined ? {} : req.teams) });
        return Promise.resolve(null);
      },
    });
    await run(
      "teams",
      "teams_chat_post",
      { conversationId: "19:x", text: "hi" },
      {
        serviceUrl: "https://smba.example/emea/",
      },
    );
    expect(seen[0]?.serviceUrl).toBe("https://smba.example/emea/");
  });
});
