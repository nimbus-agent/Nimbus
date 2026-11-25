/**
 * The shared first step of reading a signed registry file (index, trust feed, liveness): refuse it
 * past its byte cap, decode it as strict UTF-8 (one leading byte-order mark is dropped) and parse it
 * as JSON. The caller checks the shape; `invalid` builds the caller's own error for a bad file.
 */
import { RegistryError } from "./errors.ts";

export function decodeJsonFile(
  bytes: Uint8Array,
  name: string,
  maxBytes: number,
  invalid: (detail: string) => RegistryError,
): unknown {
  if (bytes.byteLength > maxBytes) {
    throw new RegistryError("ERR_REGISTRY_TOO_LARGE", `${name} exceeds ${String(maxBytes)} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw invalid(`${name} is not valid UTF-8`);
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  try {
    return JSON.parse(text);
  } catch {
    throw invalid(`${name} is not valid JSON`);
  }
}
