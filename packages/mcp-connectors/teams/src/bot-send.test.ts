import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { teamsBotSendActivity } from "./bot-send.ts";

const realFetch = globalThis.fetch;

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function installFetch(handler: (captured: Captured) => Response): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const c = { url, init };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return calls;
}

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "app-token-xyz" }), { status: 200 });
}

beforeEach(() => {
  process.env["TEAMS_BOT_APP_ID"] = "app-id";
  process.env["TEAMS_BOT_APP_PASSWORD"] = "app-secret";
  delete process.env["TEAMS_BOT_SERVICE_URL"];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env["TEAMS_BOT_APP_ID"];
  delete process.env["TEAMS_BOT_APP_PASSWORD"];
  delete process.env["TEAMS_BOT_SERVICE_URL"];
});

describe("teamsBotSendActivity", () => {
  test("acquires an app token then POSTs the activity to the default service URL", async () => {
    const calls = installFetch((c) =>
      c.url.includes("/oauth2/") ? tokenResponse() : new Response("{}", { status: 200 }),
    );
    const r = await teamsBotSendActivity("19:conv", "hello");
    expect(r.ok).toBe(true);
    // 1st call = token endpoint, 2nd = send-activity to the default global Teams endpoint.
    expect(calls[0]?.url).toContain("login.microsoftonline.com/botframework.com/oauth2");
    expect(calls[1]?.url).toBe(
      "https://smba.trafficmanager.net/teams/v3/conversations/19%3Aconv/activities",
    );
    const sent = calls[1]?.init;
    expect(sent?.method).toBe("POST");
    expect(String(sent?.body)).toContain('"type":"message"');
  });

  test("respects TEAMS_BOT_SERVICE_URL and normalizes a missing trailing slash", async () => {
    process.env["TEAMS_BOT_SERVICE_URL"] = "https://smba.trafficmanager.net/amer";
    const calls = installFetch((c) =>
      c.url.includes("/oauth2/") ? tokenResponse() : new Response("{}", { status: 200 }),
    );
    await teamsBotSendActivity("19:c", "hi");
    expect(calls[1]?.url).toBe(
      "https://smba.trafficmanager.net/amer/v3/conversations/19%3Ac/activities",
    );
  });

  test("throws when the token endpoint returns non-ok", async () => {
    installFetch(() => new Response("nope", { status: 401 }));
    await expect(teamsBotSendActivity("19:c", "hi")).rejects.toThrow(/Bot Framework token/);
  });

  test("throws when the token response lacks access_token", async () => {
    installFetch((c) =>
      c.url.includes("/oauth2/")
        ? new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 })
        : new Response("{}", { status: 200 }),
    );
    await expect(teamsBotSendActivity("19:c", "hi")).rejects.toThrow(/missing access_token/);
  });

  test("throws when the token response is non-JSON", async () => {
    installFetch(() => new Response("<html>oops</html>", { status: 200 }));
    await expect(teamsBotSendActivity("19:c", "hi")).rejects.toThrow(/non-JSON/);
  });

  test("throws when bot app credentials are absent", async () => {
    delete process.env["TEAMS_BOT_APP_ID"];
    await expect(teamsBotSendActivity("19:c", "hi")).rejects.toThrow();
  });
});
