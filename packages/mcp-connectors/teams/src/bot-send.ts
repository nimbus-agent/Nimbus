import { fetchBearerAuthorizedJson } from "../../shared/fetch-bearer-json.ts";
import { requireProcessEnv } from "../../shared/mcp-tool-kit.ts";

/**
 * Bot Framework outbound send-activity for the ChatOps operational reply surface (Slice 5).
 *
 * A Teams bot does not use the signed-in user's Graph token to reply; it authenticates with its own
 * app credentials (`TEAMS_BOT_APP_ID` / `TEAMS_BOT_APP_PASSWORD`) to obtain an app-only token from the
 * Bot Framework token endpoint, then POSTs an activity to the conversation's service URL. The service
 * URL is region-specific and is provided by the inbound activity; we read it from
 * `TEAMS_BOT_SERVICE_URL` (the adapter captures it from the activity and injects it), defaulting to
 * the global Teams endpoint.
 */

const BOT_TOKEN_ENDPOINT = "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token";
const BOT_TOKEN_SCOPE = "https://api.botframework.com/.default";
const DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/teams/";

type GraphLikeResult = { ok: boolean; status: number; json: unknown; text: string };

async function acquireBotToken(appId: string, appPassword: string): Promise<string> {
  const res = await fetch(BOT_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: appId,
      client_secret: appPassword,
      scope: BOT_TOKEN_SCOPE,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Bot Framework token: ${text.slice(0, 400)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Bot Framework token: non-JSON response");
  }
  const access =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)["access_token"]
      : undefined;
  if (typeof access !== "string" || access === "") {
    throw new Error("Bot Framework token: missing access_token");
  }
  return access;
}

function serviceUrlBase(): string {
  const raw = process.env["TEAMS_BOT_SERVICE_URL"];
  const base = raw !== undefined && raw !== "" ? raw : DEFAULT_SERVICE_URL;
  return base.endsWith("/") ? base : `${base}/`;
}

/** Send a plain-text message activity to a Teams conversation via the Bot Framework. */
export async function teamsBotSendActivity(
  conversationId: string,
  text: string,
): Promise<GraphLikeResult> {
  const appId = requireProcessEnv("TEAMS_BOT_APP_ID");
  const appPassword = requireProcessEnv("TEAMS_BOT_APP_PASSWORD");
  const token = await acquireBotToken(appId, appPassword);
  const url = `${serviceUrlBase()}v3/conversations/${encodeURIComponent(conversationId)}/activities`;
  return fetchBearerAuthorizedJson(url, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "message", text }),
  });
}
