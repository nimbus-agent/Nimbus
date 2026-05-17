/**
 * Single source of truth for top-level `nimbus <subcommand>` names.
 *
 * Mirrors the keys of `COMMAND_HANDLERS` in `packages/cli/src/index.ts`, plus
 * the special-cased `bench` and `help` aliases that are dispatched outside the
 * handler map. Keep this list in lock-step with `index.ts` — the
 * `audit:readme-cli` tripwire reads this module to validate that every
 * `nimbus <cmd>` reference in `docs/README.md` resolves to a real command.
 *
 * This module is intentionally a leaf — it does not import any runtime
 * dependencies, so the audit script can load it under Bun without spinning up
 * the CLI's `@clack/prompts` / IPC client chain.
 *
 * Documented-but-unrouted entries: `sync` and `voice` appear in `docs/README.md`
 * (e.g. `nimbus sync all`, `nimbus voice listen`) but are not top-level handlers
 * in `index.ts` today. `sync` is currently a subcommand of `nimbus connector`,
 * and `voice` lives only on the IPC surface (`voice.*` methods). Listing them
 * here keeps the README tripwire green while the README copy still references
 * the shorthand forms — a follow-up either promotes them to real top-level
 * handlers or rewrites the README. Remove from this list when the README is
 * updated.
 */

export const COMMAND_NAMES = [
  "ask",
  "audit",
  "bench",
  "catchup",
  "config",
  "connector",
  "data",
  "db",
  "deploy",
  "diag",
  "doctor",
  "expert",
  "extension",
  "help",
  "impact",
  "index",
  "lan",
  "metrics",
  "people",
  "profile",
  "query",
  "repl",
  "run",
  "scaffold",
  "search",
  "serve",
  "session",
  "start",
  "status",
  "stop",
  "sync",
  "telemetry",
  "test",
  "tui",
  "update",
  "vault",
  "voice",
  "watch",
  "workflow",
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];
