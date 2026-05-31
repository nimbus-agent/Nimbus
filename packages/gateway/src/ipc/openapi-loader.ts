import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const cache = new Map<string, Uint8Array>();

export function loadOpenApiJsonBytes(absolutePath: string): Uint8Array {
  const cached = cache.get(absolutePath);
  if (cached !== undefined) {
    return cached;
  }
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf8");
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to read openapi schema at ${absolutePath}: ${cause}`);
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(raw, { filename: absolutePath });
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to parse openapi schema at ${absolutePath}: ${cause}`);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed));
  cache.set(absolutePath, bytes);
  return bytes;
}
