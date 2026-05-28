export const GOOGLE_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_GOOGLE_CLIENT_ID to your Google OAuth client ID (Desktop app, PKCE).

How to obtain:
1. Google Cloud Console → APIs & Services → Credentials → Create OAuth client ID → Application type: Desktop.
2. Enable the APIs you need (Drive, Gmail, Photos, …) and complete the OAuth consent screen.
3. Copy the Client ID (typically ends with .apps.googleusercontent.com).

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_GOOGLE_CLIENT_ID = "your-id.apps.googleusercontent.com"

The same client ID is used for browser sign-in and for refreshing access tokens.

If you created a Web application OAuth client instead of Desktop, Google requires a client secret at the token endpoint — set:
  $env:NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET = "your-client-secret"
(Prefer a Desktop client so no secret is needed.)`;

export const MICROSOFT_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_MICROSOFT_CLIENT_ID to your Azure AD application (client) ID for a public client with PKCE.

How to obtain:
1. Azure Portal → Microsoft Entra ID → App registrations → New registration (or select an existing app).
2. Authentication → add a platform for mobile/desktop or public client; use a localhost redirect URI as required for your setup.
3. Copy the Application (client) ID.

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_MICROSOFT_CLIENT_ID = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

Used for OneDrive, Outlook, Teams sign-in and token refresh.`;

export const SLACK_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_SLACK_CLIENT_ID to your Slack app's Client ID (OAuth 2.0 with PKCE; no client secret is stored in Nimbus).

How to obtain:
1. api.slack.com → Your Apps → Create or select an app.
2. OAuth & Permissions — configure redirect URLs for local loopback (Nimbus binds a localhost port for the callback).
3. Copy the Client ID from Basic Information.

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_SLACK_CLIENT_ID = "123456789.123456789"`;

export const NOTION_OAUTH_ENV_HELP = `Set both NIMBUS_OAUTH_NOTION_CLIENT_ID and NIMBUS_OAUTH_NOTION_CLIENT_SECRET for Notion public integration OAuth.

How to obtain:
1. notion.so/my-integrations → create or open an integration with OAuth enabled.
2. Copy the OAuth client ID and client secret from the integration settings.

Notion's token endpoint requires the client secret at exchange time (keep it in the environment only; Nimbus does not store it in the vault).

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_NOTION_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_NOTION_CLIENT_SECRET = "secret_..."`;

export function printConnectorAuthHelpPointer(): void {
  console.log(`OAuth PKCE services — detailed setup for each:

  nimbus connector auth google_drive --help   (also gmail, google_photos)
  nimbus connector auth onedrive --help       (also outlook, teams)
  nimbus connector auth slack --help
  nimbus connector auth notion --help

Usage: nimbus connector auth <service> [--port <n>] [--scopes a,b] [--help] …`);
}

export function printConnectorAuthPatOnlyHelp(service: string): void {
  console.log(
    `No OAuth environment-variable help for "${service}". This connector uses a token or API key — see:\n  nimbus connector help`,
  );
}
