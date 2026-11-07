// packages/gateway/src/connectors/connector-writes/prepare-tools.ts
// The third tool class beside reads and writes (Phase 9.7 D0b, I54): a PREPARE tool is a read-like
// connector call whose reply a bound write depends on (a plan, a change set, a file's digest). It
// runs only inside the executor's prepare step (`engine/prepare-step.ts`), under a
// `<service>.write.prepare` action type, never as a model tool and never as a write.
//
// EMPTY in D0b: no real row declares `bound` yet. The real ids arrive with the rows that need them
// (D-X, D1c, D2, D3), each with a test that it is registered, not a read verb and not a write id.
// Tests exercise the mechanism with synthetic ids through the executor's and the dispatcher's
// constructor seams, which static rule D42(c) forbids production code to use.
const PREPARE_TOOL_ID_BACKING: ReadonlySet<string> = new Set<string>([]);

/** Frozen: `add`, `delete` and `clear` throw, so the production set cannot grow at runtime (D42(d)). */
export const PREPARE_TOOL_IDS: ReadonlySet<string> = Object.freeze({
  has(id: string): boolean {
    return PREPARE_TOOL_ID_BACKING.has(id);
  },
  get size(): number {
    return PREPARE_TOOL_ID_BACKING.size;
  },
  *[Symbol.iterator](): IterableIterator<string> {
    yield* PREPARE_TOOL_ID_BACKING;
  },
  entries(): IterableIterator<[string, string]> {
    return PREPARE_TOOL_ID_BACKING.entries();
  },
  keys(): IterableIterator<string> {
    return PREPARE_TOOL_ID_BACKING.keys();
  },
  values(): IterableIterator<string> {
    return PREPARE_TOOL_ID_BACKING.values();
  },
  forEach(
    callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ): void {
    for (const v of PREPARE_TOOL_ID_BACKING) {
      callbackfn.call(thisArg, v, v, PREPARE_TOOL_IDS);
    }
  },
  add(_id: string): never {
    throw new TypeError("PREPARE_TOOL_IDS is immutable; edit PREPARE_TOOL_ID_BACKING instead");
  },
  delete(_id: string): never {
    throw new TypeError("PREPARE_TOOL_IDS is immutable; edit PREPARE_TOOL_ID_BACKING instead");
  },
  clear(): never {
    throw new TypeError("PREPARE_TOOL_IDS is immutable; edit PREPARE_TOOL_ID_BACKING instead");
  },
}) as unknown as ReadonlySet<string>;

/** Whether `id` (bare, or the tail of a `<service>_<tool>` key) is a declared prepare tool. */
export function isPrepareToolId(id: string, ids: ReadonlySet<string> = PREPARE_TOOL_IDS): boolean {
  if (ids.has(id)) return true;
  for (const known of ids) {
    if (id.endsWith(`_${known}`)) return true;
  }
  return false;
}
