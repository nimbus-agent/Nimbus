/**
 * Local `$ref` resolution for an UNTRUSTED OpenAPI document. Only `#/…` JSON pointers are followed
 * (RFC 6901 `~1` → `/`, `~0` → `~`), only through own properties, and never through `__proto__`,
 * `constructor` or `prototype`. Every object this builds is null-prototype, so a document key such
 * as `__proto__` lands as plain data. A `$ref` chain deeper than {@link MAX_REF_DEPTH} (a cycle) is
 * cut to `{}` and reported once per cut; structural nesting and total size are bounded so a hostile
 * document gives a message, never a stack overflow or an unbounded expansion.
 */

export class OpenApiModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenApiModelError";
  }
}

export const MAX_REF_DEPTH = 8;
export const MAX_NESTING = 256;
export const MAX_RESOLVED_NODES = 100_000;

const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export type Obj = Record<string, unknown>;

/** A non-null, non-array object. */
export function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `o[key]` only when `key` is an OWN property, so nothing is read through the prototype chain. */
export function own(o: unknown, key: string): unknown {
  if (o === null || typeof o !== "object") return undefined;
  return Object.hasOwn(o, key) ? (o as Obj)[key] : undefined;
}

/** A fresh null-prototype object. */
export function emptyObject(): Obj {
  return Object.create(null) as Obj;
}

/** A node budget; pass one object to several calls to share it. */
export interface RefBudget {
  used: number;
  readonly limit: number;
}

interface WalkContext {
  readonly root: Obj;
  readonly onCut: ((ref: string) => void) | undefined;
  readonly onProtoKey: (() => void) | undefined;
  readonly budget: RefBudget;
}

/**
 * A key the output never carries. It is plain data in a null-prototype object, but a bundled
 * build inlines operations.json as an object literal, where `"__proto__": …` sets the prototype
 * instead of a property — the key would silently vanish.
 */
const PROTO_KEY = "__proto__";

const formatCount = new Intl.NumberFormat("en-US");

function unescapeSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function decodeSegment(raw: string, ref: string): string {
  try {
    return unescapeSegment(decodeURIComponent(raw));
  } catch {
    throw new OpenApiModelError(`$ref ${ref} has a malformed percent-escape`);
  }
}

function lookupPointer(ref: string, root: Obj): unknown {
  if (!ref.startsWith("#")) {
    throw new OpenApiModelError(`external $ref is not supported: ${ref}`);
  }
  const pointer = ref.slice(1);
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) {
    throw new OpenApiModelError(`$ref ${ref} is not a JSON pointer`);
  }
  let node: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = decodeSegment(raw, ref);
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new OpenApiModelError(`$ref ${ref} uses the forbidden segment "${segment}"`);
    }
    if (node === null || typeof node !== "object" || !Object.hasOwn(node, segment)) {
      throw new OpenApiModelError(`$ref ${ref} points at nothing in the document`);
    }
    node = (node as Obj)[segment];
  }
  return node;
}

/** Characters of a string that count as one node, so a `$ref`'d long string is not free. */
export const CHARS_PER_NODE = 64;

function countNode(ctx: WalkContext, nodes = 1): void {
  ctx.budget.used += nodes;
  if (ctx.budget.used > ctx.budget.limit) {
    throw new OpenApiModelError(
      `the document expands to more than ${formatCount.format(ctx.budget.limit)} schema nodes`,
    );
  }
}

function walk(node: unknown, ctx: WalkContext, refDepth: number, nesting: number): unknown {
  if (node === null || typeof node !== "object") {
    // Every value the walk returns lands in the output once per reference to it, so a long
    // string referenced many times costs what it will cost to write.
    countNode(ctx, typeof node === "string" ? Math.ceil(node.length / CHARS_PER_NODE) : 1);
    return node;
  }
  if (nesting > MAX_NESTING) {
    throw new OpenApiModelError(`the document nests more than ${MAX_NESTING} levels deep`);
  }
  countNode(ctx);
  if (Array.isArray(node)) {
    return node.map((item: unknown) => walk(item, ctx, refDepth, nesting + 1));
  }
  const ref = own(node, "$ref");
  if (typeof ref === "string") {
    if (refDepth >= MAX_REF_DEPTH) {
      ctx.onCut?.(ref);
      return emptyObject();
    }
    return walk(lookupPointer(ref, ctx.root), ctx, refDepth + 1, nesting + 1);
  }
  const out = emptyObject();
  for (const key of Object.keys(node)) {
    if (key === PROTO_KEY) {
      ctx.onProtoKey?.();
      continue;
    }
    // A key's first CHARS_PER_NODE characters ride on its value's charge; the rest are counted.
    countNode(ctx, Math.max(0, Math.ceil(key.length / CHARS_PER_NODE) - 1));
    out[key] = walk((node as Obj)[key], ctx, refDepth, nesting + 1);
  }
  return out;
}

/**
 * A deep, null-prototype copy of `node` with every local `$ref` replaced by its target. `depth` is
 * the number of `$ref`s already followed (0 at the top); `onCut` is called once per cut; `budget`
 * (default: {@link MAX_RESOLVED_NODES} for this call alone) bounds the nodes built; `onProtoKey`
 * is called for each `__proto__` key dropped.
 */
export function resolveRefs(
  node: unknown,
  root: Record<string, unknown>,
  depth = 0,
  onCut?: (ref: string) => void,
  budget?: RefBudget,
  onProtoKey?: () => void,
): unknown {
  const ownBudget = budget ?? { used: 0, limit: MAX_RESOLVED_NODES };
  return walk(node, { root, onCut, onProtoKey, budget: ownBudget }, depth, 0);
}
