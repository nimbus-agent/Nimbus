import { intro, outro } from "@clack/prompts";

import {
  printHelp,
  runAdmin,
  runAsk,
  runAudit,
  runBench,
  runCatchupCli,
  runChatops,
  runClip,
  runComputer,
  runConfig,
  runConflictsCli,
  runConnector,
  runData,
  runDb,
  runDecisionsCommand,
  runDeployCli,
  runDiag,
  runDoctor,
  runEgress,
  runExec,
  runExpertCli,
  runExtension,
  runGhostCli,
  runGlossaryCommand,
  runHuddleCli,
  runIdentity,
  runImpactCli,
  runIndexCmd,
  runInit,
  runJanitorCli,
  runLan,
  runLlm,
  runMcpServer,
  runMediaCmd,
  runMetricsCli,
  runNegotiateCommand,
  runOwnersCommand,
  runPeople,
  runPolicy,
  runPreflightCli,
  runPreMortemCommand,
  runProfile,
  runProve,
  runQuery,
  runRepl,
  runScaffold,
  runScim,
  runSearch,
  runSecurity,
  runServe,
  runSession,
  runShare,
  runStart,
  runStats,
  runStatus,
  runStop,
  runTeam,
  runTelemetry,
  runTest,
  runTribal,
  runTui,
  runUpdate,
  runVault,
  runVerifyShare,
  runWatch,
  runWhyCli,
  runWorkflowCli,
  runWorkflowFromFile,
} from "./commands/index.ts";
import { createCliFileLogger } from "./lib/cli-logger.ts";
import { getCliPlatformPaths } from "./paths.ts";
import { NIMBUS_VERSION } from "./version.ts";

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
  conflicts: runConflictsCli,
  decisions: runDecisionsCommand,
  expert: runExpertCli,
  ghost: runGhostCli,
  glossary: runGlossaryCommand,
  huddle: runHuddleCli,
  impact: runImpactCli,
  janitor: runJanitorCli,
  index: runIndexCmd,
  init: runInit,
  vault: runVault,
  audit: runAudit,
  connector: runConnector,
  data: runData,
  deploy: runDeployCli,
  extension: runExtension,
  people: runPeople,
  preflight: runPreflightCli,
  search: runSearch,
  security: runSecurity,
  session: runSession,
  workflow: runWorkflowCli,
  watch: runWatch,
  why: runWhyCli,
  repl: runRepl,
  run: runWorkflowFromFile,
  scaffold: runScaffold,
  lan: runLan,
  llm: runLlm,
  media: runMediaCmd,
  metrics: runMetricsCli,
  stats: runStats,
  negotiate: runNegotiateCommand,
  owners: runOwnersCommand,
  "pre-mortem": runPreMortemCommand,
  team: runTeam,
  identity: runIdentity,
  scim: runScim,
  policy: runPolicy,
  chatops: runChatops,
  tribal: runTribal,
  admin: runAdmin,
  share: runShare,
  "verify-share": runVerifyShare,
  "mcp-server": runMcpServer,
  prove: runProve,
  egress: runEgress,
  exec: runExec,
  clip: runClip,
  computer: runComputer,
};

const HELP_ALIASES = new Set(["help", "--help", "-h"]);
const VERSION_ALIASES = new Set(["--version", "-v", "version"]);

async function dispatchCommand(command: string, args: string[]): Promise<void> {
  if (VERSION_ALIASES.has(command)) {
    console.log(NIMBUS_VERSION);
    return;
  }
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
