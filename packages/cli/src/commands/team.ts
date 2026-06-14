import { confirm, isCancel } from "@clack/prompts";

import { IPCClient } from "../ipc-client/index.ts";
import { type GatewayStateFile, readGatewayState } from "../lib/gateway-process.ts";
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
  | { kind: "listen" }
  // Team Vault (Slice 2)
  | { kind: "vaultPut"; entry: string; service: string; secrets: Record<string, string> }
  | { kind: "vaultGrant"; entry: string; peerId: string; toolId: string }
  | { kind: "vaultRevoke"; entry: string; peerId: string; toolId: string }
  | { kind: "vaultList" }
  | {
      kind: "invoke";
      peerId: string;
      entry: string;
      toolId: string;
      purpose: string;
      args: unknown;
    }
  | {
      kind: "delegate";
      delegatePeer: string;
      scopeKind: string;
      scopeValue: string;
      expires: number;
    }
  | { kind: "delegations" }
  | { kind: "respond"; requestId: string; approved: boolean; as: string }
  | { kind: "audit"; namespace: string; purpose: string; sinceMs: number }
  | { kind: "purge"; externalId: string; yes: boolean };

/** Minimal IPC surface the team-vault/invoke/delegation subcommands need (injectable for tests). */
export interface TeamRpcClient {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
}

/**
 * The full client surface the connect → dispatch → disconnect orchestration needs: {@link
 * TeamRpcClient} plus the connection lifecycle and notification registration. {@link IPCClient}
 * satisfies it; injectable so {@link dispatchTeamCommand} / {@link runTeamWithIo} / the consent
 * listener are unit-testable with a fake.
 */
export interface TeamClient extends TeamRpcClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onNotification(method: string, handler: (params: unknown) => void): void;
}

/** The `confirm`-shaped prompt the consent listener uses, injected so the decision logic is unit-testable. */
export type ConfirmPrompt = (opts: { message: string }) => Promise<boolean | symbol>;

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

function parseSecrets(args: string[]): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--secret") {
      const kv = args[i + 1];
      const eq = typeof kv === "string" ? kv.indexOf("=") : -1;
      if (typeof kv !== "string" || eq <= 0) throw new Error("--secret requires key=value");
      secrets[kv.slice(0, eq)] = kv.slice(eq + 1);
      i += 1;
    }
  }
  return secrets;
}

function parseVault(rest: string[]): TeamCommand {
  const action = rest[0];
  if (action === "put") {
    const [entry, service] = [rest[1], rest[2]];
    if (!entry || !service)
      throw new Error("Usage: nimbus team vault put <entry> <service> --secret key=value");
    const secrets = parseSecrets(rest.slice(3));
    if (Object.keys(secrets).length === 0)
      throw new Error("vault put requires at least one --secret key=value");
    return { kind: "vaultPut", entry, service, secrets };
  }
  if (action === "grant" || action === "revoke") {
    const [entry, peerId, toolId] = [rest[1], rest[2], rest[3]];
    if (!entry || !peerId || !toolId)
      throw new Error(`Usage: nimbus team vault ${action} <entry> <peerId> <toolId>`);
    return action === "grant"
      ? { kind: "vaultGrant", entry, peerId, toolId }
      : { kind: "vaultRevoke", entry, peerId, toolId };
  }
  if (action === "list") return { kind: "vaultList" };
  throw new Error("Usage: nimbus team vault [put|grant|revoke|list] ...");
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function parseInvoke(rest: string[]): TeamCommand {
  const [peerId, entry, toolId] = [rest[0], rest[1], rest[2]];
  if (!peerId || !entry || !toolId)
    throw new Error(
      'Usage: nimbus team invoke <peerId> <entry> <toolId> --purpose "<why>" [--args <json>]',
    );
  const purpose = flagValue(rest, "--purpose") ?? "";
  const argsRaw = flagValue(rest, "--args");
  let args: unknown = {};
  if (argsRaw !== undefined) {
    try {
      args = JSON.parse(argsRaw);
    } catch {
      throw new Error("--args must be valid JSON");
    }
  }
  return { kind: "invoke", peerId, entry, toolId, purpose, args };
}

function parseDelegate(rest: string[]): TeamCommand {
  const delegatePeer = rest[0];
  const scope = flagValue(rest, "--scope");
  const expiresRaw = flagValue(rest, "--expires");
  const colon = typeof scope === "string" ? scope.indexOf(":") : -1;
  if (!delegatePeer || typeof scope !== "string" || colon <= 0 || expiresRaw === undefined) {
    throw new Error("Usage: nimbus team delegate <peerId> --scope kind:value --expires <seconds>");
  }
  const expires = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expires) || expires <= 0)
    throw new Error("--expires must be a positive number of seconds");
  return {
    kind: "delegate",
    delegatePeer,
    scopeKind: scope.slice(0, colon),
    scopeValue: scope.slice(colon + 1),
    expires,
  };
}

function parseAudit(rest: string[]): TeamCommand {
  const namespace = rest[0];
  if (!namespace || namespace.startsWith("--")) {
    throw new Error('Usage: nimbus team audit <namespace> [--purpose "<why>"] [--since <unixMs>]');
  }
  const purpose = flagValue(rest, "--purpose") ?? "team-audit";
  const sinceRaw = flagValue(rest, "--since");
  let sinceMs = 0;
  if (sinceRaw !== undefined) {
    sinceMs = Number.parseInt(sinceRaw, 10);
    if (!Number.isFinite(sinceMs) || sinceMs < 0)
      throw new Error("--since must be a non-negative unix-ms timestamp");
  }
  return { kind: "audit", namespace, purpose, sinceMs };
}

function parsePurge(rest: string[]): TeamCommand {
  const externalId = flagValue(rest, "--user");
  if (typeof externalId !== "string" || externalId.length === 0) {
    throw new Error("Usage: nimbus team purge --user <externalId> [--yes]");
  }
  return { kind: "purge", externalId, yes: rest.includes("--yes") || rest.includes("--force") };
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
    case "vault":
      return parseVault(rest);
    case "invoke":
      return parseInvoke(rest);
    case "delegate":
      return parseDelegate(rest);
    case "delegations":
      return { kind: "delegations" };
    case "audit":
      return parseAudit(rest);
    case "purge":
      return parsePurge(rest);
    case "approve":
    case "deny": {
      const requestId = rest[0];
      if (!requestId) throw new Error(`Usage: nimbus team ${sub} <requestId> [--as <peerId>]`);
      return {
        kind: "respond",
        requestId,
        approved: sub === "approve",
        as: flagValue(rest, "--as") ?? "self",
      };
    }
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\nUsage: nimbus team [discover|pair|namespace|query|who-knows|vault|invoke|delegate|delegations|approve|deny|audit|purge]`,
      );
  }
}

interface MergedAuditRow {
  peerId?: unknown;
  actionType?: unknown;
  hitlStatus?: unknown;
  hash?: unknown;
  timestamp?: unknown;
}

/** Audit rows arrive as untyped JSON — render only primitive cells, never "[object Object]". */
function cellText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

/** Renders the merged team-audit timeline as a fixed-width table (timestamp, peer, action, hitl, hash). */
export function renderAuditTable(entries: MergedAuditRow[]): string {
  const header = ["TIMESTAMP", "PEER", "ACTION", "HITL", "HASH"];
  const rows = entries.map((e) => [
    typeof e.timestamp === "number" ? new Date(e.timestamp).toISOString() : cellText(e.timestamp),
    cellText(e.peerId),
    cellText(e.actionType),
    cellText(e.hitlStatus),
    cellText(e.hash).slice(0, 12),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const fmt = (cols: string[]): string => cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");
  return [fmt(header), ...rows.map(fmt)].join("\n");
}

async function respondToConsent(
  client: TeamRpcClient,
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

/**
 * Handles a single `federation.consentRequest` notification: prompt the operator and submit the
 * decision. Extracted from {@link runConsentListener} (which keeps only the notification
 * registration + the run-until-interrupted wait) so the decision logic is unit-testable with an
 * injected `prompt`. The real listener passes clack's `confirm`.
 */
export async function handleConsentNotification(
  client: TeamRpcClient,
  params: unknown,
  prompt: ConfirmPrompt,
  isCancelled: (value: unknown) => boolean,
): Promise<void> {
  // `params` is external (notification payload) — narrow safely before any property access so a
  // null / non-object payload can't throw in this fire-and-forget listener path.
  if (typeof params !== "object" || params === null) return;
  const p = params as {
    requestId?: unknown;
    peerId?: unknown;
    namespace?: unknown;
    purpose?: unknown;
  };
  const requestId = typeof p.requestId === "string" ? p.requestId : undefined;
  if (requestId === undefined) return;
  const peerId = typeof p.peerId === "string" ? p.peerId : "?";
  const namespace = typeof p.namespace === "string" ? p.namespace : "?";
  const purpose = typeof p.purpose === "string" ? p.purpose : "?";
  const ok = await prompt({
    message: `Peer ${peerId} requests namespace "${namespace}" (purpose: ${purpose}). Approve?`,
  });
  if (isCancelled(ok)) {
    // Esc/cancel: do NOT submit a deny — leave the query to time out on the answerer.
    process.stdout.write(`consent prompt cancelled for ${requestId}; leaving it to time out.\n`);
    return;
  }
  try {
    await client.call("federation.consentRespond", {
      requestId,
      approved: ok === true,
    });
  } catch (e) {
    process.stderr.write(
      `Error sending consent decision: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}

/**
 * Prints the banner and registers the `federation.consentRequest` handler, binding the real clack
 * `confirm` + `isCancel` (the single untestable shell call site). Extracted from {@link
 * runConsentListener} so the registration + dispatch-to-handler is unit-testable; the handler stays
 * DI-only so all its branches are coverable.
 */
export function registerConsentListener(client: TeamClient): void {
  process.stdout.write("Listening for federation consent requests. Press Ctrl-C to stop.\n");
  client.onNotification("federation.consentRequest", (params: unknown) => {
    void handleConsentNotification(client, params, confirm, isCancel);
  });
}

export async function runConsentListener(client: TeamClient): Promise<void> {
  registerConsentListener(client);
  await new Promise<void>(() => {}); // run until interrupted (Ctrl-C)
}

/**
 * Executes the Slice-2 team-vault / invoke / delegation subcommands over an injected IPC client.
 * Returns true if it handled `cmd`, false otherwise (so `runTeam` falls through to the federation
 * subcommands). Exported (with `runTeamCommand`) so tests can drive it with a fake client.
 */
export async function runTeamVaultRpc(client: TeamRpcClient, cmd: TeamCommand): Promise<boolean> {
  switch (cmd.kind) {
    case "vaultPut": {
      await client.call("teamvault.put", {
        entry: cmd.entry,
        service: cmd.service,
        secrets: cmd.secrets,
      });
      process.stdout.write(
        `Stored ${Object.keys(cmd.secrets).length} secret(s) for ${cmd.entry}\n`,
      );
      return true;
    }
    case "vaultGrant": {
      await client.call("teamvault.grant", {
        entry: cmd.entry,
        peerId: cmd.peerId,
        toolId: cmd.toolId,
      });
      process.stdout.write(`Granted ${cmd.peerId} use of ${cmd.toolId} on ${cmd.entry}\n`);
      return true;
    }
    case "vaultRevoke": {
      await client.call("teamvault.revoke", {
        entry: cmd.entry,
        peerId: cmd.peerId,
        toolId: cmd.toolId,
      });
      process.stdout.write(`Revoked ${cmd.peerId} from ${cmd.toolId} on ${cmd.entry}\n`);
      return true;
    }
    case "vaultList": {
      const r = await client.call<unknown>("teamvault.list", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return true;
    }
    case "invoke": {
      const r = await client.call<unknown>("federation.askInvoke", {
        peerId: cmd.peerId,
        entry: cmd.entry,
        toolId: cmd.toolId,
        purpose: cmd.purpose,
        args: cmd.args,
      });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return true;
    }
    case "delegate": {
      // expires is seconds-from-now; the gateway stores an absolute expiresAt (ms).
      const expiresAt = Date.now() + cmd.expires * 1000;
      const r = await client.call<unknown>("hitl.delegate", {
        delegatePeer: cmd.delegatePeer,
        scopeKind: cmd.scopeKind,
        scopeValue: cmd.scopeValue,
        expiresAt,
      });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return true;
    }
    case "delegations": {
      const r = await client.call<unknown>("hitl.listDelegations", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      return true;
    }
    case "respond": {
      // A response may resolve either a quorum vote or a delegated approval — try both brokers.
      await client.call("federation.approvalRespond", {
        requestId: cmd.requestId,
        peerId: cmd.as,
        approved: cmd.approved,
      });
      await client.call("federation.quorumRespond", {
        requestId: cmd.requestId,
        peerId: cmd.as,
        approved: cmd.approved,
      });
      process.stdout.write(`${cmd.approved ? "approved" : "denied"} ${cmd.requestId}\n`);
      return true;
    }
    case "purge": {
      // GDPR purge is irreversible: confirm before dispatching unless --yes/--force was passed.
      if (!cmd.yes) {
        const ok = await confirm({
          message: `Purge ALL data for user "${cmd.externalId}" across the team? This is irreversible.`,
        });
        if (isCancel(ok) || ok !== true) {
          process.stdout.write("aborted\n");
          return true;
        }
      }
      const r = await client.call<{ jobId?: string; localDeleted?: number }>("team.purge", {
        externalId: cmd.externalId,
      });
      process.stdout.write(
        `GDPR purge started for ${cmd.externalId}: job ${r.jobId ?? "?"} (${r.localDeleted ?? 0} local grant(s) revoked)\n`,
      );
      return true;
    }
    default:
      return false;
  }
}

/**
 * Executes the federation subcommands — everything except the team-vault subset handled by
 * {@link runTeamVaultRpc} and the long-lived `listen` loop — over an injected IPC client. Exported
 * so tests can drive each branch with a fake client without a live gateway.
 */
export async function runTeamFederationRpc(client: TeamRpcClient, cmd: TeamCommand): Promise<void> {
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
    case "audit": {
      const r = await client.call<{ entries: MergedAuditRow[] }>("team.auditMerged", {
        namespace: cmd.namespace,
        purpose: cmd.purpose,
        sinceMs: cmd.sinceMs,
      });
      const entries = Array.isArray(r.entries) ? r.entries : [];
      if (entries.length === 0) {
        process.stdout.write("No federation-audit entries across the team.\n");
      } else {
        process.stdout.write(`${renderAuditTable(entries)}\n`);
      }
      break;
    }
  }
}

/**
 * Parse + execute a team-vault / invoke / delegation subcommand over an injected client (test entry
 * point). Federation subcommands are tested directly via the exported `runTeamFederationRpc`.
 */
export async function runTeamCommand(
  argv: string[],
  deps: { client: TeamRpcClient },
): Promise<void> {
  const cmd = parseTeamArgs(argv);
  const handled = await runTeamVaultRpc(deps.client, cmd);
  if (!handled) throw new Error(`runTeamCommand does not handle subcommand: ${cmd.kind}`);
}

/**
 * Post-connect dispatch: team-vault / invoke / delegation subcommands first, then the long-lived
 * `listen` loop, otherwise the federation subcommands — always disconnecting afterwards. The
 * `listen` seam is injected (not defaulted) so a test can cover the listen branch without blocking
 * on its run-until-interrupted wait; {@link runTeamWithIo} passes the real {@link
 * runConsentListener}. Exported so the branch + always-disconnect logic is unit-testable with a fake
 * client.
 */
export async function dispatchTeamCommand(
  client: TeamClient,
  cmd: TeamCommand,
  listen: (client: TeamClient) => Promise<void>,
): Promise<void> {
  try {
    if (await runTeamVaultRpc(client, cmd)) {
      return;
    }
    if (cmd.kind === "listen") {
      await listen(client);
      return;
    }
    await runTeamFederationRpc(client, cmd);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** I/O seams for {@link runTeam}, injectable so the orchestration (parse-error exit, gateway-down
 *  exit, connect → dispatch → disconnect) is unit-testable; {@link runTeam} wires the real ones. */
export interface RunTeamIo {
  readGatewayState: () => Promise<GatewayStateFile | undefined>;
  makeClient: (socketPath: string) => TeamClient;
  exit: (code: number) => never;
}

/**
 * The team subcommand orchestration over injected I/O seams: parse → (error → exit 1) →
 * read gateway state → (down → exit 1) → connect → dispatch → disconnect. All branch logic lives
 * here (and in {@link dispatchTeamCommand}); the exported {@link runTeam} is the thin shell that
 * binds the real seams.
 */
export async function runTeamWithIo(argv: string[], io: RunTeamIo): Promise<void> {
  let cmd: TeamCommand;
  try {
    cmd = parseTeamArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return io.exit(1);
  }

  const state = await io.readGatewayState();
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    return io.exit(1);
  }
  const client = io.makeClient(state.socketPath);
  await client.connect();
  await dispatchTeamCommand(client, cmd, runConsentListener);
}

const REAL_TEAM_IO: RunTeamIo = {
  readGatewayState: () => readGatewayState(getCliPlatformPaths()),
  makeClient: (socketPath) => new IPCClient(socketPath),
  exit: (code) => process.exit(code),
};

export async function runTeam(argv: string[]): Promise<void> {
  await runTeamWithIo(argv, REAL_TEAM_IO);
}
