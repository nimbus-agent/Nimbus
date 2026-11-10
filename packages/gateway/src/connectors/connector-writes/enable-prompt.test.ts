import { describe, expect, test } from "bun:test";

import {
  enableWritesPromptLines,
  IAC_EACH_APPLY_LINE,
  IAC_NO_DOWNLOAD_LINE,
  OBSIDIAN_NOTHING_ELSE_LINE,
  OBSIDIAN_WIDENING_LINES,
} from "./enable-prompt.ts";

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
  const HEAD = [
    "Service: obsidian",
    "Up to wave: 2",
    "  obsidian_append_to_daily_note  obsidian.note.append  wave 2  (new: offered after you approve)",
  ];
  const TAIL = ["", "Each call will still ask you before it runs."];

  test("the widening is ONE FILE per vault, today's daily note, and nothing else (the owner's ruling)", () => {
    expect(OBSIDIAN_WIDENING_LINES).toEqual([
      "Approving also lets the Obsidian connector's sandbox WRITE ONE FILE per vault: today's daily note (the date in UTC), in each Obsidian vault found under your [[filesystem.roots]], and any vault made there later (it already reads them):",
    ]);
    expect(OBSIDIAN_NOTHING_ELSE_LINE).toBe(
      "Nothing else in a vault becomes writable: not .obsidian (plugins, settings), not .git, no other note, no new file.",
    );
  });

  test("names each root, each vault's daily-note pattern and each skipped path with its reason", () => {
    expect(
      enableWritesPromptLines({
        service: "obsidian",
        maxWave: 2,
        writes: [APPEND],
        fileWriteScope: {
          roots: ["/home/me/notes", "/home/me/work"],
          notes: ["/home/me/notes/vaultA/Daily/YYYY-MM-DD.md"],
          skipped: [
            { path: "/home/me/work/.local/share/nimbus", reason: "protected" },
            { path: "/home/me/notes/B/.obsidian/YYYY-MM-DD.md", reason: "config-dir" },
          ],
        },
      }),
    ).toEqual([
      ...HEAD,
      "",
      ...OBSIDIAN_WIDENING_LINES,
      "  /home/me/notes",
      "  /home/me/work",
      "Daily notes it may write (one file a day):",
      "  /home/me/notes/vaultA/Daily/YYYY-MM-DD.md",
      "  not writable: /home/me/work/.local/share/nimbus (overlaps a Nimbus folder)",
      "  not writable: /home/me/notes/B/.obsidian/YYYY-MM-DD.md (the daily-note folder is inside .obsidian or .git)",
      OBSIDIAN_NOTHING_ELSE_LINE,
      ...TAIL,
    ]);
  });

  test("no vault found: (none), and still nothing else", () => {
    expect(
      enableWritesPromptLines({
        service: "obsidian",
        maxWave: 2,
        writes: [APPEND],
        fileWriteScope: { roots: ["/n"], notes: [], skipped: [] },
      }),
    ).toEqual([
      ...HEAD,
      "",
      ...OBSIDIAN_WIDENING_LINES,
      "  /n",
      "Daily notes it may write (one file a day):",
      "  (none)",
      OBSIDIAN_NOTHING_ELSE_LINE,
      ...TAIL,
    ]);
  });

  test("every skip reason has its own wording", () => {
    const reasons = [
      "outside-roots",
      "link",
      "missing",
      "home-or-root",
      "protected",
      "nested",
      "config-dir",
      "outside-vault",
    ];
    const lines =
      enableWritesPromptLines({
        service: "obsidian",
        maxWave: 2,
        writes: [APPEND],
        fileWriteScope: {
          roots: [],
          notes: [],
          skipped: reasons.map((reason) => ({ path: `/p/${reason}`, reason })),
        },
      }) ?? [];
    const notWritable = lines.filter((l) => l.startsWith("  not writable: "));
    expect(notWritable).toHaveLength(reasons.length);
    expect(new Set(notWritable.map((l) => l.slice(l.indexOf("(")))).size).toBe(reasons.length);
  });

  test("an absent scope still names the widening and its limit, and says the files are not known", () => {
    expect(enableWritesPromptLines({ service: "obsidian", maxWave: 2, writes: [APPEND] })).toEqual([
      ...HEAD,
      "",
      ...OBSIDIAN_WIDENING_LINES,
      "  (the files are not known to this gateway process)",
      OBSIDIAN_NOTHING_ELSE_LINE,
      ...TAIL,
    ]);
  });

  test("a malformed scope is a malformed payload", () => {
    for (const fileWriteScope of [
      "x",
      { roots: [1], notes: [], skipped: [] },
      { roots: [], notes: "v", skipped: [] },
      { roots: [], vaults: [], skipped: [] },
      { roots: [], notes: [], skipped: "s" },
      { roots: [], notes: [], skipped: [{ path: "/p", reason: "other" }] },
      { roots: [], notes: [], skipped: [{ path: 7, reason: "link" }] },
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
        fileWriteScope: { roots: [`/n${esc}[2J`], notes: [`/n/v\nfake line`], skipped: [] },
      }) ?? [];
    expect(lines.join("\n")).not.toContain(esc);
    expect(lines).not.toContain("fake line");
  });

  test("another service, or obsidian without the append offerable, never shows it", () => {
    const scope = { roots: ["/n"], notes: ["/n/v/YYYY-MM-DD.md"], skipped: [] };
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

describe("enableWritesPromptLines: the iac grants (D2, I15)", () => {
  const writes = [
    {
      toolId: "iac_terraform_apply",
      actionType: "iac.terraform.apply",
      wave: 4,
      offerable: true,
      state: "newly_offerable",
    },
  ];
  const grants = {
    workdirs: ["/work/infra"],
    clouds: ["aws"],
    hosts: ["sts.amazonaws.com"],
    envNames: { aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] },
    hostScope: "per_host",
  };
  const lines = (iacGrants: unknown): string[] | undefined =>
    enableWritesPromptLines({ service: "iac", maxWave: 4, writes, iacGrants });

  test("names the directories, the credential variable names, the hosts and the fixed sentences", () => {
    const out = lines(grants) as string[];
    expect(out).toContain("Approving also lets Terraform run in these directories:");
    expect(out).toContain("  /work/infra");
    expect(out).toContain(
      "Credential for aws (environment variable names): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY",
    );
    expect(out).toContain("  sts.amazonaws.com");
    expect(out).toContain(IAC_NO_DOWNLOAD_LINE);
    expect(out).toContain(IAC_EACH_APPLY_LINE);
    expect(out.some((l) => l.startsWith("Terraform runs the code in these directories"))).toBe(
      true,
    );
    expect(out.at(-1)).toBe("Each call will still ask you before it runs.");
  });

  test("says so when no directory, no cloud and no host is granted", () => {
    const out = lines({ ...grants, workdirs: [], clouds: [], hosts: [], hostScope: "refusing" });
    expect(out).toContain("  (no directory: only CloudFormation)");
    expect(out).toContain("No cloud credential is granted.");
    expect(out).toContain("  (none)");
    expect(out?.some((l) => l.includes("Terraform will not start"))).toBe(true);
  });

  test("each host scope has its own wording", () => {
    const perPort = lines({ ...grants, hostScope: "per_port" });
    const all = lines({ ...grants, hostScope: "all_or_nothing" });
    expect(perPort?.some((l) => l.includes("any host on port 443"))).toBe(true);
    expect(all?.some((l) => l.includes("any host on any port"))).toBe(true);
  });

  test("a missing or malformed grants object is a malformed payload (refuse, never guess)", () => {
    expect(lines(undefined)).toBeUndefined();
    expect(lines(null)).toBeUndefined();
    expect(lines({ ...grants, workdirs: "x" })).toBeUndefined();
    expect(lines({ ...grants, clouds: [1] })).toBeUndefined();
    expect(lines({ ...grants, hosts: undefined })).toBeUndefined();
    expect(lines({ ...grants, envNames: null })).toBeUndefined();
    expect(lines({ ...grants, hostScope: "toString" })).toBeUndefined();
    expect(lines({ ...grants, hostScope: 3 })).toBeUndefined();
    expect(lines({ ...grants, envNames: {} })).toBeUndefined();
  });

  test("paths and names are sanitised", () => {
    const out = lines({ ...grants, workdirs: ["/w\u001b[31m"] }) as string[];
    expect(out.join("\n")).not.toContain("\u001b");
  });
});
