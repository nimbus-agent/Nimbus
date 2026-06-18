/**
 * Pure JMAP / Fastmail request-building and response-parsing utilities.
 *
 * Shared between `packages/gateway` (fastmail-sync connector) and
 * `packages/mcp-connectors/fastmail`. Neither package can import the other
 * (gateway ↔ mcp boundary), so the PURE, I/O-free logic lives here.
 *
 * HARD SCOPE CONSTRAINT (security): this module handles HEADERS + a short
 * capped plain-text body PREVIEW + attachment METADATA only. The JMAP
 * `Email/get` calls request `maxBodyValueBytes` (the server truncates the
 * body value, so a full body never crosses the wire) and store only the
 * `attachments` body-part METADATA (name/size/type) — the `blobId` download
 * URL is NEVER dereferenced. There is no surface to fetch attachment bytes
 * or a full body.
 *
 * I/O (fetch / connectorFetch / session discovery) stays in each caller.
 */

export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";

/** Max bytes of a text body value the server returns (preview only, ~2 KB). */
export const MAX_BODY_VALUE_BYTES = 2048;
/** Max characters of the plain-text body preview ever returned. */
export const PREVIEW_MAX_CHARS = 2000;

/** The email properties we request — headers + attachment metadata + preview only. */
export const EMAIL_PROPERTIES: readonly string[] = [
  "id",
  "blobId",
  "threadId",
  "subject",
  "from",
  "to",
  "cc",
  "receivedAt",
  "sentAt",
  "messageId",
  "hasAttachment",
  "preview",
  "attachments",
  "textBody",
  "bodyValues",
];

/** One attachment's METADATA — name, size, mimetype. NEVER the bytes. */
export interface JmapAttachmentMeta {
  readonly name: string | null;
  readonly sizeBytes: number | null;
  readonly mimeType: string | null;
}

/**
 * The JSON-safe view of one email returned by the read tools. Carries HEADERS,
 * attachment METADATA, and the capped preview — never attachment bytes or a
 * full body.
 */
export interface JmapEmailView {
  readonly id: string;
  readonly messageId: string | null;
  readonly subject: string | null;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly receivedAt: string | null;
  readonly attachments: readonly JmapAttachmentMeta[];
  readonly preview: string;
}

/** Discovered JMAP session — the mail-account api url + account id. */
export interface JmapSession {
  readonly apiUrl: string;
  readonly accountId: string;
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Parse the JMAP session resource → the mail-account api url + account id. */
export function parseSession(parsed: unknown): JmapSession | null {
  const root = asRecord(parsed);
  if (root === null) {
    return null;
  }
  const apiUrl = asString(root["apiUrl"]);
  const primary = asRecord(root["primaryAccounts"]);
  const accountId = primary === null ? null : asString(primary[MAIL_CAPABILITY]);
  if (apiUrl === null || accountId === null) {
    return null;
  }
  return { apiUrl, accountId };
}

/**
 * Validate a JMAP `apiUrl` discovered from the (server-controlled) session
 * resource before it is used as a `fetch` target. The session JSON is
 * attacker-influenced data; without this check a spoofed/compromised session
 * response could redirect the authenticated POSTs that carry the bearer token
 * to an arbitrary host (SSRF). The apiUrl must be an absolute `https` URL on
 * the same host as the configured API base. Returns the re-serialized URL, or
 * throws.
 */
export function validateApiUrl(candidate: string, allowedBase: string): string {
  let parsed: URL;
  let base: URL;
  try {
    parsed = new URL(candidate);
    base = new URL(allowedBase);
  } catch {
    throw new Error("JMAP apiUrl is not a valid absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("JMAP apiUrl must use https");
  }
  if (parsed.host !== base.host) {
    throw new Error(`JMAP apiUrl host '${parsed.host}' does not match configured '${base.host}'`);
  }
  return parsed.toString();
}

/** Format one JMAP EmailAddress (`{ name?, email }`) as `Name <email>` / `email`. */
export function formatAddress(a: unknown): string {
  const r = asRecord(a);
  if (r === null) {
    return "";
  }
  const email = asString(r["email"]) ?? "";
  const name = asString(r["name"]);
  if (name !== null) {
    return email === "" ? name : `${name} <${email}>`;
  }
  return email;
}

export function formatAddresses(v: unknown): string[] {
  return Array.isArray(v) ? v.map(formatAddress).filter((s) => s !== "") : [];
}

export function extractAttachments(v: unknown): JmapAttachmentMeta[] {
  if (!Array.isArray(v)) {
    return [];
  }
  return v.map((raw) => {
    const r = asRecord(raw);
    const size = r === null ? null : r["size"];
    return {
      name: r === null ? null : asString(r["name"]),
      sizeBytes: typeof size === "number" && Number.isFinite(size) ? size : null,
      mimeType: r === null ? null : asString(r["type"]),
    };
  });
}

export function capPreview(text: string): string {
  const normalized = text
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return normalized.length > PREVIEW_MAX_CHARS
    ? normalized.slice(0, PREVIEW_MAX_CHARS)
    : normalized;
}

/**
 * Build the preview from the first `textBody` part's (server-truncated) body
 * value; fall back to the JMAP server-computed `preview` string. Both are
 * already bounded — we never receive the full body.
 */
export function previewFor(raw: Record<string, unknown>): string {
  const bodyValues = asRecord(raw["bodyValues"]);
  const textBody = raw["textBody"];
  if (bodyValues !== null && Array.isArray(textBody)) {
    for (const part of textBody) {
      const partId = asRecord(part)?.["partId"];
      if (typeof partId === "string") {
        const value = asRecord(bodyValues[partId])?.["value"];
        if (typeof value === "string" && value !== "") {
          return capPreview(value);
        }
      }
    }
  }
  return capPreview(asString(raw["preview"]) ?? "");
}

/** Reduce a raw JMAP email object to the JSON-safe header/metadata/preview view. */
export function viewEmail(raw: unknown): JmapEmailView | null {
  const r = asRecord(raw);
  if (r === null) {
    return null;
  }
  const id = asString(r["id"]);
  const messageIdArr = r["messageId"];
  const messageId = Array.isArray(messageIdArr) ? (asString(messageIdArr[0]) ?? null) : null;
  if (id === null && messageId === null) {
    return null;
  }
  return {
    id: id ?? "",
    messageId,
    subject: asString(r["subject"]),
    from: formatAddresses(r["from"]),
    to: formatAddresses(r["to"]),
    cc: formatAddresses(r["cc"]),
    receivedAt: asString(r["receivedAt"]),
    attachments: extractAttachments(r["attachments"]),
    preview: previewFor(r),
  };
}

/** The `Email/get` arguments shared by list/get/search (headers + metadata + capped preview). */
function emailGetArgs(accountId: string, idsRef: Record<string, unknown>): Record<string, unknown> {
  return {
    accountId,
    ...idsRef,
    properties: [...EMAIL_PROPERTIES],
    fetchTextBodyValues: true,
    maxBodyValueBytes: MAX_BODY_VALUE_BYTES,
    bodyProperties: ["partId", "blobId", "size", "name", "type", "disposition"],
  };
}

/** Build a JMAP request: query the most-recent `limit` emails, then get their views. */
export function buildListRequest(accountId: string, limit: number): unknown {
  return {
    using: [CORE_CAPABILITY, MAIL_CAPABILITY],
    methodCalls: [
      [
        "Email/query",
        {
          accountId,
          sort: [{ property: "receivedAt", isAscending: false }],
          collapseThreads: false,
          limit,
        },
        "q",
      ],
      [
        "Email/get",
        emailGetArgs(accountId, {
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        }),
        "e",
      ],
    ],
  };
}

/** Build a JMAP request: text-search the most-recent `limit` matching emails. */
export function buildSearchRequest(accountId: string, query: string, limit: number): unknown {
  return {
    using: [CORE_CAPABILITY, MAIL_CAPABILITY],
    methodCalls: [
      [
        "Email/query",
        {
          accountId,
          filter: { text: query },
          sort: [{ property: "receivedAt", isAscending: false }],
          collapseThreads: false,
          limit,
        },
        "q",
      ],
      [
        "Email/get",
        emailGetArgs(accountId, {
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        }),
        "e",
      ],
    ],
  };
}

/** Build a JMAP request: get one email by id. */
export function buildGetRequest(accountId: string, id: string): unknown {
  return {
    using: [CORE_CAPABILITY, MAIL_CAPABILITY],
    methodCalls: [["Email/get", emailGetArgs(accountId, { ids: [id] }), "e"]],
  };
}

/** Locate a named method response's argument object in a JMAP method-responses envelope. */
export function methodResponseArgs(
  parsed: unknown,
  methodName: string,
): Record<string, unknown> | null {
  const responses = asRecord(parsed)?.["methodResponses"];
  if (!Array.isArray(responses)) {
    return null;
  }
  for (const entry of responses) {
    if (Array.isArray(entry) && entry[0] === methodName) {
      return asRecord(entry[1]);
    }
  }
  return null;
}

/** Extract the `Email/get` response `list` of raw emails from a JMAP envelope. */
export function extractEmailList(parsed: unknown): unknown[] {
  const args = methodResponseArgs(parsed, "Email/get");
  const list = args?.["list"];
  return Array.isArray(list) ? list : [];
}
