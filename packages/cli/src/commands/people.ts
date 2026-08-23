import {
  formatBatchCaveat,
  formatGapLine,
  isMissingSubstrateRefusal,
  type MissingSubstrateRefusal,
  type NegationExplain,
  printExplainBlock,
  printRefusal,
} from "../lib/negation-output.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

type PersonJson = {
  id: string;
  displayName: string | null;
  canonicalEmail: string | null;
  githubLogin: string | null;
  gitlabLogin: string | null;
  slackHandle: string | null;
  linearMemberId: string | null;
  jiraAccountId: string | null;
  notionUserId: string | null;
  linked: boolean;
  itemCount?: number;
};

function printPerson(p: PersonJson): void {
  const handles = [
    p.githubLogin !== null && p.githubLogin !== "" ? `github=${p.githubLogin}` : "",
    p.gitlabLogin !== null && p.gitlabLogin !== "" ? `gitlab=${p.gitlabLogin}` : "",
    p.slackHandle !== null && p.slackHandle !== "" ? `slack=${p.slackHandle}` : "",
    p.linearMemberId !== null && p.linearMemberId !== "" ? `linear=${p.linearMemberId}` : "",
    p.jiraAccountId !== null && p.jiraAccountId !== "" ? `jira=${p.jiraAccountId}` : "",
    p.notionUserId !== null && p.notionUserId !== "" ? `notion=${p.notionUserId}` : "",
  ].filter((s) => s !== "");
  const link = p.linked ? "linked" : "unlinked";
  const email = p.canonicalEmail ?? "—";
  const name = p.displayName ?? "—";
  const items = typeof p.itemCount === "number" ? ` items=${String(p.itemCount)}` : "";
  console.log(`${p.id}  ${link}  ${name}  ${email}${items}`);
  if (handles.length > 0) {
    console.log(`   ${handles.join("  ")}`);
  }
}

function printPeopleHelp(): void {
  console.log(`nimbus people — local cross-service people graph

Usage:
  nimbus people list [--unlinked] [--limit N] [--not-reviewed [--since 7d]] [--explain] [--json]
  nimbus people search <query> [--limit N]
  nimbus people get <id>
  nimbus people items <id> [--limit N]
  nimbus people link <id-a> <id-b>   Merge id-b into id-a (id-a survives)
  nimbus people help
`);
}

interface ListFlags {
  readonly unlinkedOnly: boolean;
  readonly limit: number;
  readonly notReviewed: boolean;
  readonly sinceRaw: string | undefined;
  readonly explain: boolean;
  readonly wantJson: boolean;
}

function parseListFlags(args: string[]): ListFlags {
  let unlinkedOnly = false;
  let limit = 100;
  let notReviewed = false;
  let sinceRaw: string | undefined;
  let explain = false;
  let wantJson = false;
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--unlinked") {
      unlinkedOnly = true;
    } else if (a === "--limit") {
      const limStr = args[i + 1];
      if (limStr !== undefined) {
        limit = Number.parseInt(limStr, 10);
        i += 1;
      }
    } else if (a === "--not-reviewed") {
      notReviewed = true;
    } else if (a === "--since") {
      const sinceStr = args[i + 1];
      // A SUPPLIED --since must never become an OMITTED window. Silently ignoring a valueless
      // `--since` falls back to the all-time predicate (`sinceMs` defaults to 0 gateway-side),
      // which answers a WIDER question than the caller asked and reports no gap saying so. A
      // malformed value (`--since --json`) is already rejected by `parseSinceDurationToMs`; this
      // closes the missing-value case it never sees.
      if (sinceStr === undefined) {
        throw new Error("--since requires a duration (examples: 7d, 24h, 30m)");
      }
      sinceRaw = sinceStr;
      i += 1; // also consume its value argument, e.g. "7d"
    } else if (a === "--explain") {
      explain = true;
    } else if (a === "--json") {
      wantJson = true;
    }
  }
  return { unlinkedOnly, limit, notReviewed, sinceRaw, explain, wantJson };
}

function parseLimitOnly(args: string[], startIndex: number, defaultLimit: number): number {
  let limit = defaultLimit;
  for (let i = startIndex; i < args.length; i += 1) {
    if (args[i] === "--limit") {
      const limStr = args[i + 1];
      if (limStr !== undefined) {
        limit = Number.parseInt(limStr, 10);
        i += 1;
      }
    }
  }
  return limit;
}

type PeopleListGaps = { readonly excludedNoGraphEntity: number };

type PeopleListDoc = {
  readonly people: PersonJson[];
  readonly meta?: { readonly limit: number; readonly total: number };
  readonly gaps?: PeopleListGaps;
  readonly explain?: NegationExplain;
};

// `people.list` has THREE response shapes (verified against `rpcPeopleList`,
// `ipc/people-rpc.ts`): a bare array on a plain call, `{ people, gaps?, meta?, explain? }` on
// a `--not-reviewed` or `--explain` call, or the refusal document. All three must be handled —
// treating the array as the only shape would mean a negation call's `gaps`/`explain` never
// render.
type PeopleListResult = PersonJson[] | PeopleListDoc | MissingSubstrateRefusal;

interface PeopleListParams {
  unlinkedOnly: boolean;
  limit: number;
  notReviewed?: boolean;
  sinceMs?: number;
  explain?: boolean;
}

/** Omit the optionals rather than sending them undefined, so they don't appear in the request. */
function buildListParams(f: {
  unlinkedOnly: boolean;
  limit: number;
  notReviewed: boolean;
  sinceMs: number | undefined;
  explain: boolean;
}): PeopleListParams {
  const params: PeopleListParams = { unlinkedOnly: f.unlinkedOnly, limit: f.limit };
  if (f.notReviewed) {
    params.notReviewed = true;
  }
  if (f.sinceMs !== undefined) {
    params.sinceMs = f.sinceMs;
  }
  if (f.explain) {
    params.explain = true;
  }
  return params;
}

/**
 * `--not-reviewed` is WINDOWED (spec § 4.4): with no `--since` the window is ALL TIME
 * ("has not reviewed EVER"), never a silently-narrowed recent window. That must be visible
 * in what is printed, not just true of what was asked for — otherwise a caller reading the
 * output has no way to tell an all-time answer from a recent one.
 *
 * Extracted from a nested ternary (S3358); the three outcomes now read top to bottom.
 */
function windowLineFor(notReviewed: boolean, sinceRaw: string | undefined): string | undefined {
  if (!notReviewed) {
    return undefined;
  }
  if (sinceRaw !== undefined) {
    return `Window: reviews since --since ${sinceRaw}`;
  }
  return 'Window: ALL TIME — no --since given, so this reports "never reviewed, ever", not a recent window';
}

function printListJson(
  r: PersonJson[] | PeopleListDoc,
  notReviewed: boolean,
  sinceRaw: string | undefined,
  sinceMs: number | undefined,
): void {
  if (Array.isArray(r)) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }
  const doc: Record<string, unknown> = { ...r };
  if (notReviewed) {
    doc["window"] = { sinceMs: sinceMs ?? 0, allTime: sinceRaw === undefined };
  }
  console.log(JSON.stringify(doc, null, 2));
}

function printListText(r: PersonJson[] | PeopleListDoc, windowLine: string | undefined): void {
  const people = Array.isArray(r) ? r : r.people;
  const gaps = Array.isArray(r) ? undefined : r.gaps;
  const meta = Array.isArray(r) ? undefined : r.meta;
  const explainBlock = Array.isArray(r) ? undefined : r.explain;

  for (const p of people) {
    printPerson(p);
  }
  if (windowLine !== undefined) {
    console.log(windowLine);
  }
  if (gaps !== undefined) {
    console.log(formatGapLine(gaps));
    if (meta !== undefined) {
      console.log(formatBatchCaveat(meta));
    }
  }
  if (explainBlock !== undefined) {
    printExplainBlock(explainBlock);
  }
}

async function runPeopleList(args: string[]): Promise<void> {
  const { unlinkedOnly, limit, notReviewed, sinceRaw, explain, wantJson } = parseListFlags(args);

  const sinceMs =
    sinceRaw === undefined ? undefined : Date.now() - parseSinceDurationToMs(sinceRaw);

  const params = buildListParams({ unlinkedOnly, limit, notReviewed, sinceMs, explain });
  const r = await withGatewayIpc((c) => c.call<PeopleListResult>("people.list", params));

  if (isMissingSubstrateRefusal(r)) {
    printRefusal(r, wantJson);
    process.exitCode = 1;
    return;
  }

  if (wantJson) {
    printListJson(r, notReviewed, sinceRaw, sinceMs);
    return;
  }
  printListText(r, windowLineFor(notReviewed, sinceRaw));
}

async function runPeopleSearch(args: string[]): Promise<void> {
  const q = args[1];
  if (q === undefined || q === "") {
    throw new Error("Usage: nimbus people search <query> [--limit N]");
  }
  const limit = parseLimitOnly(args, 2, 25);
  const rows = await withGatewayIpc((c) =>
    c.call<PersonJson[]>("people.search", { query: q, limit }),
  );
  for (const p of rows) {
    printPerson(p);
  }
}

async function runPeopleGet(args: string[]): Promise<void> {
  const id = args[1];
  if (id === undefined || id === "") {
    throw new Error("Usage: nimbus people get <id>");
  }
  const p = await withGatewayIpc((c) => c.call<PersonJson | null>("people.get", { id }));
  if (p === null) {
    console.log("(not found)");
    return;
  }
  printPerson(p);
}

async function runPeopleItems(args: string[]): Promise<void> {
  const id = args[1];
  if (id === undefined || id === "") {
    throw new Error("Usage: nimbus people items <id> [--limit N]");
  }
  const limit = parseLimitOnly(args, 2, 50);
  const items = await withGatewayIpc((c) =>
    c.call<Array<{ id: string; service: string; name: string }>>("people.items", {
      personId: id,
      limit,
    }),
  );
  for (const it of items) {
    console.log(`${it.service}\t${it.id}\t${it.name}`);
  }
}

async function runPeopleLink(args: string[]): Promise<void> {
  const a = args[1];
  const b = args[2];
  if (a === undefined || b === undefined || a === "" || b === "") {
    throw new Error("Usage: nimbus people link <id-a> <id-b>");
  }
  const out = await withGatewayIpc((c) =>
    c.call<{ survivorId: string; person: PersonJson }>("people.merge", {
      personIdA: a,
      personIdB: b,
    }),
  );
  console.log(`Merged into ${out.survivorId}`);
  printPerson(out.person);
}

export async function runPeople(args: string[]): Promise<void> {
  const sub = args[0] ?? "help";
  if (sub === "help" || sub === "--help" || sub === "-h") {
    printPeopleHelp();
    return;
  }

  if (sub === "list") {
    await runPeopleList(args);
    return;
  }
  if (sub === "search") {
    await runPeopleSearch(args);
    return;
  }
  if (sub === "get") {
    await runPeopleGet(args);
    return;
  }
  if (sub === "items") {
    await runPeopleItems(args);
    return;
  }
  if (sub === "link") {
    await runPeopleLink(args);
    return;
  }

  console.error(`Unknown people subcommand: ${sub}`);
  console.error("Try: nimbus people help");
  process.exitCode = 1;
}
