import { load as yamlLoad } from "js-yaml";

export type ParsedEndpoint = {
  method: string;
  path: string;
  operationId: string | undefined;
  tags: readonly string[];
  deprecated: boolean;
};

export type ParsedSpec = {
  kind: "parsed";
  endpoints: readonly ParsedEndpoint[];
  specVersion: string;
  infoTitle: string;
};

export type SkipReason = "too_large" | "parse_failed" | "not_a_spec";

export type ParseResult = ParsedSpec | { kind: "skipped"; reason: SkipReason };

export type ParseInput = {
  absPath: string;
  source: string;
  maxBytes: number;
};

const HTTP_METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);

function looksLikeOpenApi(doc: unknown): doc is {
  openapi?: string;
  swagger?: string;
  asyncapi?: string;
  info?: { title?: string };
  paths?: Record<string, unknown>;
} {
  return typeof doc === "object" && doc !== null;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function specVersionFromDoc(doc: {
  openapi?: string;
  swagger?: string;
  asyncapi?: string;
}): string | undefined {
  if (typeof doc.openapi === "string") {
    return `openapi-${doc.openapi}`;
  }
  if (typeof doc.swagger === "string") {
    return `swagger-${doc.swagger}`;
  }
  if (typeof doc.asyncapi === "string") {
    return `asyncapi-${doc.asyncapi}`;
  }
  return undefined;
}

function extractOpenapiEndpoints(doc: {
  paths?: Record<string, unknown>;
}): readonly ParsedEndpoint[] {
  const out: ParsedEndpoint[] = [];
  const paths = doc.paths;
  if (typeof paths !== "object" || paths === null) {
    return out;
  }
  for (const [pth, item] of Object.entries(paths)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const obj = item as Record<string, unknown>;
    for (const [verb, op] of Object.entries(obj)) {
      if (!HTTP_METHODS.has(verb.toLowerCase())) {
        continue;
      }
      if (typeof op !== "object" || op === null) {
        continue;
      }
      const o = op as Record<string, unknown>;
      out.push({
        method: verb.toUpperCase(),
        path: pth,
        operationId: asString(o["operationId"]),
        tags: asStringArray(o["tags"]),
        deprecated: o["deprecated"] === true,
      });
    }
  }
  return out;
}

function extractAsyncapiEndpoints(doc: {
  channels?: Record<string, unknown>;
}): readonly ParsedEndpoint[] {
  const out: ParsedEndpoint[] = [];
  const ch = doc.channels;
  if (typeof ch !== "object" || ch === null) {
    return out;
  }
  for (const [chPath, chBody] of Object.entries(ch)) {
    if (typeof chBody !== "object" || chBody === null) {
      continue;
    }
    const b = chBody as Record<string, unknown>;
    for (const verb of ["publish", "subscribe"] as const) {
      const op = b[verb];
      if (typeof op !== "object" || op === null) {
        continue;
      }
      const o = op as Record<string, unknown>;
      out.push({
        method: verb.toUpperCase(),
        path: chPath,
        operationId: asString(o["operationId"]),
        tags: asStringArray(o["tags"]),
        deprecated: o["deprecated"] === true,
      });
    }
  }
  return out;
}

function parseStringToJson(absPath: string, source: string): unknown {
  const trimmed = source.trimStart();
  if (
    absPath.toLowerCase().endsWith(".json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[")
  ) {
    try {
      return JSON.parse(source) as unknown;
    } catch {
      return undefined;
    }
  }
  try {
    return yamlLoad(source) as unknown;
  } catch {
    return undefined;
  }
}

export function parseSpec(input: ParseInput): ParseResult {
  if (Buffer.byteLength(input.source, "utf8") > input.maxBytes) {
    return { kind: "skipped", reason: "too_large" };
  }
  const raw = parseStringToJson(input.absPath, input.source);
  if (raw === undefined) {
    return { kind: "skipped", reason: "parse_failed" };
  }
  if (!looksLikeOpenApi(raw)) {
    return { kind: "skipped", reason: "not_a_spec" };
  }
  const version = specVersionFromDoc(raw);
  if (version === undefined) {
    return { kind: "skipped", reason: "not_a_spec" };
  }
  const isAsync = version.startsWith("asyncapi-");
  let endpoints: readonly ParsedEndpoint[];
  try {
    endpoints = isAsync
      ? extractAsyncapiEndpoints(raw as { channels?: Record<string, unknown> })
      : extractOpenapiEndpoints(raw as { paths?: Record<string, unknown> });
  } catch {
    return { kind: "skipped", reason: "parse_failed" };
  }
  return {
    kind: "parsed",
    endpoints,
    specVersion: version,
    infoTitle: asString((raw as { info?: { title?: string } }).info?.title) ?? "",
  };
}
