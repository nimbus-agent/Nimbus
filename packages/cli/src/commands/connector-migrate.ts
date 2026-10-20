/**
 * `nimbus connector migrate list | accept <id> | decline <id> | retry` — the owner's side of a
 * bundled connector moving to its signed extension (Readwise unbundling spec § 7.2, § 7.3).
 *
 * `accept` asks ONE question, raised by the gateway under `extension.migrate` and answered at this
 * terminal. Like `nimbus extension approve`, it requires a terminal on both stdin and stdout, has no
 * `--yes`, and answers through the prompt handler directly — never `NIMBUS_SCRIPT_CONSENT_SOURCE`,
 * which would let an environment variable install and run third-party code. The TTY requirement is a
 * CLI-side guard; the gateway's own gate is the `extension.migrate` HITL prompt.
 *
 * A "no" at that prompt is NOT a decline: the row stays awaiting approval, so the question can be
 * answered again. Declining is its own verb, and `retry` is the way back from a decline.
 */
import type { IPCClient } from "../ipc-client/index.ts";
import { gatewayNotRunningMessage } from "../lib/gateway-not-running.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerConsentPromptHandler } from "../lib/interactive-ipc-handlers.ts";
import {
  BATCH_RPC_TIMEOUT_MS,
  createIpcClient,
  INTERACTIVE_RPC_TIMEOUT_MS,
} from "../lib/rpc-timeouts.ts";
import { getCliPlatformPaths } from "../paths.ts";

export const MIGRATE_USAGE =
  "Usage: nimbus connector migrate list [--json] | accept <id> | decline <id> | retry [--json]";

/** A row as `migration.*` returns it (no staging path is ever sent). */
export interface MigrationRowCli {
  readonly id: string;
  readonly legacyServiceId: string;
  readonly extensionId: string;
  readonly version: string | null;
  readonly state: string;
  readonly error: string | null;
  readonly updatedAt: number;
}

type ConfirmFn = Parameters<typeof registerConsentPromptHandler>[1];

/** Everything `migrate` touches outside itself, so a test can drive it with a TTY it controls. */
export interface MigrateIo {
  readonly stdinIsTty: boolean;
  readonly stdoutIsTty: boolean;
  /** Opens a CONNECTED client; `runConnectorMigrate` disconnects it. */
  readonly open: (requestTimeoutMs?: number) => Promise<IPCClient>;
  /** The terminal prompt `accept` answers the gateway's question with; default `@clack/prompts`. */
  readonly confirm?: ConfirmFn;
  readonly log: (line: string) => void;
}

export function defaultMigrateIo(): MigrateIo {
  return {
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    open: async (requestTimeoutMs) => {
      const paths = getCliPlatformPaths();
      const state = await readGatewayState(paths);
      if (state === undefined) throw new Error(gatewayNotRunningMessage(paths.demo === true));
      const client = createIpcClient(state.socketPath, requestTimeoutMs);
      await client.connect();
      return client;
    },
    log: (line) => console.log(line),
  };
}

const NOT_APPROVED = "ERR_EXTENSION_MIGRATION_NOT_APPROVED";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isMigrationRow(v: unknown): v is MigrationRowCli {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["id"] === "string" &&
    typeof r["legacyServiceId"] === "string" &&
    typeof r["extensionId"] === "string" &&
    typeof r["state"] === "string"
  );
}

function rowsOf(v: unknown): MigrationRowCli[] {
  const list = (v as { migrations?: unknown } | null)?.migrations;
  if (!Array.isArray(list) || !list.every(isMigrationRow)) {
    throw new Error("malformed migration.list response");
  }
  return list;
}

/** The next step for a row, in the owner's words. Empty for an approved row. */
export function migrationNextStep(row: MigrationRowCli): string {
  switch (row.state) {
    case "awaiting_approval":
      return `run \`nimbus connector migrate accept ${row.id}\` to keep it, or \`nimbus connector migrate decline ${row.id}\``;
    case "failed":
      return "run `nimbus connector migrate retry`";
    case "declined":
      return "run `nimbus connector migrate retry` to change your mind";
    default:
      return "";
  }
}

export function formatMigrationRows(rows: readonly MigrationRowCli[]): string[] {
  if (rows.length === 0) return ["No connector migrations."];
  const lines: string[] = [];
  for (const r of rows) {
    const version = r.version === null ? "" : ` ${r.version}`;
    lines.push(`${r.id}  ${r.legacyServiceId} -> ${r.extensionId}${version}  ${r.state}`);
    if (r.error !== null && r.state === "failed") lines.push(`    error: ${r.error}`);
    const next = migrationNextStep(r);
    if (next !== "") lines.push(`    ${next}`);
  }
  return lines;
}

function printRows(io: MigrateIo, raw: unknown, json: boolean): void {
  const rows = rowsOf(raw);
  if (json) {
    io.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const l of formatMigrationRows(rows)) io.log(l);
}

function requireId(verb: string, rest: readonly string[]): string {
  const id = rest.find((a) => !a.startsWith("-"))?.trim() ?? "";
  if (id === "") throw new Error(`Usage: nimbus connector migrate ${verb} <id>`);
  return id;
}

async function runAccept(io: MigrateIo, rest: readonly string[]): Promise<void> {
  const id = requireId("accept", rest);
  if (rest.includes("--yes") || rest.includes("-y")) {
    throw new Error(
      "nimbus connector migrate accept has no --yes: moving a connector to an extension installs and runs third-party code, so it must be answered by a person at a terminal.",
    );
  }
  if (!io.stdinIsTty || !io.stdoutIsTty) {
    throw new Error(
      "Refusing to accept a connector migration in non-TTY mode: the approval must be answered at a terminal.",
    );
  }
  const client = await io.open(INTERACTIVE_RPC_TIMEOUT_MS);
  try {
    // The prompt handler DIRECTLY (as `extension approve` does), so `NIMBUS_SCRIPT_CONSENT_SOURCE`
    // can never answer this question.
    if (io.confirm === undefined) registerConsentPromptHandler(client);
    else registerConsentPromptHandler(client, io.confirm);
    let row: MigrationRowCli;
    try {
      const out = await client.call<unknown>("migration.accept", { id });
      if (!isMigrationRow(out)) throw new Error("malformed migration.accept response");
      row = out;
    } catch (e) {
      const msg = errorMessage(e);
      if (msg.includes(NOT_APPROVED)) {
        throw new Error(
          `Not approved: migration ${id} is still awaiting approval and nothing was changed. Run \`nimbus connector migrate accept ${id}\` to answer again, or \`nimbus connector migrate decline ${id}\` to keep the connector off.`,
        );
      }
      throw e;
    }
    const version = row.version === null ? "" : ` ${row.version}`;
    io.log(
      `${row.legacyServiceId} now runs as the extension ${row.extensionId}${version}; its items, sync position and credential carried over.`,
    );
  } finally {
    await client.disconnect();
  }
}

async function runSimple(
  io: MigrateIo,
  method: "migration.list" | "migration.retry" | "migration.decline",
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const client = await io.open(timeoutMs);
  try {
    return await client.call<unknown>(method, params);
  } finally {
    await client.disconnect();
  }
}

export async function runConnectorMigrate(
  tail: readonly string[],
  io: MigrateIo = defaultMigrateIo(),
): Promise<void> {
  const verb = tail[0]?.trim() ?? "";
  const rest = tail.slice(1);
  const json = rest.includes("--json");
  switch (verb) {
    case "list":
      printRows(io, await runSimple(io, "migration.list", {}), json);
      return;
    case "retry":
      // Re-prepares failed AND declined rows, which can fetch from the official registry.
      printRows(io, await runSimple(io, "migration.retry", {}, BATCH_RPC_TIMEOUT_MS), json);
      return;
    case "accept":
      await runAccept(io, rest);
      return;
    case "decline": {
      const id = requireId("decline", rest);
      const out = await runSimple(io, "migration.decline", { id });
      if (!isMigrationRow(out)) throw new Error("malformed migration.decline response");
      io.log(
        `${out.legacyServiceId} stays off; your items are kept. Run \`nimbus connector migrate retry\` to change your mind.`,
      );
      return;
    }
    default:
      throw new Error(MIGRATE_USAGE);
  }
}
