// What the Connect step offers (role packs P5): `catalog.list`'s `suggestedConnectors` — the active
// packs' suggestions, or the gateway's neutral default — each with how it signs in.

export type SignIn = "browser" | "atlassian" | "terminal";

export interface Suggestion {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly signIn: SignIn;
}

/** An older gateway's catalog has no suggestions: today's six, which all sign in elsewhere first. */
export const FALLBACK_SUGGESTIONS = [
  "google_drive",
  "slack",
  "notion",
  "gmail",
  "github",
  "linear",
] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isSignIn(v: unknown): v is SignIn {
  return v === "browser" || v === "atlassian" || v === "terminal";
}

export function suggestionsFrom(catalog: unknown): readonly Suggestion[] {
  const c = isRecord(catalog) ? catalog : {};
  const byId = new Map<string, Record<string, unknown>>();
  for (const raw of Array.isArray(c["connectors"]) ? c["connectors"] : []) {
    if (isRecord(raw) && typeof raw["id"] === "string") byId.set(raw["id"], raw);
  }
  const ids = Array.isArray(c["suggestedConnectors"])
    ? c["suggestedConnectors"].filter((x): x is string => typeof x === "string")
    : [...FALLBACK_SUGGESTIONS];
  return ids.map((id) => {
    const row = byId.get(id);
    const name = row?.["displayName"] ?? row?.["name"];
    const description = row?.["description"];
    const signIn = row?.["signIn"];
    return {
      id,
      displayName: typeof name === "string" ? name : id,
      description: typeof description === "string" ? description : "",
      signIn: isSignIn(signIn) ? signIn : "terminal",
    };
  });
}

/** `connector.listStatus` ids that are connected: a health row that is not `unauthenticated`. */
export function connectedIds(statuses: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of Array.isArray(statuses) ? statuses : []) {
    if (!isRecord(raw)) continue;
    const id = raw["serviceId"];
    const health = raw["healthState"];
    if (typeof id === "string" && typeof health === "string" && health !== "unauthenticated") {
      out.add(id);
    }
  }
  return out;
}
