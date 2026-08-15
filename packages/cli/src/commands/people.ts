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
  nimbus people list [--unlinked] [--limit N]
  nimbus people search <query> [--limit N]
  nimbus people get <id>
  nimbus people items <id> [--limit N]
  nimbus people link <id-a> <id-b>   Merge id-b into id-a (id-a survives)
  nimbus people help
`);
}

function parseListFlags(args: string[]): { unlinkedOnly: boolean; limit: number } {
  let unlinkedOnly = false;
  let limit = 100;
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
    }
  }
  return { unlinkedOnly, limit };
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

async function runPeopleList(args: string[]): Promise<void> {
  const { unlinkedOnly, limit } = parseListFlags(args);
  const rows = await withGatewayIpc((c) =>
    c.call<PersonJson[]>("people.list", { unlinkedOnly, limit }),
  );
  for (const p of rows) {
    printPerson(p);
  }
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
