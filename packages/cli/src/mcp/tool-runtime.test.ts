import { expect, test } from "bun:test";
import { COMMAND_NAMES } from "../commands/registry.ts";
import { GATEWAY_DOWN_MESSAGE } from "./errors.ts";
import { AGENT_TOOLS_UNSUPPORTED_MESSAGE } from "./tool-runtime.ts";

/**
 * The same rule `audit:readme-cli` enforces over `docs/README.md`, applied to the strings an
 * operator actually reads at the moment something has gone wrong.
 *
 * That gate cannot see these: it reads one markdown file. Routing this through it would mean either
 * teaching it to scan `packages/cli/src/**` — a far wider net with its own false-positive problem —
 * or having `packages/cli` import from `scripts/`, which crosses a package boundary for a
 * four-line regex. Re-applying the rule in-package against the same `COMMAND_NAMES` SSoT is
 * cheaper and equally binding.
 *
 * The pattern is `audit:readme-cli`'s, verbatim (`scripts/audit/readme-cli-commands.ts`), including
 * its `(?<!\w)` guard so `run-nimbus foo` does not match.
 */
const NIMBUS_COMMAND_PATTERN = /(?<!\w)nimbus\s+([a-z][a-z0-9-]*)/g;

/** Every `nimbus <cmd>` a message names, minus the flag-shaped stop words the audit also skips. */
function commandsNamedIn(message: string): string[] {
  const stopWords = new Set(["--version", "--help", "-v", "-h"]);
  return [...message.matchAll(NIMBUS_COMMAND_PATTERN)]
    .map((m) => m[1] ?? "")
    .filter((c) => c.length > 0 && !stopWords.has(c));
}

const OPERATOR_FACING_MESSAGES: ReadonlyArray<{ name: string; text: string }> = [
  { name: "AGENT_TOOLS_UNSUPPORTED_MESSAGE", text: AGENT_TOOLS_UNSUPPORTED_MESSAGE },
  { name: "GATEWAY_DOWN_MESSAGE", text: GATEWAY_DOWN_MESSAGE },
];

test("every `nimbus <cmd>` an MCP error message names is a real registered command", () => {
  // `nimbus restart` shipped in this file and does not exist: COMMAND_NAMES has start / stop /
  // update and nothing else close to it. An error whose FIX line names a command that errors out is
  // worse than no fix line, because it is read at the one moment the operator is already stuck.
  for (const { name, text } of OPERATOR_FACING_MESSAGES) {
    const named = commandsNamedIn(text);
    expect({ name, namedAtLeastOne: named.length > 0 }).toEqual({ name, namedAtLeastOne: true });
    const unregistered = named.filter((c) => !(COMMAND_NAMES as readonly string[]).includes(c));
    expect({ name, unregistered }).toEqual({ name, unregistered: [] });
  }
});

test("the degraded-mode message names the cause AND the fix, not merely a failure", () => {
  expect(AGENT_TOOLS_UNSUPPORTED_MESSAGE).toContain("session.declareKind");
  expect(AGENT_TOOLS_UNSUPPORTED_MESSAGE).toContain("egress ledger");
  expect(commandsNamedIn(AGENT_TOOLS_UNSUPPORTED_MESSAGE)).toContain("update");
});

test("the guard would catch a command that does not exist", () => {
  // Red-proves the assertion above without editing production source: `nimbus restart` — the exact
  // string that shipped — must be rejected by the same filter the test applies.
  const named = commandsNamedIn("Fix: run `nimbus update`, then `nimbus restart`.");
  expect(named).toEqual(["update", "restart"]);
  expect(named.filter((c) => !(COMMAND_NAMES as readonly string[]).includes(c))).toEqual([
    "restart",
  ]);
});
