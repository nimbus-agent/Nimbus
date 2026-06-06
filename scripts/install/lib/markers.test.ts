import { describe, expect, test } from "bun:test";
import { BEGIN_MARKER, buildMarkerBlock, END_MARKER, stripMarkerBlock } from "./markers.ts";

describe("marker constants", () => {
  test("are unique sentinel strings", () => {
    expect(BEGIN_MARKER).toBe("# >>> nimbus PATH >>>");
    expect(END_MARKER).toBe("# <<< nimbus PATH <<<");
    expect(BEGIN_MARKER).not.toBe(END_MARKER);
  });
});

describe("buildMarkerBlock", () => {
  test("wraps export PATH line with markers", () => {
    const block = buildMarkerBlock("/Users/jane/.local/bin");
    expect(block).toBe(
      "# >>> nimbus PATH >>>\n" +
        'export PATH="/Users/jane/.local/bin:$PATH"\n' +
        "# <<< nimbus PATH <<<",
    );
  });

  test("escapes a path containing spaces by quoting", () => {
    const block = buildMarkerBlock("/Users/jane doe/.local/bin");
    expect(block).toContain('"/Users/jane doe/.local/bin:$PATH"');
  });

  test("rejects a path with a double-quote (defensive)", () => {
    expect(() => buildMarkerBlock('/tmp/"evil')).toThrow(/double-quote/);
  });
});

describe("stripMarkerBlock", () => {
  test("removes a single nimbus block, preserves surrounding lines", () => {
    const before = [
      "# user's existing rc",
      'export EDITOR="vim"',
      "",
      "# >>> nimbus PATH >>>",
      'export PATH="/home/x/.local/bin:$PATH"',
      "# <<< nimbus PATH <<<",
      "",
      "alias ll='ls -l'",
    ].join("\n");
    const after = stripMarkerBlock(before);
    expect(after).toBe(
      ["# user's existing rc", 'export EDITOR="vim"', "", "", "alias ll='ls -l'"].join("\n"),
    );
  });

  test("returns the input unchanged when no block is present", () => {
    const input = "# user rc\nexport X=1";
    expect(stripMarkerBlock(input)).toBe(input);
  });

  test("removes only the first block when (defensively) multiple exist", () => {
    const input = [
      "# >>> nimbus PATH >>>",
      'export PATH="/a:$PATH"',
      "# <<< nimbus PATH <<<",
      "echo middle",
      "# >>> nimbus PATH >>>",
      'export PATH="/b:$PATH"',
      "# <<< nimbus PATH <<<",
    ].join("\n");
    const out = stripMarkerBlock(input);
    expect(out).toBe(
      [
        "echo middle",
        "# >>> nimbus PATH >>>",
        'export PATH="/b:$PATH"',
        "# <<< nimbus PATH <<<",
      ].join("\n"),
    );
  });

  test("preserves trailing newline if input had one", () => {
    const input = "alpha\n# >>> nimbus PATH >>>\nx\n# <<< nimbus PATH <<<\nomega\n";
    expect(stripMarkerBlock(input)).toBe("alpha\nomega\n");
  });
});
