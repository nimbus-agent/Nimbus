/**
 * Structural signature of an `<agent>.briefReady` payload.
 *
 * `@nimbus-dev/client` validates the `agents.*` wire contract against a fixture
 * generated from this repo (`gen-agent-brief-fixtures.ts`). Nothing links the two
 * at compile time and nothing regenerates the fixture, so a gateway change to a
 * brief shape leaves the client validating a contract the gateway no longer
 * speaks — and both sides stay green.
 *
 * This reduces a payload to sorted `path:type` pairs so a snapshot test can fail
 * on the PR that changes a shape, rather than a week later in a downstream repo.
 *
 * Values are deliberately discarded: `sessionId`, `generatedAt` and `latencyMs`
 * differ on every run, so comparing values would be a permanently red test.
 */

export type ShapeSignature = readonly string[];

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function walk(value: unknown, path: string, out: string[]): void {
  const t = typeOf(value);

  if (t === "array") {
    const arr = value as unknown[];
    // An empty array carries no element shape. Record it as `empty` rather than
    // guessing — every fixture brief comes from an empty in-memory index, so the
    // element type genuinely is not observable here, and pretending otherwise
    // would bake a false expectation into the snapshot.
    const first = arr[0];
    if (first === undefined) {
      out.push(`${path}[]:empty`);
      return;
    }
    walk(first, `${path}[]`, out);
    return;
  }

  if (t === "object") {
    const rec = value as Record<string, unknown>;
    for (const key of Object.keys(rec).sort()) {
      walk(rec[key], `${path}.${key}`, out);
    }
    return;
  }

  out.push(`${path}:${t}`);
}

/** Sorted `path:type` pairs describing a payload's structure, values discarded. */
export function briefShapeSignature(payload: unknown): ShapeSignature {
  const out: string[] = [];
  walk(payload, "", out);
  return out.sort();
}
