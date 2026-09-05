/**
 * `nimbus media allow-remote` and `nimbus media grants list|revoke` — the consent surface that
 * gates sending a user's photos to a third-party vision model (spec S2 multimodal PR 4, §§ 18-19).
 *
 * The gateway's three IPC methods (`media.allowRemote`, `media.grants.list`,
 * `media.grants.revoke` — `packages/gateway/src/ipc/media-rpc.ts`) are the source of truth for
 * their own wire shapes; this file never invents one. In particular `media.allowRemote` takes
 * `{ itemIds: string[], vendor: string }` and returns only `{ granted, alreadyGranted }` — no item
 * metadata comes back — so the enumerated, dual-ended PREVIEW this command shows before asking for
 * confirmation is built client-side, from the existing general-purpose `index.queryItems` read
 * surface (the same one `nimbus query` uses), never from a new or gateway-modified method.
 *
 * Argument parsing and rendering are pure and exported so they can be tested without a gateway,
 * matching `media-cmd.ts`'s own split.
 */
import type { IPCClient } from "../ipc-client/index.ts";
import { formatBytes } from "../lib/format-bytes.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/** A selector's mandatory cap (spec § 18.5): a `--limit` above this is refused, never clamped. */
export const MAX_GRANT_LIMIT = 500;

const DAY_MS = 86_400_000;

/**
 * Only Google Photos, Google Drive and OneDrive fetch cloud bytes (S2 multimodal PR 3,
 * `multimodal/cloud-bytes.ts`) — every other indexed service's media is local. This is the same
 * distinction `renderGrantPreview`'s "source local" vs "source <service>" line reports.
 */
const CLOUD_MEDIA_SERVICES: ReadonlySet<string> = new Set([
  "google_photos",
  "google_drive",
  "onedrive",
]);

export interface AllowRemoteArgs {
  readonly itemIds: readonly string[]; // explicit form
  readonly service?: string; // selector form
  readonly sinceDays?: number;
  readonly limit?: number; // MANDATORY in the selector form
}

export interface GrantPreviewItem {
  readonly itemId: string;
  readonly title: string;
  readonly sizeBytes: number | null;
  readonly modifiedAt: number;
  readonly service: string;
  readonly alreadyGranted: boolean;
}

/** Mirrors one entry of the gateway's `media.grants.list` response (`MediaGrantWithTitle`). */
export interface GrantListEntry {
  readonly itemId: string;
  readonly title: string | null;
  readonly modelVendor: string;
  readonly grantedAt: number;
}

export interface GrantsRevokeArgs {
  readonly itemId: string;
  readonly modelVendor?: string;
}

/**
 * Parses `nimbus media allow-remote`'s argv (with any `--vendor` already stripped by the caller —
 * vendor selection is a separate concern from WHICH items are being granted).
 *
 * Two mutually exclusive forms: explicit item ids as bare positional args, or a selector
 * (`--service` / `--since` / `--limit`). Mixing them is refused rather than resolved by
 * precedence, and a selector with no `--limit` is refused rather than defaulted — see
 * `MAX_GRANT_LIMIT`'s doc comment.
 */
export function parseAllowRemoteArgs(argv: readonly string[]): AllowRemoteArgs {
  const itemIds: string[] = [];
  let service: string | undefined;
  let sinceDays: number | undefined;
  let limit: number | undefined;
  let sawSelectorFlag = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--service") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("nimbus media allow-remote: --service requires a value");
      }
      service = value;
      sawSelectorFlag = true;
      i += 2;
      continue;
    }
    if (arg === "--since") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("nimbus media allow-remote: --since requires a value");
      }
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error("nimbus media allow-remote: --since must be a non-negative number of days");
      }
      sinceDays = n;
      sawSelectorFlag = true;
      i += 2;
      continue;
    }
    if (arg === "--limit") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("nimbus media allow-remote: --limit requires a value");
      }
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        throw new Error("nimbus media allow-remote: --limit must be a positive integer");
      }
      limit = n;
      sawSelectorFlag = true;
      i += 2;
      continue;
    }
    if (arg?.startsWith("--")) {
      throw new Error(`nimbus media allow-remote: unknown flag "${arg}"`);
    }
    if (arg !== undefined && arg.length > 0) {
      itemIds.push(arg);
    }
    i += 1;
  }

  if (itemIds.length > 0 && sawSelectorFlag) {
    throw new Error(
      "nimbus media allow-remote: cannot mix explicit item ids with a selector " +
        "(--service/--since/--limit)",
    );
  }

  if (itemIds.length > 0) {
    return { itemIds };
  }

  // An unbounded "grant everything" must not be EXPRESSIBLE (spec § 18.5): a missing --limit is
  // a REFUSAL, not a default -- a default would be a number the user never chose.
  if (limit === undefined) {
    throw new Error(
      "nimbus media allow-remote: --limit is required when using a selector " +
        "(--service/--since) instead of explicit item ids -- there is no default, since a " +
        "default would grant a number of items the user never chose",
    );
  }
  if (limit > MAX_GRANT_LIMIT) {
    throw new Error(`nimbus media allow-remote: --limit must be at most ${MAX_GRANT_LIMIT}`);
  }

  return {
    itemIds: [],
    ...(service === undefined ? {} : { service }),
    ...(sinceDays === undefined ? {} : { sinceDays }),
    limit,
  };
}

function sourceLabel(service: string): string {
  return CLOUD_MEDIA_SERVICES.has(service) ? service : "local";
}

/**
 * The enumerated, dual-ended consent preview (spec § 18.5/§ 19.6): every artifact by title (never
 * just a count), naming BOTH ends of the transfer (`source <service|local> · destination
 * <vendor>`), and separating newly-matched from already-granted so the count never silently folds
 * in a row this run did not write.
 */
export function renderGrantPreview(p: {
  readonly items: readonly GrantPreviewItem[];
  readonly vendor: string;
}): string {
  const lines: string[] = p.items.map((item) => {
    const size = item.sizeBytes === null ? "size unknown" : formatBytes(item.sizeBytes);
    const status = item.alreadyGranted ? "already granted" : "new";
    return (
      `  ${item.title} (${size}) — source ${sourceLabel(item.service)} · ` +
      `destination ${p.vendor} [${status}]`
    );
  });
  const alreadyGranted = p.items.filter((i) => i.alreadyGranted).length;
  const newCount = p.items.length - alreadyGranted;
  lines.push(
    `${p.items.length} artifact${p.items.length === 1 ? "" : "s"}: ${newCount} new, ` +
      `${alreadyGranted} already granted`,
  );
  return lines.join("\n");
}

/**
 * The confirmation prompt's question line: the destination vendor sits on the SAME line as the
 * question, so a user who scrolled past a 20-line enumeration still sees where the bytes go
 * before typing `y` (spec § 18.5).
 */
function confirmationPrompt(count: number, vendor: string): string {
  return (
    `Send ${count} artifact${count === 1 ? "" : "s"} to ${vendor}? ` +
    "This cannot be undone for bytes already sent. [y/N] "
  );
}

export function renderGrantList(grants: readonly GrantListEntry[]): string {
  if (grants.length === 0) {
    return "No active grants.";
  }
  return grants
    .map((g) => {
      const title = g.title ?? "(item no longer indexed)";
      const grantedAt = new Date(g.grantedAt).toISOString();
      return `  ${title} — ${g.modelVendor} (granted ${grantedAt}, item ${g.itemId})`;
    })
    .join("\n");
}

/**
 * `nimbus media grants revoke <itemId> [--vendor <name>]`. Refuses with no item id (§ 19.7: a
 * revocation always names its target — there is no "revoke everything").
 */
export function parseGrantsRevokeArgs(argv: readonly string[]): GrantsRevokeArgs {
  let itemId: string | undefined;
  let modelVendor: string | undefined;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--vendor") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("nimbus media grants revoke: --vendor requires a value");
      }
      modelVendor = value;
      i += 2;
      continue;
    }
    if (arg?.startsWith("--")) {
      throw new Error(`nimbus media grants revoke: unknown flag "${arg}"`);
    }
    if (itemId === undefined && arg !== undefined && arg.length > 0) {
      itemId = arg;
    }
    i += 1;
  }

  if (itemId === undefined) {
    throw new Error(
      "nimbus media grants revoke: an item id is required -- refusing to revoke every grant",
    );
  }
  return modelVendor === undefined ? { itemId } : { itemId, modelVendor };
}

// ---------------------------------------------------------------------------------------------
// Gateway-facing orchestration below. Only the pure functions above are unit-tested directly;
// this glue is exercised end to end by hand and through the gateway's own IPC tests
// (`media-rpc.test.ts` / `dispatchers.test.ts`), which pin the wire shapes this file consumes.
// ---------------------------------------------------------------------------------------------

/** Narrows an `unknown` IPC response to a keyed record, matching the gateway's own `asRecord`. */
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

interface CandidateRow {
  readonly itemId: string;
  readonly title: string;
  readonly sizeBytes: number | null;
  readonly modifiedAt: number;
  readonly service: string;
}

/**
 * `index.queryItems`'s items arrive as `Array<Record<string, unknown>>` (see `commands/query.ts`)
 * -- an indexed item's shape varies by connector/type, so every field is individually guarded
 * rather than cast. `indexPrimaryKey` (added by the gateway's `IndexedItem`) is the id
 * `media.allowRemote`/`media.grants.*` expect; `id` (the item's external id) is a fallback for a
 * row shape that omits it.
 */
function toCandidateRow(raw: unknown): CandidateRow | undefined {
  const r = asRecord(raw);
  const itemId =
    typeof r["indexPrimaryKey"] === "string"
      ? r["indexPrimaryKey"]
      : typeof r["id"] === "string"
        ? r["id"]
        : undefined;
  const title =
    typeof r["name"] === "string"
      ? r["name"]
      : typeof r["title"] === "string"
        ? r["title"]
        : undefined;
  const service = typeof r["service"] === "string" ? r["service"] : undefined;
  if (itemId === undefined || title === undefined || service === undefined) {
    return undefined;
  }
  const sizeBytes = typeof r["sizeBytes"] === "number" ? r["sizeBytes"] : null;
  const modifiedAt = typeof r["modifiedAt"] === "number" ? r["modifiedAt"] : 0;
  return { itemId, title, sizeBytes, modifiedAt, service };
}

async function fetchCandidatesViaQuery(
  c: IPCClient,
  opts: { readonly service?: string; readonly sinceMs?: number; readonly limit: number },
): Promise<CandidateRow[]> {
  const params: Record<string, unknown> = { limit: opts.limit };
  if (opts.service !== undefined) params["services"] = [opts.service];
  if (opts.sinceMs !== undefined) params["sinceMs"] = opts.sinceMs;
  const res = await c.call<unknown>("index.queryItems", params);
  const rawItems = asRecord(res)["items"];
  if (!Array.isArray(rawItems)) return [];
  const rows: CandidateRow[] = [];
  for (const raw of rawItems) {
    const row = toCandidateRow(raw);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

/**
 * Resolves the candidate set for either form of `AllowRemoteArgs`.
 *
 * The explicit form names ids the gateway has no by-id lookup for over IPC, so the ids are
 * matched against a broad recent scan; an id the scan does not surface still appears in the
 * preview (title falls back to the bare id) rather than being silently dropped from what the
 * owner is about to approve.
 */
async function resolveGrantCandidates(
  c: IPCClient,
  parsed: AllowRemoteArgs,
): Promise<CandidateRow[]> {
  if (parsed.itemIds.length > 0) {
    const scanned = await fetchCandidatesViaQuery(c, { limit: 1000 });
    const byId = new Map(scanned.map((r) => [r.itemId, r]));
    return parsed.itemIds.map(
      (itemId) =>
        byId.get(itemId) ?? {
          itemId,
          title: itemId,
          sizeBytes: null,
          modifiedAt: 0,
          service: "unknown",
        },
    );
  }
  return fetchCandidatesViaQuery(c, {
    ...(parsed.service === undefined ? {} : { service: parsed.service }),
    ...(parsed.sinceDays === undefined ? {} : { sinceMs: Date.now() - parsed.sinceDays * DAY_MS }),
    limit: parsed.limit ?? MAX_GRANT_LIMIT,
  });
}

function toGrantListEntry(raw: unknown): GrantListEntry | undefined {
  const r = asRecord(raw);
  const itemId = typeof r["itemId"] === "string" ? r["itemId"] : undefined;
  const modelVendor = typeof r["modelVendor"] === "string" ? r["modelVendor"] : undefined;
  const grantedAt = typeof r["grantedAt"] === "number" ? r["grantedAt"] : undefined;
  if (itemId === undefined || modelVendor === undefined || grantedAt === undefined) {
    return undefined;
  }
  const title = typeof r["title"] === "string" ? r["title"] : null;
  return { itemId, title, modelVendor, grantedAt };
}

/** `media.grants.list()` -> `{ grants: MediaGrantWithTitle[] }` (`ipc/media-rpc.ts`). */
async function fetchGrantList(c: IPCClient): Promise<GrantListEntry[]> {
  const res = await c.call<unknown>("media.grants.list", {});
  const rawGrants = asRecord(res)["grants"];
  if (!Array.isArray(rawGrants)) return [];
  const out: GrantListEntry[] = [];
  for (const raw of rawGrants) {
    const entry = toGrantListEntry(raw);
    if (entry !== undefined) out.push(entry);
  }
  return out;
}

async function fetchAlreadyGrantedItemIds(c: IPCClient, vendor: string): Promise<Set<string>> {
  const grants = await fetchGrantList(c);
  return new Set(grants.filter((g) => g.modelVendor === vendor).map((g) => g.itemId));
}

function extractVendorFlag(argv: readonly string[]): { vendor: string; rest: string[] } {
  const rest: string[] = [];
  let vendor: string | undefined;
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--vendor") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error("nimbus media allow-remote: --vendor requires a value");
      }
      vendor = value;
      i += 2;
      continue;
    }
    if (arg !== undefined) rest.push(arg);
    i += 1;
  }
  if (vendor === undefined) {
    throw new Error(
      "nimbus media allow-remote: --vendor <name> is required -- naming the destination is the " +
        "whole point of a remote-understanding grant",
    );
  }
  return { vendor, rest };
}

/** Reads one line from stdin, matching `commands/update.ts`'s non-interactive-safe shape. */
async function readAnswer(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY !== true) {
      resolve("");
      return;
    }
    const chunk = process.stdin.read();
    if (chunk === null) {
      process.stdin.once("data", (data) => {
        resolve((data as Buffer).toString("utf8"));
      });
    } else {
      resolve(chunk.toString("utf8"));
    }
  });
}

export async function runAllowRemoteCmd(argv: string[]): Promise<void> {
  const { vendor, rest } = extractVendorFlag(argv);
  const parsed = parseAllowRemoteArgs(rest);

  await withGatewayIpc(async (c) => {
    const [candidates, alreadyGrantedIds] = await Promise.all([
      resolveGrantCandidates(c, parsed),
      fetchAlreadyGrantedItemIds(c, vendor),
    ]);

    if (candidates.length === 0) {
      console.log("No matching artifacts found — nothing to grant.");
      return;
    }

    const items: GrantPreviewItem[] = candidates.map((row) => ({
      itemId: row.itemId,
      title: row.title,
      sizeBytes: row.sizeBytes,
      modifiedAt: row.modifiedAt,
      service: row.service,
      alreadyGranted: alreadyGrantedIds.has(row.itemId),
    }));

    console.log(renderGrantPreview({ items, vendor }));

    if (process.stdin.isTTY !== true) {
      throw new Error(
        "nimbus media allow-remote: refusing to grant without confirmation in non-TTY mode",
      );
    }
    process.stdout.write(confirmationPrompt(items.length, vendor));
    const answer = await readAnswer();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Aborted.");
      return;
    }

    const result = await c.call<{ granted: number; alreadyGranted: number }>("media.allowRemote", {
      itemIds: items.map((i) => i.itemId),
      vendor,
    });
    console.log(`Granted ${result.granted} new, ${result.alreadyGranted} already granted.`);
  });
}

async function runGrantsListCmd(): Promise<void> {
  await withGatewayIpc(async (c) => {
    const grants = await fetchGrantList(c);
    console.log(renderGrantList(grants));
  });
}

async function runGrantsRevokeCmd(argv: string[]): Promise<void> {
  const parsed = parseGrantsRevokeArgs(argv);
  await withGatewayIpc(async (c) => {
    const result = await c.call<{ revoked: number }>("media.grants.revoke", {
      itemId: parsed.itemId,
      ...(parsed.modelVendor === undefined ? {} : { modelVendor: parsed.modelVendor }),
    });
    console.log(`Revoked ${result.revoked} grant${result.revoked === 1 ? "" : "s"}.`);
  });
}

export async function runGrantsCmd(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "list") {
    await runGrantsListCmd();
    return;
  }
  if (sub === "revoke") {
    await runGrantsRevokeCmd(argv.slice(1));
    return;
  }
  throw new Error(
    `nimbus media grants: unknown subcommand "${sub ?? ""}" (expected "list" or "revoke")`,
  );
}
