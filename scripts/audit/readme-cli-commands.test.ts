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
    expect(found.toSorted((a, b) => a.localeCompare(b))).toEqual(
      ["ask", "connector", "doctor"].sort((a, b) => a.localeCompare(b)),
    );
  });

  test("ignores escaped or partial matches", () => {
    const md = `Use \`gnimbus\` not nimbus. Or \`nimbus\` alone.`;
    const found = extractReadmeCliCommands(md);
    expect(found).toEqual([]);
  });

  // Both cases below were live false positives against the real landing page:
  // its install snippets pushed `nimbus less` and `nimbus install.sh` into the
  // gate, which then demanded they be "registered" as CLI subcommands.
  test("does not read a PATH ending in `nimbus` as the command", () => {
    const md = [
      "curl -fsSL .../nimbus.tar.gz -o /tmp/nimbus.tar.gz",
      "tar -xzf /tmp/nimbus.tar.gz -C /tmp/nimbus",
      "/tmp/nimbus/install.sh",
      "brew install nimbus-agent/tap/nimbus",
      "cd packages/nimbus && ls",
    ].join("\n");
    expect(extractReadmeCliCommands(md)).toEqual([]);
  });

  test("does not let a match span a newline", () => {
    // `\s` would swallow the line break and pair the path with the next line's
    // first word — this is verbatim the shape that produced `nimbus less`.
    const md = "tar -xzf /tmp/nimbus.tar.gz -C /tmp/nimbus\nless /tmp/nimbus/install.sh";
    expect(extractReadmeCliCommands(md)).toEqual([]);
  });

  test("still finds a real invocation on the line after a path", () => {
    const md = "cd /tmp/nimbus\nnimbus doctor";
    expect(extractReadmeCliCommands(md)).toEqual(["doctor"]);
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
