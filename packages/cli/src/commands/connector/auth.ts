import {
  GOOGLE_OAUTH_CLIENT_ID_HELP,
  MICROSOFT_OAUTH_CLIENT_ID_HELP,
  NOTION_OAUTH_ENV_HELP,
  printConnectorAuthHelpPointer,
  printConnectorAuthPatOnlyHelp,
  SLACK_OAUTH_CLIENT_ID_HELP,
} from "../../lib/connector-oauth-env-help.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../../lib/rpc-timeouts.ts";
import { applyConnectorAuthParamsForService } from "./auth-appliers.ts";
import type { ConnectorAuthParams } from "./auth-env.ts";
import { parseFlags } from "./flags.ts";
import { withIpc } from "./shared.ts";

function printConnectorAuthServiceHelp(normalized: string): void {
  switch (normalized) {
    case "google_drive":
    case "gmail":
    case "google_photos":
    case "google_meet":
    case "google_calendar":
      console.log(GOOGLE_OAUTH_CLIENT_ID_HELP);
      return;
    case "onedrive":
    case "outlook":
    case "teams":
      console.log(MICROSOFT_OAUTH_CLIENT_ID_HELP);
      return;
    case "slack":
      console.log(SLACK_OAUTH_CLIENT_ID_HELP);
      return;
    case "notion":
      console.log(NOTION_OAUTH_ENV_HELP);
      return;
    default:
      printConnectorAuthPatOnlyHelp(normalized);
  }
}

/**
 * A timed-out `connector.auth` does NOT mean nothing was stored.
 *
 * The gateway owns the PKCE callback server and keeps the flow running after the client gives
 * up, so a sign-in finished past the deadline still writes a credential while the user has been
 * told it failed (F17). The transport's own message says only "IPC request timed out", which
 * reads as "nothing happened" — the one reading that is not safe. Naming the two commands that
 * settle the question costs a sentence and saves a user from re-running a flow that succeeded.
 */
async function authCallWithTimeoutGuidance(
  params: Record<string, unknown>,
  service: string,
): Promise<{
  ok: boolean;
  serviceId: string;
  scopesGranted: string[];
  verified?: "verified" | "unverified" | null;
}> {
  try {
    // The INTERACTIVE budget, not the transport's 30s default. This is the one RPC whose
    // duration is bounded by a person using a web browser — finding the window, signing in, MFA,
    // reading a consent screen — and 30s is routinely too short for that.
    return await withIpc(
      (c) =>
        c.call<{
          ok: boolean;
          serviceId: string;
          scopesGranted: string[];
          verified?: "verified" | "unverified" | null;
        }>("connector.auth", params),
      undefined,
      INTERACTIVE_RPC_TIMEOUT_MS,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("timed out")) throw err;
    throw new Error(
      `${message}
The browser sign-in may still have completed — the gateway finishes the flow ` +
        `on its own. Check with: nimbus vault list ${service}  /  nimbus connector list`,
    );
  }
}

export async function runConnectorAuth(tail: string[]): Promise<void> {
  const f = parseFlags(tail);
  const service = f.rest[0];

  if (f.help === true) {
    if (service === undefined) {
      printConnectorAuthHelpPointer();
      return;
    }
    const normalizedHelp = service.trim().toLowerCase().replaceAll("-", "_");
    printConnectorAuthServiceHelp(normalizedHelp);
    return;
  }

  if (service === undefined) {
    throw new Error(
      "Usage: nimbus connector auth <service> [--port <n>] [--scopes a,b] [--token <pat>] [--username <u>] [--api-base <url>] [--enable] [--help]",
    );
  }
  const params: ConnectorAuthParams = { service };
  if (f.port !== undefined) {
    params.port = f.port;
  }
  if (f.scopes !== undefined) {
    params.scopes = f.scopes;
  }
  const normalized = service.trim().toLowerCase().replaceAll("-", "_");
  applyConnectorAuthParamsForService(normalized, params, f);
  // The INTERACTIVE budget, not the transport's 30s default (F17). This is the one RPC whose
  // duration is bounded by a person using a web browser — finding the window, signing in, MFA,
  // reading a consent screen — and 30s is routinely too short for that.
  //
  // Getting it wrong is worse than a slow command: the gateway owns the PKCE callback server and
  // finishes the flow after the client gives up, so a sign-in completed past the deadline still
  // stores a credential while the user has been told it timed out. The CLI's report and the
  // vault's state then disagree with no way to tell which happened.
  const res = await authCallWithTimeoutGuidance(params, service);
  // Report only what was actually checked. "Signed in" claimed more than the
  // command ever verified — for the connectors with no probe it would keep
  // claiming it.
  if (res.verified === "verified") {
    console.log(`Verified: ${res.serviceId}`);
  } else if (res.verified === "unverified") {
    console.log(`Stored: ${res.serviceId} (NOT verified — the provider did not confirm it)`);
    console.log(`Run \`nimbus connector auth ${res.serviceId}\` again to retry verification.`);
  } else {
    console.log(`Stored: ${res.serviceId} (not verified)`);
  }
  const vaultPatServices = new Set([
    "github",
    "gitlab",
    "bitbucket",
    "linear",
    "jira",
    "confluence",
    "discord",
    "jenkins",
    "circleci",
    "pagerduty",
    "kubernetes",
    "aws",
    "azure",
    "gcp",
    "iac",
    "grafana",
    "sentry",
    "newrelic",
    "datadog",
  ]);
  if (vaultPatServices.has(res.serviceId)) {
    console.log("Credential: stored in the OS vault (no OAuth scopes).");
  } else {
    console.log(`Scopes: ${res.scopesGranted.join(", ")}`);
  }
}
