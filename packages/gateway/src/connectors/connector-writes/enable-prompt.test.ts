import { describe, expect, test } from "bun:test";

import { enableWritesPromptLines } from "./enable-prompt.ts";

describe("enableWritesPromptLines", () => {
  test("a well-formed payload lists the service, the wave, every write by state, and the fixed sentence", () => {
    expect(
      enableWritesPromptLines({
        service: "github",
        maxWave: 3,
        writes: [
          {
            toolId: "github_issue_create",
            actionType: "github.issue.create",
            wave: 2,
            offerable: true,
            state: "already_approved",
          },
          {
            toolId: "github_issue_update",
            actionType: "github.issue.update",
            wave: 2,
            offerable: true,
            state: "newly_offerable",
          },
          {
            toolId: "github_pr_merge",
            actionType: "github.pr.merge",
            wave: 3,
            offerable: false,
            state: "not_offerable",
          },
        ],
      }),
    ).toEqual([
      "Service: github",
      "Up to wave: 3",
      "  github_issue_create  github.issue.create  wave 2  (offered to the model)",
      "  github_issue_update  github.issue.update  wave 2  (new: offered after you approve)",
      "  github_pr_merge  github.pr.merge  wave 3  (not offered yet)",
      "",
      "Each call will still ask you before it runs.",
    ]);
  });

  test("a non-string service is malformed", () => {
    expect(enableWritesPromptLines({ service: 1, maxWave: 2, writes: [] })).toBeUndefined();
    expect(enableWritesPromptLines(undefined)).toBeUndefined();
  });

  test("a writes entry missing toolId is malformed", () => {
    expect(
      enableWritesPromptLines({
        service: "github",
        maxWave: 2,
        writes: [
          { actionType: "github.issue.create", wave: 2, offerable: true, state: "newly_offerable" },
        ],
      }),
    ).toBeUndefined();
  });

  test("a writes entry without a boolean offerable is malformed", () => {
    expect(
      enableWritesPromptLines({
        service: "github",
        maxWave: 2,
        writes: [
          {
            toolId: "github_issue_create",
            actionType: "github.issue.create",
            wave: 2,
            state: "not_offerable",
          },
        ],
      }),
    ).toBeUndefined();
  });

  test("a missing, unknown, inherited or contradictory state is malformed", () => {
    const base = { toolId: "github_issue_create", actionType: "github.issue.create", wave: 2 };
    for (const w of [
      { ...base, offerable: true },
      { ...base, offerable: true, state: "approved" },
      { ...base, offerable: true, state: "toString" },
      { ...base, offerable: false, state: "already_approved" },
      { ...base, offerable: false, state: "newly_offerable" },
      { ...base, offerable: true, state: "not_offerable" },
    ]) {
      expect(
        enableWritesPromptLines({ service: "github", maxWave: 2, writes: [w] }),
      ).toBeUndefined();
    }
  });

  test("a control character in a value is shown as a visible escape", () => {
    const esc = String.fromCodePoint(0x1b);
    const lines = enableWritesPromptLines({ service: `git${esc}hub`, maxWave: 3, writes: [] });
    expect(lines?.[0]).toBe(String.raw`Service: git\u{001B}hub`);
  });
});

describe("enableWritesPromptLines: the Obsidian write widening (B4b, I15)", () => {
  const APPEND = {
    toolId: "obsidian_append_to_daily_note",
    actionType: "obsidian.note.append",
    wave: 2,
    offerable: true,
    state: "newly_offerable",
  };
  const WIDENING =
    "Approving also lets the Obsidian connector's sandbox WRITE inside each Obsidian vault found under your [[filesystem.roots]] (it already reads them):";
  const HEAD = [
    "Service: obsidian",
    "Up to wave: 2",
    "  obsidian_append_to_daily_note  obsidian.note.append  wave 2  (new: offered after you approve)",
  ];
  const TAIL = ["", "Each call will still ask you before it runs."];

  test("names each root, each vault found and each skipped path with its reason", () => {
    expect(
      enableWritesPromptLines({
        service: "obsidian",
        maxWave: 2,
        writes: [APPEND],
        fileWriteScope: {
          roots: ["/home/me/notes", "/home/me/work"],
          vaults: ["/home/me/notes/vaultA"],
          skipped: [{ path: "/home/me/work/.local/share/nimbus", reason: "protected" }],
        },
      }),
    ).toEqual([
      ...HEAD,
      "",
      WIDENING,
      "  /home/me/notes",
      "  /home/me/work",
      "Vaults found now:",
      "  /home/me/notes/vaultA",
      "  not writable: /home/me/work/.local/share/nimbus (overlaps a Nimbus folder)",
      ...TAIL,
    ]);
  });

  test("no vault found: (none)", () => {
    expect(
      enableWritesPromptLines({
        service: "obsidian",
        maxWave: 2,
        writes: [APPEND],
        fileWriteScope: { roots: ["/n"], vaults: [], skipped: [] },
      }),
    ).toEqual([...HEAD, "", WIDENING, "  /n", "Vaults found now:", "  (none)", ...TAIL]);
  });

  test("every skip reason has its own wording", () => {
    const reasons = ["outside-roots", "link", "missing", "home-or-root", "protected", "nested"];
    const lines =
      enableWritesPromptLines({
        service: "obsidian",
        maxWave: 2,
        writes: [APPEND],
        fileWriteScope: {
          roots: [],
          vaults: [],
          skipped: reasons.map((reason) => ({ path: `/p/${reason}`, reason })),
        },
      }) ?? [];
    const notWritable = lines.filter((l) => l.startsWith("  not writable: "));
    expect(notWritable).toHaveLength(reasons.length);
    expect(new Set(notWritable.map((l) => l.slice(l.indexOf("(")))).size).toBe(reasons.length);
  });

  test("an absent scope still names the widening and says the folders are not known", () => {
    expect(enableWritesPromptLines({ service: "obsidian", maxWave: 2, writes: [APPEND] })).toEqual([
      ...HEAD,
      "",
      WIDENING,
      "  (the folders are not known to this gateway process)",
      ...TAIL,
    ]);
  });

  test("a malformed scope is a malformed payload", () => {
    for (const fileWriteScope of [
      "x",
      { roots: [1], vaults: [], skipped: [] },
      { roots: [], vaults: "v", skipped: [] },
      { roots: [], vaults: [], skipped: "s" },
      { roots: [], vaults: [], skipped: [{ path: "/p", reason: "other" }] },
      { roots: [], vaults: [], skipped: [{ path: 7, reason: "link" }] },
    ]) {
      expect(
        enableWritesPromptLines({
          service: "obsidian",
          maxWave: 2,
          writes: [APPEND],
          fileWriteScope,
        }),
      ).toBeUndefined();
    }
  });

  test("paths are sanitised, one per line", () => {
    const esc = String.fromCodePoint(0x1b);
    const lines =
      enableWritesPromptLines({
        service: "obsidian",
        maxWave: 2,
        writes: [APPEND],
        fileWriteScope: { roots: [`/n${esc}[2J`], vaults: [`/n/v\nfake line`], skipped: [] },
      }) ?? [];
    expect(lines.join("\n")).not.toContain(esc);
    expect(lines).not.toContain("fake line");
  });

  test("another service, or obsidian without the append offerable, never shows it", () => {
    const scope = { roots: ["/n"], vaults: ["/n/v"], skipped: [] };
    const github = enableWritesPromptLines({
      service: "github",
      maxWave: 2,
      writes: [{ ...APPEND }],
      fileWriteScope: scope,
    });
    expect(github?.join("\n")).not.toContain("sandbox WRITE");
    const notOffered = enableWritesPromptLines({
      service: "obsidian",
      maxWave: 2,
      writes: [{ ...APPEND, offerable: false, state: "not_offerable" }],
      fileWriteScope: scope,
    });
    expect(notOffered).toEqual([
      "Service: obsidian",
      "Up to wave: 2",
      "  obsidian_append_to_daily_note  obsidian.note.append  wave 2  (not offered yet)",
      ...TAIL,
    ]);
  });
});
