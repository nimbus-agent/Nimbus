import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import {
  hostnameFromUrl,
  manifestForFirstParty,
  manifestWithExtraNetworkHosts,
} from "./first-party-manifests.ts";
import { connectorSpawn } from "./keys.ts";
import { addSimpleTokenServer, imapPortOrDefault } from "./phase3-shared.ts";
import type { ServerSpec } from "./slot.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

function wrap(spec: ServerSpec, serviceId: string, sandboxCwd: string): ServerSpec {
  return wrapServerSpec(spec, manifestForFirstParty(serviceId), sandboxCwd);
}

export async function phase3AddStripeMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "stripe",
    script: "stripe",
    secretKey: "api_key",
    envKey: "STRIPE_API_KEY",
  });
}

export async function phase3AddMercuryMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "mercury",
    script: "mercury",
    secretKey: "token",
    envKey: "MERCURY_TOKEN",
  });
}

export async function phase3AddReadwiseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "readwise",
    script: "readwise",
    secretKey: "token",
    envKey: "READWISE_TOKEN",
  });
}

export async function phase3AddRaindropMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "raindrop",
    script: "raindrop",
    secretKey: "token",
    envKey: "RAINDROP_TOKEN",
  });
}

export async function phase3AddIntercomMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "intercom",
    script: "intercom",
    secretKey: "token",
    envKey: "INTERCOM_TOKEN",
  });
}

export async function phase3AddZendeskMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const url = (await readConnectorSecret(vault, "zendesk", "url"))?.trim() ?? "";
  const email = (await readConnectorSecret(vault, "zendesk", "email"))?.trim() ?? "";
  const apiToken = (await readConnectorSecret(vault, "zendesk", "api_token"))?.trim() ?? "";
  if (url === "" || email === "" || apiToken === "") {
    return;
  }
  const host = hostnameFromUrl(url);
  const manifest = manifestWithExtraNetworkHosts("zendesk", host === null ? [] : [host]);
  servers["zendesk"] = wrapServerSpec(
    {
      ...connectorSpawn("zendesk"),
      env: extensionProcessEnv({
        ZENDESK_URL: url,
        ZENDESK_EMAIL: email,
        ZENDESK_API_TOKEN: apiToken,
      }),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddLeverMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "lever",
    script: "lever",
    secretKey: "api_key",
    envKey: "LEVER_API_KEY",
  });
}

export async function phase3AddGreenhouseMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "greenhouse",
    script: "greenhouse",
    secretKey: "api_key",
    envKey: "GREENHOUSE_API_KEY",
  });
}

export async function phase3AddPipedriveMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  await addSimpleTokenServer(vault, servers, sandboxCwd, {
    serviceId: "pipedrive",
    script: "pipedrive",
    secretKey: "token",
    envKey: "PIPEDRIVE_TOKEN",
  });
}

export async function phase3AddStackoverflowMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const token = (await readConnectorSecret(vault, "stackoverflow", "token"))?.trim() ?? "";
  const team = (await readConnectorSecret(vault, "stackoverflow", "team"))?.trim() ?? "";
  if (token === "" || team === "") {
    return;
  }
  servers["stackoverflow"] = wrap(
    {
      ...connectorSpawn("stackoverflow"),
      env: extensionProcessEnv({
        STACKOVERFLOW_TOKEN: token,
        STACKOVERFLOW_TEAM: team,
      }),
    },
    "stackoverflow",
    sandboxCwd,
  );
}

export async function phase3AddZoteroMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const apiKey = (await readConnectorSecret(vault, "zotero", "api_key"))?.trim() ?? "";
  const library = (await readConnectorSecret(vault, "zotero", "library"))?.trim() ?? "";
  if (apiKey === "" || library === "") {
    return;
  }
  servers["zotero"] = wrap(
    {
      ...connectorSpawn("zotero"),
      env: extensionProcessEnv({
        ZOTERO_API_KEY: apiKey,
        ZOTERO_LIBRARY: library,
      }),
    },
    "zotero",
    sandboxCwd,
  );
}

export async function phase3AddRampMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const clientId = (await readConnectorSecret(vault, "ramp", "client_id"))?.trim() ?? "";
  const clientSecret = (await readConnectorSecret(vault, "ramp", "client_secret"))?.trim() ?? "";
  if (clientId === "" || clientSecret === "") {
    return;
  }
  servers["ramp"] = wrap(
    {
      ...connectorSpawn("ramp"),
      env: extensionProcessEnv({
        RAMP_CLIENT_ID: clientId,
        RAMP_CLIENT_SECRET: clientSecret,
      }),
    },
    "ramp",
    sandboxCwd,
  );
}

export async function phase3AddImapMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // IMAP/SMTP (Tier-4 EMAIL) is per-tenant. Gate on the IMAP read credentials
  // (host + username + password); SMTP creds are optional (send tool).
  const host = (await readConnectorSecret(vault, "imap", "host"))?.trim() ?? "";
  const username = (await readConnectorSecret(vault, "imap", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(vault, "imap", "password"))?.trim() ?? "";
  if (host === "" || username === "" || password === "") {
    return;
  }
  const portRaw = (await readConnectorSecret(vault, "imap", "port"))?.trim() ?? "";
  const port = imapPortOrDefault(portRaw, 993);
  const mailbox = (await readConnectorSecret(vault, "imap", "mailbox"))?.trim() ?? "";

  const smtpHost = (await readConnectorSecret(vault, "imap", "smtp_host"))?.trim() ?? "";
  const smtpUser = (await readConnectorSecret(vault, "imap", "smtp_username"))?.trim() ?? "";
  const smtpPass = (await readConnectorSecret(vault, "imap", "smtp_password"))?.trim() ?? "";
  const smtpPortRaw = (await readConnectorSecret(vault, "imap", "smtp_port"))?.trim() ?? "";
  const smtpPort = imapPortOrDefault(smtpPortRaw, 465);

  // The IMAP host (and SMTP host, if configured) are on non-443 ports — add the
  // concrete host:port entries to the sandbox network allow-list at spawn time.
  const extraHosts: string[] = [`${host}:${String(port)}`];
  if (smtpHost !== "") {
    extraHosts.push(`${smtpHost}:${String(smtpPort)}`);
  }
  const manifest = manifestWithExtraNetworkHosts("imap", extraHosts);

  const env: Record<string, string> = {
    IMAP_HOST: host,
    IMAP_PORT: String(port),
    IMAP_USERNAME: username,
    IMAP_PASSWORD: password,
  };
  if (mailbox !== "") {
    env["IMAP_MAILBOX"] = mailbox;
  }
  if (smtpHost !== "") {
    env["IMAP_SMTP_HOST"] = smtpHost;
    env["IMAP_SMTP_PORT"] = String(smtpPort);
  }
  if (smtpUser !== "") {
    env["IMAP_SMTP_USERNAME"] = smtpUser;
  }
  if (smtpPass !== "") {
    env["IMAP_SMTP_PASSWORD"] = smtpPass;
  }

  servers["imap"] = wrapServerSpec(
    {
      ...connectorSpawn("imap"),
      env: extensionProcessEnv(env),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddProtonmailMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // ProtonMail via Bridge (Tier-4 EMAIL). Gate on the Bridge IMAP credentials;
  // SMTP creds are optional (send tool). Host/port default to the Bridge
  // loopback listeners (127.0.0.1:1143 IMAP / :1025 SMTP).
  const username = (await readConnectorSecret(vault, "protonmail", "username"))?.trim() ?? "";
  const password = (await readConnectorSecret(vault, "protonmail", "password"))?.trim() ?? "";
  if (username === "" || password === "") {
    return;
  }
  const host = (await readConnectorSecret(vault, "protonmail", "imap_host"))?.trim() || "127.0.0.1";
  const portRaw = (await readConnectorSecret(vault, "protonmail", "imap_port"))?.trim() ?? "";
  const port = imapPortOrDefault(portRaw, 1143);
  const mailbox = (await readConnectorSecret(vault, "protonmail", "mailbox"))?.trim() ?? "";

  const smtpHost =
    (await readConnectorSecret(vault, "protonmail", "smtp_host"))?.trim() || "127.0.0.1";
  const smtpUser = (await readConnectorSecret(vault, "protonmail", "smtp_username"))?.trim() ?? "";
  const smtpPass = (await readConnectorSecret(vault, "protonmail", "smtp_password"))?.trim() ?? "";
  const smtpPortRaw = (await readConnectorSecret(vault, "protonmail", "smtp_port"))?.trim() ?? "";
  const smtpPort = imapPortOrDefault(smtpPortRaw, 1025);

  // Bridge IMAP/SMTP are on non-443 loopback ports — add the concrete host:port
  // entries to the sandbox network allow-list at spawn time. SMTP host is only
  // added when send credentials are configured.
  const extraHosts: string[] = [`${host}:${String(port)}`];
  if (smtpUser !== "" && smtpPass !== "") {
    extraHosts.push(`${smtpHost}:${String(smtpPort)}`);
  }
  const manifest = manifestWithExtraNetworkHosts("protonmail", extraHosts);

  const env: Record<string, string> = {
    PROTONMAIL_HOST: host,
    PROTONMAIL_PORT: String(port),
    PROTONMAIL_USERNAME: username,
    PROTONMAIL_PASSWORD: password,
  };
  if (mailbox !== "") {
    env["PROTONMAIL_MAILBOX"] = mailbox;
  }
  if (smtpUser !== "" && smtpPass !== "") {
    env["PROTONMAIL_SMTP_HOST"] = smtpHost;
    env["PROTONMAIL_SMTP_PORT"] = String(smtpPort);
    env["PROTONMAIL_SMTP_USERNAME"] = smtpUser;
    env["PROTONMAIL_SMTP_PASSWORD"] = smtpPass;
  }

  servers["protonmail"] = wrapServerSpec(
    {
      ...connectorSpawn("protonmail"),
      env: extensionProcessEnv(env),
    },
    manifest,
    sandboxCwd,
  );
}

export async function phase3AddFastmailMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  // Fastmail (Tier-4 EMAIL via JMAP) — gate on the API token. The base URL is an
  // optional non-secret override (default api.fastmail.com); the static manifest
  // host covers the JMAP session/api endpoints, so no extra-host merge is needed.
  const apiToken = (await readConnectorSecret(vault, "fastmail", "api_token"))?.trim() ?? "";
  if (apiToken === "") {
    return;
  }
  const baseUrl = (await readConnectorSecret(vault, "fastmail", "base_url"))?.trim() ?? "";

  const env: Record<string, string> = { FASTMAIL_API_TOKEN: apiToken };
  if (baseUrl !== "") {
    env["FASTMAIL_BASE_URL"] = baseUrl;
  }

  servers["fastmail"] = wrap(
    {
      ...connectorSpawn("fastmail"),
      env: extensionProcessEnv(env),
    },
    "fastmail",
    sandboxCwd,
  );
}
