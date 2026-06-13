export type McpListResult = { content: Array<{ type: "text"; text: string }> };

export function mcpJsonResult(data: unknown): McpListResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export type ZodObjectSchema<T> = {
  readonly shape: Record<string, unknown>;
  safeParse: (
    args: unknown,
  ) => { success: true; data: T } | { success: false; error: { message: string } };
};

export function registerZodTool<T>(
  registerSimpleTool: RegisterSimpleToolFn,
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
): void {
  registerSimpleTool(
    name,
    description,
    schema.shape,
    async (args: unknown): Promise<McpListResult> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      return handler(parsed.data);
    },
  );
}

export function createZodToolRegistrar(registerSimpleTool: RegisterSimpleToolFn) {
  return <T>(
    name: string,
    description: string,
    schema: ZodObjectSchema<T>,
    handler: (args: T) => Promise<McpListResult>,
  ): void => {
    registerZodTool(registerSimpleTool, name, description, schema, handler);
  };
}

export type HttpTextResponse = { ok: boolean; status: number; text: string };

export type HttpJsonBodyResponse = { ok: boolean; status: number; json: unknown; text: string };

/** After a JSON-body fetch: throw with status + body snippet, else wrap `json` for MCP. */
export function mcpJsonResultIfOk(
  serviceLabel: string,
  res: HttpJsonBodyResponse,
  snippetMax = 300,
): McpListResult {
  if (!res.ok) {
    throw new Error(`${serviceLabel} ${String(res.status)}: ${res.text.slice(0, snippetMax)}`);
  }
  return mcpJsonResult(res.json);
}

/**
 * After a text-body fetch: throw with status + body snippet, else parse JSON and wrap for MCP.
 * Use `jsonParseErrorMessage` when parse failures need a stable diagnostic (e.g. Jira tools).
 */
export function mcpJsonResultFromTextIfOk(
  serviceLabel: string,
  res: HttpTextResponse,
  options?: { maxSnippet?: number; jsonParseErrorMessage?: string },
): McpListResult {
  const max = options?.maxSnippet ?? 400;
  if (!res.ok) {
    throw new Error(`${serviceLabel} ${String(res.status)}: ${res.text.slice(0, max)}`);
  }
  try {
    return mcpJsonResult(JSON.parse(res.text) as unknown);
  } catch {
    if (options?.jsonParseErrorMessage !== undefined) {
      throw new Error(options.jsonParseErrorMessage);
    }
    throw new Error(`${serviceLabel}: invalid JSON response`);
  }
}

/** Like {@link mcpJsonResultFromTextIfOk} but returns parsed JSON for composing multi-part tool results. */
export function parseJsonTextIfOk(
  serviceLabel: string,
  res: HttpTextResponse,
  maxSnippet = 400,
): unknown {
  if (!res.ok) {
    throw new Error(`${serviceLabel} ${String(res.status)}: ${res.text.slice(0, maxSnippet)}`);
  }
  return JSON.parse(res.text) as unknown;
}

export function putOptionalNonEmptyString(
  body: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined && value !== "") {
    body[key] = value;
  }
}

export function putOptionalBoolean(
  body: Record<string, unknown>,
  key: string,
  value: boolean | undefined,
): void {
  if (value !== undefined) {
    body[key] = value;
  }
}

/** Input shape matches MCP `server.tool` zod fields; typed as unknown to avoid a zod import from this shared path. */
export type RegisterSimpleToolFn = (
  name: string,
  description: string,
  inputShape: Record<string, unknown>,
  handler: (args: unknown) => Promise<McpListResult>,
) => unknown;

export function createRegisterSimpleTool(server: unknown): RegisterSimpleToolFn {
  if (
    typeof server !== "object" ||
    server === null ||
    !("tool" in server) ||
    typeof server.tool !== "function"
  ) {
    throw new Error("createRegisterSimpleTool: expected MCP server with .tool");
  }
  const host = server as { tool: (...args: never) => unknown };
  return host.tool.bind(server) as RegisterSimpleToolFn;
}

export function requireProcessEnv(envVarName: string): string {
  const t = process.env[envVarName];
  if (t === undefined || t === "") {
    throw new Error(`${envVarName} is not set`);
  }
  return t;
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP Basic header for email:API-token style Atlassian credentials (never log the raw value). */
export function encodeBasicAuthHeader(email: string, token: string): string {
  const raw = `${email}:${token}`;
  const b64 = Buffer.from(raw, "utf8").toString("base64");
  return `Basic ${b64}`;
}
