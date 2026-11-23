// packages/gateway/src/connectors/connector-writes/remote-content/notion.ts
// Part of the remote-content detectors; see `../remote-content.ts` for the rules and the entry point.

// ---------------------------------------------------------------------------------------------
// R8: Notion block and property JSON. `JSON.parse`, then an iterative walk with an explicit stack
// over every array element and every own enumerable key (`Object.entries`, so a JSON `__proto__`
// key is visited). Keys are compared lower-cased. Duplicate keys are not a gap: both Notion tools
// `JSON.parse` then `JSON.stringify` before sending, so Notion receives exactly what was walked
// (pinned against the connector source in Task 5).
// ---------------------------------------------------------------------------------------------

/** Containers nested deeper than this are refused (Notion itself takes two levels of children). */
const NOTION_SCAN_MAX_DEPTH = 64;
/** More values than this are refused. */
const NOTION_SCAN_MAX_NODES = 100_000;

/** (a) and (b): an own key that loads or unfurls an external URL, whatever its value. */
const NOTION_REFUSED_KEYS: ReadonlySet<string> = new Set([
  "external",
  "embed",
  "bookmark",
  "link_preview",
  "link_mention",
]);
/** (c): a media key whose value is an object with its own `url`. */
const NOTION_MEDIA_KEYS: ReadonlySet<string> = new Set([
  "image",
  "video",
  "audio",
  "pdf",
  "file",
  "custom_emoji",
]);
/** (d): an own `type` naming one of these. */
const NOTION_REFUSED_TYPES: ReadonlySet<string> = new Set([
  "external",
  "embed",
  "bookmark",
  "link_preview",
  "link_mention",
]);

function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasOwnUrl(v: unknown): boolean {
  return isPlainObject(v) && Object.keys(v).some((k) => k.toLowerCase() === "url");
}

/** R8 (a)-(d) on one plain object's own keys. */
function notionObjectRefused(obj: Readonly<Record<string, unknown>>): boolean {
  return Object.entries(obj).some(([key, value]) => {
    const k = key.toLowerCase();
    if (NOTION_REFUSED_KEYS.has(k)) return true;
    if (NOTION_MEDIA_KEYS.has(k) && hasOwnUrl(value)) return true;
    return (
      k === "type" && typeof value === "string" && NOTION_REFUSED_TYPES.has(value.toLowerCase())
    );
  });
}

/** The children to walk of an array or plain object node; `undefined` when the object is refused. */
function notionChildrenOf(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value) || notionObjectRefused(value)) return undefined;
  return Object.values(value);
}

/** R8: Notion `childrenJson` (an array) or `propertiesJson` (a plain object). */
export function notionRemote(text: string, shape: "blocks" | "properties"): boolean {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return true;
  }
  if (shape === "blocks" ? !Array.isArray(root) : !isPlainObject(root)) return true;
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: root, depth: 1 }];
  let nodes = 0;
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    nodes++;
    if (nodes > NOTION_SCAN_MAX_NODES) return true;
    const { value, depth } = top;
    if (!Array.isArray(value) && !isPlainObject(value)) continue;
    const children = notionChildrenOf(value);
    if (children === undefined) return true;
    if (depth > NOTION_SCAN_MAX_DEPTH) return true;
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
  return false;
}
