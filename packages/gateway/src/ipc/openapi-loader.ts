import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const cache = new Map<string, Uint8Array>();

export type OpenApiLoaderDeps = {
  readFile: (path: string) => string;
  parseYaml: (raw: string, path: string) => unknown;
};

const defaultDeps: OpenApiLoaderDeps = {
  readFile: (path) => readFileSync(path, "utf8"),
  parseYaml: (raw, path) => yaml.load(raw, { filename: path }),
};

export function loadOpenApiJsonBytes(
  absolutePath: string,
  _deps: OpenApiLoaderDeps = defaultDeps,
): Uint8Array {
  const cached = cache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  let raw: string;
  try {
    raw = _deps.readFile(absolutePath);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to read openapi schema at ${absolutePath}: ${cause}`);
  }
  let parsed: unknown;
  try {
    parsed = _deps.parseYaml(raw, absolutePath);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to parse openapi schema at ${absolutePath}: ${cause}`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  cache.set(absolutePath, bytes);
  return bytes;
}
