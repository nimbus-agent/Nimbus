import { parse as parseYaml } from "yaml";

export interface LoadDeps {
  fetch: typeof fetch;
  readFile: (p: string) => Promise<Uint8Array>;
  now: () => number;
}

export const MAX_OPENAPI_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const SWAGGER_MESSAGE =
  "Swagger 2.0 is not supported; convert it to OpenAPI 3 first (for example with swagger2openapi)";

export class OpenApiLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenApiLoadError";
  }
}

function tooLarge(): OpenApiLoadError {
  return new OpenApiLoadError(`The OpenAPI document is larger than ${MAX_OPENAPI_BYTES} bytes`);
}

function stripBom(text: string): string {
  return text.codePointAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readBodyCapped(res: Response): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_OPENAPI_BYTES) throw tooLarge();
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_OPENAPI_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function assertHttps(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OpenApiLoadError("Not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new OpenApiLoadError(`Only https: URLs are supported, not ${url.protocol}`);
  }
  return url;
}

function describeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function resolveRedirect(location: string, base: URL): string {
  try {
    return new URL(location, base).href;
  } catch {
    throw new OpenApiLoadError("the server sent an unusable redirect");
  }
}

async function fetchBytes(source: string, deps: LoadDeps): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  let url = assertHttps(source);
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    let res: Response;
    try {
      res = await deps.fetch(url.href, { redirect: "manual", signal });
    } catch (e) {
      throw new OpenApiLoadError(`Could not fetch ${describeUrl(url)}: ${(e as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location === null) throw new OpenApiLoadError("Redirect without a Location header");
      await res.body?.cancel();
      url = assertHttps(resolveRedirect(location, url));
      continue;
    }
    if (!res.ok) {
      throw new OpenApiLoadError(`Fetching ${describeUrl(url)} failed with status ${res.status}`);
    }
    return await readBodyCapped(res);
  }
  throw new OpenApiLoadError(`Too many redirects (more than ${MAX_REDIRECTS})`);
}

async function readBytes(source: string, deps: LoadDeps): Promise<Uint8Array> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) return await fetchBytes(source, deps);
  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(source);
  } catch (e) {
    throw new OpenApiLoadError(`Could not read ${source}: ${(e as Error).message}`);
  }
  if (bytes.byteLength > MAX_OPENAPI_BYTES) throw tooLarge();
  return bytes;
}

function parseText(text: string): unknown {
  if (text.trimStart().startsWith("{")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // flow-style YAML may also start with a brace
    }
  }
  try {
    return parseYaml(text, { maxAliasCount: 100 }) as unknown;
  } catch (e) {
    throw new OpenApiLoadError(`Could not parse the document: ${(e as Error).message}`);
  }
}

function validate(doc: unknown): Record<string, unknown> {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new OpenApiLoadError("The OpenAPI document must be an object");
  }
  const rec = doc as Record<string, unknown>;
  if (rec["swagger"] === "2.0" || rec["swagger"] === 2) {
    throw new OpenApiLoadError(SWAGGER_MESSAGE);
  }
  const version = rec["openapi"];
  if (typeof version !== "string") {
    throw new OpenApiLoadError("The document has no `openapi` version string");
  }
  if (!version.startsWith("3.0.") && !version.startsWith("3.1.")) {
    throw new OpenApiLoadError(`OpenAPI ${version} is not supported; use 3.0 or 3.1`);
  }
  return rec;
}

export async function loadOpenApiDocument(
  source: string,
  deps: LoadDeps,
): Promise<Record<string, unknown>> {
  const bytes = await readBytes(source, deps);
  return validate(parseText(stripBom(new TextDecoder("utf-8").decode(bytes))));
}
