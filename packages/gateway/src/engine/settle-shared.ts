// packages/gateway/src/engine/settle-shared.ts
// The small reply-reading helpers both bound-write settlers share (`iac-settle.ts`, `k8s-settle.ts`;
// invariant I54). Pure: no I/O, no capability, nothing that settles a plan on its own.
import { PrepareRefusedError } from "./prepare-step.ts";

/** A settle refusal with its fixed reason (`PREPARE_REFUSALS`). */
export function refuse(reason: string): PrepareRefusedError {
  return new PrepareRefusedError(reason);
}

/** A plain object (prototype `Object.prototype` or null), never an array or a class instance. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** An OWN member of `o`, never an inherited one. */
export function field(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}
