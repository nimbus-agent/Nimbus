const OUTLOOK_TOOL_MIN_SCOPES: Readonly<Record<string, readonly string[]>> = {
  outlook_mail_folders: ["Mail.Read"],
  outlook_mail_list: ["Mail.Read"],
  outlook_mail_read: ["Mail.Read"],
  outlook_mail_send: ["Mail.Send"],
  outlook_calendar_list: ["Calendars.Read"],
  outlook_calendar_get: ["Calendars.Read"],
  outlook_calendar_create: ["Calendars.ReadWrite"],
  outlook_calendar_delete: ["Calendars.ReadWrite"],
  outlook_contact_list: ["Contacts.Read"],
  outlook_contact_get: ["Contacts.Read"],
};

function scopeSatisfied(granted: ReadonlySet<string>, required: string): boolean {
  if (granted.has(required)) {
    return true;
  }
  if (required === "Calendars.Read" && granted.has("Calendars.ReadWrite")) {
    return true;
  }
  if (required === "Mail.Read" && granted.has("Mail.ReadWrite")) {
    return true;
  }
  return false;
}

export function outlookToolAllowed(toolId: string, grantedScopes: readonly string[]): boolean {
  const reqs = OUTLOOK_TOOL_MIN_SCOPES[toolId];
  if (reqs === undefined) {
    return true;
  }
  const g = new Set(grantedScopes);
  return reqs.every((r) => scopeSatisfied(g, r));
}

export function parseMicrosoftOAuthScopesFromEnv(): string[] | undefined {
  const raw = process.env["MICROSOFT_OAUTH_SCOPES"];
  if (raw === undefined) {
    return undefined;
  }
  const parts = raw.split(/\s+/).filter((s) => s.length > 0);
  return parts.length === 0 ? undefined : parts;
}

export function outlookToolShouldRegister(
  toolId: string,
  grantedFromEnv: string[] | undefined,
): boolean {
  if (grantedFromEnv === undefined) {
    return true;
  }
  return outlookToolAllowed(toolId, grantedFromEnv);
}
