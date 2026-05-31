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

export const NOTION_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_NOTION_CLIENT_ID to your Notion public integration OAuth client ID.

How to obtain:
1. notion.so/my-integrations → create or open an integration with OAuth enabled.
2. Copy the OAuth client ID from the integration settings.

You must also set NIMBUS_OAUTH_NOTION_CLIENT_SECRET (Notion's token endpoint requires HTTP Basic auth with the secret).

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_NOTION_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_NOTION_CLIENT_SECRET = "secret_..."`;

export const NOTION_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_NOTION_CLIENT_SECRET to your Notion integration's OAuth client secret.

Notion's token exchange requires the client secret in the environment (it is not stored in the Nimbus vault).

notion.so/my-integrations → your integration → OAuth → copy the client secret.

PowerShell example:
  $env:NIMBUS_OAUTH_NOTION_CLIENT_SECRET = "secret_..."`;

export const ZOOM_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_ZOOM_CLIENT_ID to your Zoom app's Client ID (OAuth 2.0 with PKCE).

How to obtain:
1. marketplace.zoom.us → Develop → Build App → create a General App with OAuth enabled.
2. Add scopes for the APIs you need (e.g. meeting:read:list_meetings, user:read:user).
3. Configure a redirect URL for the local loopback callback (Nimbus binds a localhost port).
4. Copy the Client ID from the App Credentials page.

You must also set NIMBUS_OAUTH_ZOOM_CLIENT_SECRET (Zoom's token endpoint requires HTTP Basic auth with the secret).

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_ZOOM_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_ZOOM_CLIENT_SECRET = "..."`;

export const ZOOM_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_ZOOM_CLIENT_SECRET to your Zoom app's Client Secret.

Zoom's token exchange requires the client secret in HTTP Basic auth (it is not stored in the Nimbus vault).

marketplace.zoom.us → your app → App Credentials → copy the Client Secret.

PowerShell example:
  $env:NIMBUS_OAUTH_ZOOM_CLIENT_SECRET = "..."`;
