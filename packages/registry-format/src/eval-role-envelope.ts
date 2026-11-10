/**
 * The shared outer shape of every `__nimbus-eval` role document (the evaluation report and the
 * baseline both use it): `{ ok: false, error: { code, message } }` or `{ ok: true, extensionId,
 * version, ...payload }`. This reads only the envelope; the caller validates its own payload.
 * Pure: no Bun, no gateway imports.
 */
export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type EvalRoleEnvelope =
  | { kind: "error"; error: { code: string; message: string } }
  | { kind: "ok"; extensionId: string; version: string; raw: Record<string, unknown> };

/** The envelope of the role's JSON document; null when it is neither of the two shapes. */
export function parseEvalRoleEnvelope(text: string): EvalRoleEnvelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(raw)) return null;
  if (raw["ok"] === false) {
    const e = raw["error"];
    if (isObject(e) && typeof e["code"] === "string" && typeof e["message"] === "string") {
      return { kind: "error", error: { code: e["code"], message: e["message"] } };
    }
    return null;
  }
  if (raw["ok"] !== true) return null;
  const { extensionId, version } = raw;
  if (typeof extensionId !== "string" || typeof version !== "string") return null;
  return { kind: "ok", extensionId, version, raw };
}
