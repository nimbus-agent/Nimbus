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

export const HUBSPOT_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_HUBSPOT_CLIENT_ID to your HubSpot app's Client ID (OAuth 2.0 authorization-code flow).

How to obtain:
1. developers.hubspot.com → create or open an app under your developer account.
2. Auth tab → add the scopes you need (e.g. crm.objects.deals.read, oauth).
3. Configure a redirect URL for the local loopback callback (Nimbus binds a localhost port).
4. Copy the Client ID from the Auth page.

You must also set NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET (HubSpot's token endpoint requires the client secret in the request body).

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_HUBSPOT_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET = "..."`;

export const HUBSPOT_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET to your HubSpot app's Client Secret.

HubSpot's token exchange requires the client secret form-encoded in the request body (it is not stored in the Nimbus vault).

developers.hubspot.com → your app → Auth → copy the Client Secret.

PowerShell example:
  $env:NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET = "..."`;

export const MIRO_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_MIRO_CLIENT_ID to your Miro app's Client ID (OAuth 2.0 authorization-code flow).

How to obtain:
1. miro.com/app/settings/user-profile/apps → create or open an app.
2. Add the read scopes you need (e.g. boards:read).
3. Configure a redirect URL for the local loopback callback (Nimbus binds a localhost port).
4. Copy the Client ID from the app's settings page.

You must also set NIMBUS_OAUTH_MIRO_CLIENT_SECRET (Miro's token endpoint requires the client secret in the request body).

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_MIRO_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_MIRO_CLIENT_SECRET = "..."`;

export const MIRO_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_MIRO_CLIENT_SECRET to your Miro app's Client Secret.

Miro's token exchange requires the client secret form-encoded in the request body (it is not stored in the Nimbus vault).

miro.com → your app → settings → copy the Client Secret.

PowerShell example:
  $env:NIMBUS_OAUTH_MIRO_CLIENT_SECRET = "..."`;

export const CANVA_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_CANVA_CLIENT_ID to your Canva app's Client ID (OAuth 2.0 authorization-code flow WITH PKCE).

How to obtain:
1. canva.com/developers → create or open an integration.
2. Add the read scopes you need (e.g. design:meta:read).
3. Configure a redirect URL for the local loopback callback (Nimbus binds a localhost port).
4. Copy the Client ID from the integration's configuration page.

You must also set NIMBUS_OAUTH_CANVA_CLIENT_SECRET (Canva's token endpoint authenticates the client via an HTTP Basic header).

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_CANVA_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_CANVA_CLIENT_SECRET = "..."`;

export const CANVA_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_CANVA_CLIENT_SECRET to your Canva app's Client Secret.

Canva's token exchange authenticates the client via an HTTP Basic header (base64(client_id:client_secret)) alongside the PKCE code_verifier (it is not stored in the Nimbus vault).

canva.com/developers → your integration → copy the Client Secret.

PowerShell example:
  $env:NIMBUS_OAUTH_CANVA_CLIENT_SECRET = "..."`;

export const FIGMA_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_FIGMA_CLIENT_ID to your Figma app's Client ID (OAuth 2.0 authorization-code flow).

How to obtain:
1. figma.com/developers/apps → create or open an app.
2. Add the read scopes you need (e.g. files:read).
3. Configure a redirect URL for the local loopback callback (Nimbus binds a localhost port).
4. Copy the Client ID from the app's configuration page.

You must also set NIMBUS_OAUTH_FIGMA_CLIENT_SECRET (Figma's token endpoint requires the client secret in the request body).

This connector also needs your Figma team id — set it once via the vault key figma.team_id (see the connector README); v1 indexes a single configured team's files.

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_FIGMA_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_FIGMA_CLIENT_SECRET = "..."`;

export const FIGMA_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_FIGMA_CLIENT_SECRET to your Figma app's Client Secret.

Figma's token exchange requires the client secret form-encoded in the request body (it is not stored in the Nimbus vault).

figma.com/developers/apps → your app → copy the Client Secret.

PowerShell example:
  $env:NIMBUS_OAUTH_FIGMA_CLIENT_SECRET = "..."`;

export const SALESFORCE_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_SALESFORCE_CLIENT_ID to your Salesforce connected app's Consumer Key (OAuth 2.0 authorization-code flow WITH PKCE).

How to obtain:
1. Salesforce Setup → App Manager → New Connected App (or open an existing one).
2. Enable OAuth Settings; add the scopes you need (e.g. api, refresh_token) and a redirect URL for the local loopback callback (Nimbus binds a localhost port).
3. Copy the Consumer Key from the connected app's API (Enable OAuth Settings) section.

You must also set NIMBUS_OAUTH_SALESFORCE_CLIENT_SECRET (Salesforce's token endpoint requires the client secret — the Consumer Secret — in the request body).

The per-tenant API host (instance_url) is discovered automatically during the OAuth exchange and stored alongside the tokens — you do not configure it.

Before starting the gateway (PowerShell example):
  $env:NIMBUS_OAUTH_SALESFORCE_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_SALESFORCE_CLIENT_SECRET = "..."`;

export const SALESFORCE_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_SALESFORCE_CLIENT_SECRET to your Salesforce connected app's Consumer Secret.

Salesforce's token exchange requires the client secret form-encoded in the request body (it is not stored in the Nimbus vault).

Salesforce Setup → App Manager → your connected app → Manage Consumer Details → copy the Consumer Secret.

PowerShell example:
  $env:NIMBUS_OAUTH_SALESFORCE_CLIENT_SECRET = "..."`;

export const MENDELEY_OAUTH_CLIENT_ID_HELP = `Set NIMBUS_OAUTH_MENDELEY_CLIENT_ID to your Elsevier/Mendeley application's OAuth client ID.

1. https://dev.mendeley.com/myapps.html → register an application with the authorization-code flow.
2. Set the redirect URI to the Nimbus loopback redirect.

You must also set NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET (Mendeley's token endpoint requires HTTP Basic auth with the secret).

PowerShell:
  $env:NIMBUS_OAUTH_MENDELEY_CLIENT_ID = "..."
  $env:NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET = "..."`;

export const MENDELEY_OAUTH_CLIENT_SECRET_HELP = `Set NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET to your Mendeley application's OAuth client secret.

Mendeley's token exchange requires the client secret in the environment (it is not stored in the Nimbus vault).
https://dev.mendeley.com/myapps.html → your application → copy the secret.

PowerShell:
  $env:NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET = "..."`;
