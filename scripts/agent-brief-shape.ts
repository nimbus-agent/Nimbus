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
    // guessing — every fixture brief currently comes from an empty in-memory
    // index, so the element type genuinely is not observable, and pretending
    // otherwise would bake a false expectation into the snapshot.
    if (arr.length === 0) {
      out.push(`${path}[]:empty`);
      return;
    }
    // EVERY element, not just index 0. Sampling the first would make the gate
    // blind to a field added or renamed on any later element — the same
    // one-level-deep blindness this exists to compensate for in the client's
    // conformance gate. Tokens are de-duplicated in briefShapeSignature, so
    // homogeneous arrays still produce one entry per path.
    for (const el of arr) {
      walk(el, `${path}[]`, out);
    }
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

/**
 * Sorted, de-duplicated `path:type` pairs describing a payload's structure,
 * values discarded.
 *
 * De-duplication is what makes walking every array element affordable: a
 * 500-entry homogeneous array collapses to one token per path, while a single
 * odd element out still shows up as an extra token.
 */
export function briefShapeSignature(payload: unknown): ShapeSignature {
  const out: string[] = [];
  walk(payload, "", out);
  return [...new Set(out)].sort();
}
