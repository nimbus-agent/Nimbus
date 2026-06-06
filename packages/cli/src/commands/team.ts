import { confirm, isCancel } from "@clack/prompts";

import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type TeamCommand =
  | { kind: "discover" }
  | { kind: "pair"; host: string; code: string }
  | { kind: "namespacePublish"; name: string; filters: Array<{ kind: string; value: string }> }
  | { kind: "namespaceGrant"; namespace: string; peerId: string; role: string; standing: boolean }
  | { kind: "namespaceRevoke"; namespace: string; peerId: string }
  | { kind: "query"; namespace: string; peerId: string; purpose: string }
  | { kind: "whoKnows"; peerId: string; query: string }
  | { kind: "consent"; requestId: string; approved: boolean }
  | { kind: "listen" };

function collectFilters(args: string[]): Array<{ kind: string; value: string }> {
  const filters: Array<{ kind: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--type" || a === "--service" || a === "--tag") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.length === 0) throw new Error(`${a} requires a value`);
      filters.push({ kind: a.slice(2), value: v });
      i += 1;
    }
  }
  return filters;
}

function parsePair(rest: string[]): TeamCommand {
  const host = rest[0];
  const code = rest[1];
  if (!host || !code) throw new Error("Usage: nimbus team pair <host> <code>");
  return { kind: "pair", host, code };
}

function parseNamespace(rest: string[]): TeamCommand {
  const action = rest[0];
  if (action === "publish") {
    const name = rest[1];
    if (!name) throw new Error("Usage: nimbus team namespace publish <name> --type T --service S");
    const filters = collectFilters(rest.slice(2));
    if (filters.length === 0)
      throw new Error("publish requires at least one --type/--service/--tag");
    return { kind: "namespacePublish", name, filters };
  }
  if (action === "grant") {
    const [namespace, peerId, role] = [rest[1], rest[2], rest[3]];
    if (!namespace || !peerId || !role)
      throw new Error("Usage: nimbus team namespace grant <ns> <peerId> <role> [--standing]");
    return {
      kind: "namespaceGrant",
      namespace,
      peerId,
      role,
      standing: rest.includes("--standing"),
    };
  }
  if (action === "revoke") {
    const [namespace, peerId] = [rest[1], rest[2]];
    if (!namespace || !peerId) throw new Error("Usage: nimbus team namespace revoke <ns> <peerId>");
    return { kind: "namespaceRevoke", namespace, peerId };
  }
  throw new Error("Usage: nimbus team namespace [publish|grant|revoke] ...");
}

function parseQuery(rest: string[]): TeamCommand {
  const [namespace, peerId, ...purposeParts] = rest;
  if (!namespace || !peerId || purposeParts.length === 0) {
    throw new Error('Usage: nimbus team query <ns> <peerId> "<purpose>"');
  }
  return { kind: "query", namespace, peerId, purpose: purposeParts.join(" ") };
}

function parseWhoKnows(rest: string[]): TeamCommand {
  const [peerId, ...queryParts] = rest;
  const q = queryParts.join(" ");
  if (!peerId || q.length === 0) throw new Error('Usage: nimbus team who-knows <peerId> "<query>"');
  return { kind: "whoKnows", peerId, query: q };
}

function parseConsent(rest: string[]): TeamCommand {
  const requestId = rest[0];
  const verb = rest[1];
  if (requestId === undefined || (verb !== "approve" && verb !== "deny")) {
    throw new Error("usage: nimbus team consent <requestId> approve|deny");
  }
  return { kind: "consent", requestId, approved: verb === "approve" };
}

export function parseTeamArgs(argv: string[]): TeamCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "discover":
      return { kind: "discover" };
    case "pair":
      return parsePair(rest);
    case "namespace":
      return parseNamespace(rest);
    case "query":
      return parseQuery(rest);
    case "who-knows":
      return parseWhoKnows(rest);
    case "consent":
      return parseConsent(rest);
    case "listen":
      return { kind: "listen" };
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\nUsage: nimbus team [discover|pair|namespace|query|who-knows]`,
      );
  }
}

async function respondToConsent(
  client: IPCClient,
  requestId: string,
  approved: boolean,
): Promise<void> {
  try {
    const r = await client.call<{ matched?: boolean }>("federation.consentRespond", {
      requestId,
      approved,
    });
    if (r.matched === false) {
      process.stderr.write(
        `No pending consent request for ${requestId} (already answered or timed out).\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(`consent ${approved ? "approved" : "denied"} for ${requestId}\n`);
    }
  } catch (e) {
    process.stderr.write(
      `Error responding to consent request: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exitCode = 1;
  }
}

async function runConsentListener(client: IPCClient): Promise<void> {
  process.stdout.write("Listening for federation consent requests. Press Ctrl-C to stop.\n");
  client.onNotification("federation.consentRequest", (params: unknown) => {
    void (async () => {
      const p = params as {
        requestId?: string;
        peerId?: string;
        namespace?: string;
        purpose?: string;
      };
      if (typeof p.requestId !== "string") return;
      const ok = await confirm({
        message: `Peer ${p.peerId ?? "?"} requests namespace "${p.namespace ?? "?"}" (purpose: ${p.purpose ?? "?"}). Approve?`,
      });
      if (isCancel(ok)) {
        // Esc/cancel: do NOT submit a deny — leave the query to time out on the answerer.
        process.stdout.write(
          `consent prompt cancelled for ${p.requestId}; leaving it to time out.\n`,
        );
        return;
      }
      try {
        await client.call("federation.consentRespond", {
          requestId: p.requestId,
          approved: ok === true,
        });
      } catch (e) {
        process.stderr.write(
          `Error sending consent decision: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    })();
  });
  await new Promise<void>(() => {}); // run until interrupted (Ctrl-C)
}

export async function runTeam(argv: string[]): Promise<void> {
  let cmd: TeamCommand;
  try {
    cmd = parseTeamArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    switch (cmd.kind) {
      case "discover": {
        const r = await client.call<{ peers: unknown[] }>("federation.discover", {});
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "namespacePublish": {
        const r = await client.call<unknown>("federation.namespace.publish", {
          name: cmd.name,
          filters: cmd.filters,
        });
        process.stdout.write(`Published ${cmd.name}\n${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "namespaceGrant": {
        await client.call<unknown>("federation.namespace.grant", {
          namespace: cmd.namespace,
          peerId: cmd.peerId,
          role: cmd.role,
          standingConsent: cmd.standing,
        });
        process.stdout.write(`Granted ${cmd.role} on ${cmd.namespace} to ${cmd.peerId}\n`);
        break;
      }
      case "namespaceRevoke": {
        await client.call<unknown>("federation.namespace.revoke", {
          namespace: cmd.namespace,
          peerId: cmd.peerId,
        });
        process.stdout.write(`Revoked ${cmd.peerId} from ${cmd.namespace}\n`);
        break;
      }
      case "query": {
        const r = await client.call<unknown>("federation.ask", {
          peerId: cmd.peerId,
          namespace: cmd.namespace,
          purpose: cmd.purpose,
        });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "whoKnows": {
        const r = await client.call<unknown>("federation.askExpertise", {
          peerId: cmd.peerId,
          query: cmd.query,
          purpose: "who-knows",
        });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "pair": {
        const r = await client.call<unknown>("federation.pair", {
          host: cmd.host,
          code: cmd.code,
        });
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "consent":
        await respondToConsent(client, cmd.requestId, cmd.approved);
        break;
      case "listen":
        await runConsentListener(client);
        break;
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
}
