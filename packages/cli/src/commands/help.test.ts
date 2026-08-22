import { afterAll, beforeEach, describe, expect, it } from "bun:test";

import { captureOutput } from "../../test/helpers/cli-output.ts";
import { COMMAND_NAMES } from "./registry.ts";

const helpMod = await import("./help.ts");
const { printHelp } = helpMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("printHelp", () => {
  beforeEach(() => {
    out.reset();
  });

  it("prints a header naming the CLI", () => {
    printHelp();
    expect(out.stdout).toContain("Nimbus CLI");
  });

  it("includes a Usage section", () => {
    printHelp();
    expect(out.stdout).toMatch(/Usage:/);
  });

  it("documents core lifecycle commands", () => {
    printHelp();
    expect(out.stdout).toContain("nimbus start");
    expect(out.stdout).toContain("nimbus stop");
    expect(out.stdout).toContain("nimbus status");
  });

  it("documents Phase 3.5 + Phase 4 commands", () => {
    printHelp();
    expect(out.stdout).toContain("nimbus config");
    expect(out.stdout).toContain("nimbus profile");
    expect(out.stdout).toContain("nimbus telemetry");
    expect(out.stdout).toContain("nimbus vault");
    expect(out.stdout).toContain("nimbus audit");
  });

  it("documents agent + CI/CD commands", () => {
    printHelp();
    expect(out.stdout).toContain("nimbus expert");
    expect(out.stdout).toContain("nimbus impact");
    expect(out.stdout).toContain("nimbus metrics dora");
    // `audit:readme-cli` only validates README→registry, so nothing else catches a command
    // that is registered and documented but missing from `nimbus help`. `nimbus stats` was.
    expect(out.stdout).toContain("nimbus stats");
    expect(out.stdout).toContain("nimbus deploy");
  });

  it("lists optional environment variables", () => {
    printHelp();
    expect(out.stdout).toContain("NIMBUS_GATEWAY_EXECUTABLE");
    expect(out.stdout).toContain("OPENAI_API_KEY");
  });

  it("writes nothing to stderr", () => {
    printHelp();
    expect(out.stderr).toBe("");
  });
});

describe("nimbus help names every command you can run (F19)", () => {
  /**
   * `nimbus help` listed 39 of the 65 registered commands. The 26 missing included NINE of the
   * fourteen agents — `conflicts`, `decisions`, `ghost`, `huddle`, `janitor`, `why`, `negotiate`,
   * `owners`, `pre-mortem` — plus `prove`, `egress`, `share`, `update` and the whole team
   * surface. Built, dispatchable, documented in the CLI reference, and invisible to anyone who
   * did not already know they existed.
   *
   * Nothing caught it: `audit:readme-cli` checks README→registry, the one direction that cannot
   * see a registry entry missing from help. The gap was even RECORDED in a comment in this file,
   * beside a hard-coded assertion for the single command that had been noticed.
   *
   * `COMMAND_NAMES` is the right source rather than `COMMAND_HANDLERS`: `help`, `version` and
   * `bench` are dispatched by special cases ahead of the map, so the map is not the full set of
   * what a user can type.
   */
  const HIDDEN_FROM_HELP: ReadonlySet<string> = new Set([
    // Exec'd by an MCP client via the `nimbus-mcp` launcher, never typed by a human. Listing it
    // would invite someone to run a stdio server in their terminal and watch it hang.
    "mcp-server",
  ]);

  it("every registered command appears, except a justified few", () => {
    printHelp();
    const missing = COMMAND_NAMES.filter(
      (name) => !HIDDEN_FROM_HELP.has(name) && !out.stdout.includes(`nimbus ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it("the hidden set stays small and deliberate", () => {
    // A guard whose allow-list can grow silently is a guard that gets emptied one entry at a
    // time. Adding to it should require editing this number and saying why.
    expect(HIDDEN_FROM_HELP.size).toBe(1);
  });

  it("names the nine agents that were invisible", () => {
    // Spelled out rather than covered only by the loop above: these are the entries whose
    // absence had the most user-visible cost, and a future refactor of the loop should not be
    // able to drop them without a named failure.
    printHelp();
    for (const agent of [
      "conflicts",
      "decisions",
      "ghost",
      "huddle",
      "janitor",
      "why",
      "negotiate",
      "owners",
      "pre-mortem",
    ]) {
      expect(out.stdout).toContain(`nimbus ${agent}`);
    }
  });
});
