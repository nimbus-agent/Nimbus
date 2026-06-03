import { intro, outro } from "@clack/prompts";

import {
  printHelp,
  runAsk,
  runAudit,
  runBench,
  runCatchupCli,
  runConfig,
  runConnector,
  runData,
  runDb,
  runDeployCli,
  runDiag,
  runDoctor,
  runExpertCli,
  runExtension,
  runImpactCli,
  runIndexCmd,
  runLan,
  runLlm,
  runMcpServer,
  runMetricsCli,
  runPeople,
  runProfile,
  runQuery,
  runRepl,
  runScaffold,
  runSearch,
  runSecurity,
  runServe,
  runSession,
  runStart,
  runStatus,
  runStop,
  runTelemetry,
  runTest,
  runTui,
  runUpdate,
  runVault,
  runWatch,
  runWorkflowCli,
  runWorkflowFromFile,
} from "./commands/index.ts";
import { createCliFileLogger } from "./lib/cli-logger.ts";
import { getCliPlatformPaths } from "./paths.ts";

const rawArgv = process.argv.slice(2);
const isInteractiveShell = process.stdin.isTTY === true && process.stdout.isTTY === true;

const isPiped = process.stdout.isTTY !== true;
const isJsonMode = rawArgv.includes("--json");
const isExplicitlyQuiet = process.env["NIMBUS_QUIET"] === "1";

const shouldSuppressBanner = isPiped || isJsonMode || isExplicitlyQuiet;

type CommandHandler = (args: string[]) => Promise<void> | void;

const COMMAND_HANDLERS: Readonly<Record<string, CommandHandler>> = {
  start: runStart,
  stop: runStop,
  status: runStatus,
  db: runDb,
  diag: runDiag,
  query: runQuery,
  telemetry: runTelemetry,
  tui: runTui,
  update: runUpdate,
  doctor: runDoctor,
  config: runConfig,
  profile: runProfile,
  serve: runServe,
  test: runTest,
  ask: runAsk,
  catchup: runCatchupCli,
  expert: runExpertCli,
  impact: runImpactCli,
  index: runIndexCmd,
  vault: runVault,
  audit: runAudit,
  connector: runConnector,
  data: runData,
  deploy: runDeployCli,
  extension: runExtension,
  people: runPeople,
  search: runSearch,
  security: runSecurity,
  session: runSession,
  workflow: runWorkflowCli,
  watch: runWatch,
  repl: runRepl,
  run: runWorkflowFromFile,
  scaffold: runScaffold,
  lan: runLan,
  llm: runLlm,
  metrics: runMetricsCli,
  "mcp-server": runMcpServer,
};

const HELP_ALIASES = new Set(["help", "--help", "-h"]);

async function dispatchCommand(command: string, args: string[]): Promise<void> {
  if (HELP_ALIASES.has(command)) {
    printHelp();
    return;
  }
  if (command === "bench") {
    process.exitCode = await runBench(args);
    return;
  }
  const handler = COMMAND_HANDLERS[command];
  if (handler === undefined) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
    return;
  }
  await handler(args);
}

async function main(): Promise<void> {
  if (!shouldSuppressBanner) intro("Nimbus");
  const paths = getCliPlatformPaths();
  const { logger } = await createCliFileLogger(paths);
  logger.info({ event: "cli.invoke", argv: process.argv }, "invoke");

  try {
    if (rawArgv.length === 0 && isInteractiveShell) {
      await runRepl([]);
    } else {
      const [command = "help", ...args] = rawArgv;
      await dispatchCommand(command, args);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(
      {
        event: "cli.error",
        err:
          e instanceof Error
            ? { type: e.name, message: e.message, stack: e.stack }
            : { message: String(e) },
      },
      msg,
    );
    console.error(msg);
    process.exitCode = 1;
  } finally {
    logger.info({ event: "cli.finished", exitCode: process.exitCode ?? 0 }, "finished");
  }

  if (!shouldSuppressBanner) outro("Done.");
}

await main();
