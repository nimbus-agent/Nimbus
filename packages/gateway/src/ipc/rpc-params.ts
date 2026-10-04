import { asRecord } from "../connectors/unknown-record.ts";

/**
 * Parameter validators shared by the `ipc/*-rpc.ts` dispatchers.
 *
 * They replace a `requireString` that eleven modules each defined for themselves. Those copies
 * were FOUR rules, not one: they disagree on what passes (is `""` a string? is `"  "`? is the value
 * trimmed?) and on the message, and every message is already on the wire, with tests pinning
 * several. So there is one helper per rule rather than one helper with flags, and each reproduces
 * its rule's message byte for byte:
 *
 * - `requireNonEmptyStringParam` — `""` rejected, value returned as given:
 *   `ERR_INVALID_PARAMS: <key> (non-empty string) required`.
 * - `requireNonEmptyStringField` — the same rule, worded for a caller that has already narrowed
 *   `params` to a record: `ERR_INVALID_PARAMS: <key> must be a non-empty string`.
 * - `requireTrimmedStringField` — whitespace-only rejected too, value returned TRIMMED:
 *   `Missing or invalid <key>`.
 * - `requireStringParam` — `""` ACCEPTED, and a plain `Error`:
 *   `ERR_INVALID_PARAMS: <key> (string) required`.
 *
 * `policy-rpc.ts` keeps its own copy on purpose: it rejects `""` yet words the refusal
 * `(string) required`, which is a fifth combination, not one of these four.
 *
 * The error CLASS stays the calling module's. Each `*-rpc.ts` module defines its own `XRpcError`,
 * and `ipc/server/dispatchers.ts` turns a thrown error into a JSON-RPC error response by testing
 * `instanceof XRpcError` — a shared class would fall through those checks. So the first three
 * helpers take the module's constructor and throw an instance of it, with code `-32602`;
 * `requireStringParam` throws a plain `Error` because both of its callers always have.
 */

/** The constructor every `ipc/*-rpc.ts` error class shares: `new XRpcError(rpcCode, message)`. */
export type RpcErrorConstructor = new (rpcCode: number, message: string) => Error;

/** JSON-RPC 2.0 "Invalid params". */
const INVALID_PARAMS = -32602;

/**
 * `params[key]` as a non-empty string. A `params` that is not a plain object — `null`, an array, a
 * primitive — reads as a missing key, and so refuses the same way.
 */
export function requireNonEmptyStringParam(
  params: unknown,
  key: string,
  ErrorClass: RpcErrorConstructor,
): string {
  const rec = asRecord(params);
  const v = rec === undefined ? undefined : rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ErrorClass(INVALID_PARAMS, `ERR_INVALID_PARAMS: ${key} (non-empty string) required`);
  }
  return v;
}

/**
 * `rec[key]` as a non-empty string, for a module that narrows `params` to a record itself first
 * (`federation-rpc.ts` and `identity-rpc.ts`, each refusing a non-object in its own words).
 */
export function requireNonEmptyStringField(
  rec: Readonly<Record<string, unknown>>,
  key: string,
  ErrorClass: RpcErrorConstructor,
): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ErrorClass(INVALID_PARAMS, `ERR_INVALID_PARAMS: ${key} must be a non-empty string`);
  }
  return v;
}

/**
 * `rec[key]`, TRIMMED, when it is a string with something other than whitespace in it. An absent
 * `rec` (the caller's `asRecord` found no object) refuses with the same message as a bad value.
 */
export function requireTrimmedStringField(
  rec: Readonly<Record<string, unknown>> | undefined,
  key: string,
  ErrorClass: RpcErrorConstructor,
): string {
  const v = rec === undefined ? undefined : rec[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ErrorClass(INVALID_PARAMS, `Missing or invalid ${key}`);
  }
  return v.trim();
}

/**
 * `params[key]` as a string — the EMPTY string included. A `params` that is not an object reads as
 * a missing key. Throws a plain `Error`, not a coded one: see this module's doc comment.
 */
export function requireStringParam(params: unknown, key: string): string {
  const rec = params as Record<string, unknown> | null;
  const v = rec === null || typeof rec !== "object" ? undefined : rec[key];
  if (typeof v !== "string") throw new Error(`ERR_INVALID_PARAMS: ${key} (string) required`);
  return v;
}

/**
 * `v` as a string list, ALL OR NOTHING: a non-array, or an array with any non-string element,
 * yields an EMPTY list — never a partial one. Its callers parse grant, origin and host lists, where
 * silently dropping the bad element would hand a gate a set the caller never asked for; an empty
 * list grants nothing. Returns a copy, so the caller's array is never aliased into a request.
 */
export function stringArrayAllOrNothing(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.every((e) => typeof e === "string") ? [...(v as string[])] : [];
}
