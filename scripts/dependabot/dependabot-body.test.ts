import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { githubSquashMessage, parseFailure } from "../release/check-pr-message-parses.ts";
import {
  isBreakingBump,
  isDependabotLogin,
  parseBumps,
  SUMMARY_MARKER,
  summaryBody,
} from "./dependabot-body.ts";

// Shapes copied from real Dependabot PRs on this repo, release notes trimmed but with the
// unbalanced parenthesis that made #1574/#1580 fail the Release-safety gate kept intact.
const NPM_GROUP_TITLE =
  "chore(deps): bump the all-minor-patch group across 1 directory with 3 updates";
const NPM_GROUP_BODY = [
  "Bumps the all-minor-patch group with 3 updates:",
  "",
  "| Package | From | To |",
  "| --- | --- | --- |",
  "| [knip](https://github.com/webpro-nl/knip/tree/HEAD/packages/knip) | `6.37.0` | `6.38.0` |",
  "| [@mastra/core](https://github.com/mastra-ai/mastra/tree/HEAD/packages/core) | `1.67.0` | `1.71.0` |",
  "| [astro](https://github.com/withastro/astro/tree/HEAD/packages/astro) | `7.3.3` | `7.3.5` |",
  "",
  "Updates `knip` from 6.37.0 to 6.38.0",
  "<details>",
  "<blockquote>",
  "<li>fix the `.run(` handling when a (nested call spans lines</li>",
  "</blockquote>",
  "</details>",
  "",
  "Updates `@mastra/core` from 1.67.0 to 1.71.0",
].join("\n");

const CARGO_GROUP_TITLE =
  "chore(deps): bump the cargo-all-minor-patch group across 1 directory with 2 updates";
const CARGO_GROUP_BODY = [
  "Bumps the cargo-all-minor-patch group with 2 updates in the /packages/ui/src-tauri directory: [tauri](https://github.com/tauri-apps/tauri) and [thiserror](https://github.com/dtolnay/thiserror).",
  "",
  "Updates `tauri` from 2.11.5 to 2.12.0",
  "<details>",
  "<pre><code>Crate:     fxhash (unmaintained</code></pre>",
  "</details>",
  "",
  "Updates `thiserror` from 2.0.20 to 2.0.21",
].join("\n");

const SINGLE_TITLE = "chore(deps): bump @mastra/mcp from 1.18.0 to 2.1.0";
const SINGLE_BODY =
  "Bumps [@mastra/mcp](https://github.com/mastra-ai/mastra/tree/HEAD/packages/mcp) from 1.18.0 to 2.1.0.\n<details>(unclosed</details>";

describe("parseBumps", () => {
  test("npm group: table rows, de-duplicated against the Updates lines, in first-seen order", () => {
    expect(parseBumps(NPM_GROUP_TITLE, NPM_GROUP_BODY)).toEqual([
      { name: "knip", from: "6.37.0", to: "6.38.0" },
      { name: "@mastra/core", from: "1.67.0", to: "1.71.0" },
      { name: "astro", from: "7.3.3", to: "7.3.5" },
    ]);
  });

  test("cargo / actions groups: Updates lines", () => {
    expect(parseBumps(CARGO_GROUP_TITLE, CARGO_GROUP_BODY)).toEqual([
      { name: "tauri", from: "2.11.5", to: "2.12.0" },
      { name: "thiserror", from: "2.0.20", to: "2.0.21" },
    ]);
  });

  test("single package: the Bumps line, trailing period dropped", () => {
    expect(parseBumps(SINGLE_TITLE, SINGLE_BODY)).toEqual([
      { name: "@mastra/mcp", from: "1.18.0", to: "2.1.0" },
    ]);
  });

  test("falls back to the title when the body names nothing", () => {
    expect(parseBumps(SINGLE_TITLE, "")).toEqual([
      { name: "@mastra/mcp", from: "1.18.0", to: "2.1.0" },
    ]);
    expect(
      parseBumps("chore(deps): bump log from 0.4.33 to 0.4.34 in /packages/ui/src-tauri", ""),
    ).toEqual([{ name: "log", from: "0.4.33", to: "0.4.34" }]);
  });

  test("nothing recognisable reads as empty — never as 'no changes'", () => {
    expect(parseBumps("chore: something else", "free text")).toEqual([]);
  });

  test("release-note text that merely LOOKS like an Updates line inside a blockquote is not read", () => {
    const body = "Updates `a` from 1.0.0 to 1.0.1\n> Updates `b` from 1.0.0 to 9.0.0";
    expect(parseBumps("t", body).map((b) => b.name)).toEqual(["a"]);
  });
});

describe("isBreakingBump", () => {
  const bump = (from: string, to: string) => isBreakingBump({ name: "x", from, to });
  test("a major move is breaking; minor and patch are not", () => {
    expect(bump("1.18.0", "2.1.0")).toBe(true);
    expect(bump("1.67.0", "1.71.0")).toBe(false);
    expect(bump("2.0.20", "2.0.21")).toBe(false);
  });
  test("below 1.0.0 a minor move is breaking, a patch is not", () => {
    expect(bump("0.4.33", "0.5.0")).toBe(true);
    expect(bump("0.4.33", "0.4.34")).toBe(false);
  });
  test("a leading v is tolerated; an unreadable version counts as breaking", () => {
    expect(bump("v4.38.1", "v4.38.2")).toBe(false);
    expect(bump("main", "4.0.0")).toBe(true);
  });
});

describe("summaryBody", () => {
  const cases: Array<[string, string, string]> = [
    ["npm group", NPM_GROUP_TITLE, NPM_GROUP_BODY],
    ["cargo group", CARGO_GROUP_TITLE, CARGO_GROUP_BODY],
    ["single package", SINGLE_TITLE, SINGLE_BODY],
  ];

  test("the REAL #1580 body: it fails the real parser, its summary passes and names all 17 bumps", () => {
    // Dependabot's own description of #1580, recovered from the PR's edit history. It failed
    // the Release-safety gate in CI; the premise is asserted first so the summary assertion
    // cannot pass on a fixture that never reproduced the failure.
    const title = "chore(deps): bump the all-minor-patch group across 1 directory with 17 updates";
    const body = readFileSync(
      join(import.meta.dir, "fixtures", "pr-1580-original-body.txt"),
      "utf8",
    );
    expect(parseFailure(githubSquashMessage(title, body, 1580))).toBeDefined();
    const summary = summaryBody(title, body);
    expect(parseBumps(title, body)).toHaveLength(17);
    expect(parseFailure(githubSquashMessage(title, summary ?? "", 1580))).toBeUndefined();
  });

  test.each(cases)("%s: the summary parses", (_label, title, body) => {
    const summary = summaryBody(title, body);
    expect(summary).toBeDefined();
    expect(parseFailure(githubSquashMessage(title, summary ?? "", 1582))).toBeUndefined();
  });

  test("single package: the raw notes fail and the summary does not — the shape #1575 carried", () => {
    expect(parseFailure(githubSquashMessage(SINGLE_TITLE, SINGLE_BODY, 1575))).toBeDefined();
    expect(
      parseFailure(
        githubSquashMessage(SINGLE_TITLE, summaryBody(SINGLE_TITLE, SINGLE_BODY) ?? "", 1575),
      ),
    ).toBeUndefined();
  });

  test.each(cases)(
    "%s: a fixed point — summarising the summary changes nothing",
    (_label, title, body) => {
      const once = summaryBody(title, body) ?? "";
      expect(once.startsWith(`${SUMMARY_MARKER}\n`)).toBe(true);
      expect(summaryBody(title, once)).toBe(once);
      expect(parseBumps(title, once)).toEqual(parseBumps(title, body));
    },
  );

  test("contains no parenthesis at all, whatever the dependency names", () => {
    expect(summaryBody(NPM_GROUP_TITLE, NPM_GROUP_BODY)).not.toMatch(/[()]/);
  });

  test("undefined when no bump can be read, so the PR is left as Dependabot wrote it", () => {
    expect(summaryBody("chore: something else", "free text")).toBeUndefined();
  });
});

describe("isDependabotLogin", () => {
  test("accepts both spellings GitHub uses — REST webhook payloads and gh's GraphQL output", () => {
    expect(isDependabotLogin("dependabot[bot]")).toBe(true);
    expect(isDependabotLogin("app/dependabot")).toBe(true);
  });
  test("nothing else", () => {
    for (const login of [undefined, "", "dependabot", "someone", "app/dependabot-preview"]) {
      expect(isDependabotLogin(login)).toBe(false);
    }
  });
});
