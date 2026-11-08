// packages/gateway/src/connectors/connector-writes/prepare-tools.ts
// The third tool class beside reads and writes (Phase 9.7 D0b, I54): a PREPARE tool is a read-like
// connector call whose reply a bound write depends on (a plan, a change set, a file's digest). It
// runs only inside the executor's prepare step (`engine/prepare-step.ts`), under a
// `<service>.write.prepare` action type, never as a model tool and never as a write.
//
// Two ids since D1c: the GitHub and GitLab multi-file commit prepare tools (connectors 0.8, the
// connector's own `shared/prepare-tool-ids.ts` lists exactly these; a test pins the two lists equal,
// so a third prepare tool fails the gateway until a row classifies it). Each later id arrives with
// the row that needs it (D2, D3), with a test that it is registered, not a read verb and not a
// write id. Tests exercise the mechanism with synthetic ids through the executor's and the
// dispatcher's constructor seams, which static rule D42(c) forbids production code to use.
const PREPARE_TOOL_ID_BACKING: ReadonlySet<string> = new Set<string>([
  "github_commit_prepare",
  "gitlab_commit_prepare",
]);

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
