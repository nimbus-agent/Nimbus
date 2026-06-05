import { describe, expect, test } from "bun:test";
import { extractReadmeCliCommands, validateReadmeCommands } from "./readme-cli-commands.ts";

describe("extractReadmeCliCommands", () => {
  test("finds every `nimbus <subcommand>` literal", () => {
    const md = `
Run \`nimbus ask "..."\` to query.
Then \`nimbus connector list\` to verify.
Also: nimbus doctor.
But not "naimbus" or "nimbus_".
    `;
    const found = extractReadmeCliCommands(md);
    expect(found.sort((a, b) => a.localeCompare(b))).toEqual(
      ["ask", "connector", "doctor"].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("ignores escaped or partial matches", () => {
    const md = `Use \`gnimbus\` not nimbus. Or \`nimbus\` alone.`;
    const found = extractReadmeCliCommands(md);
    expect(found).toEqual([]);
  });
});

describe("validateReadmeCommands", () => {
  test("returns no errors when all commands are registered", () => {
    const result = validateReadmeCommands(["ask", "doctor"], ["ask", "doctor", "diag"]);
    expect(result.missing).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("returns missing commands when a README command isn't registered", () => {
    const result = validateReadmeCommands(["ask", "delete-everything"], ["ask", "diag"]);
    expect(result.missing).toEqual(["delete-everything"]);
    expect(result.ok).toBe(false);
  });
});
