// packages/gateway/src/connectors/connector-writes/installed-schema-keys.test-helpers.ts
// Test helpers for the connectors 0.19.0 row tests: the top-level keys of a zod object literal in
// the INSTALLED `@nimbus-dev/connectors` source, so a row's drift keys are checked against the
// schema the gateway actually runs, not a copy of it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";

/** The comment-free text of `connectors/<connector>/src/tools.ts` in the installed package. */
export function installedToolsSource(connector: string): string {
  const path = join(installedConnectorsPackageRoot(), "connectors", connector, "src", "tools.ts");
  return stripComments(readFileSync(path, "utf8"));
}

/**
 * The keys at the top level of the first object literal (`{ ... }`) at or after `anchor` in `src`:
 * every identifier followed by `:` at brace depth 1. Throws when the anchor is missing, so a
 * renamed schema fails the test instead of yielding no keys.
 */
export function objectKeysAt(src: string, anchor: string): readonly string[] {
  const at = src.indexOf(anchor);
  if (at === -1) throw new Error(`anchor not found: ${anchor}`);
  const open = src.indexOf("{", at);
  if (open === -1) throw new Error(`no object after: ${anchor}`);
  const keys: string[] = [];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    } else if (depth === 1) {
      const m = /^([A-Za-z_]\w*)\s*:/.exec(src.slice(i));
      const prev = src[i - 1] ?? "";
      if (m?.[1] !== undefined && !/[\w$.]/.test(prev)) {
        keys.push(m[1]);
        i += m[1].length - 1;
      }
    }
  }
  return keys;
}

const SOURCES = readConnectorPackageSources(installedConnectorsPackageRoot());
const SCAN = scanWriteToolRegistrations(SOURCES);

/** The comment-free text of the one call that registers write tool `id` in `connector`. */
export function installedRegistration(id: string, connector: string): string {
  const hits = SCAN.registrations.filter(
    (r) => r.id === id && r.origin.split("/")[1] === connector,
  );
  if (hits.length !== 1) throw new Error(`${id}: ${String(hits.length)} registrations`);
  const r = hits[0];
  if (r === undefined) throw new Error("unreachable");
  const src = SOURCES.find((s) => s.rel === r.file);
  return stripComments(src?.text ?? "").slice(r.span[0], r.span[1] + 1);
}
