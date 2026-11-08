// packages/gateway/src/connectors/connector-writes/commit-paths.test.ts
// D1c: the model-door refusals of a multi-file commit (owner ruling 1, Antigravity round-1 fixes
// 3 to 8): the CI / workflow / hook / review-rule path table, the basename rules, both YAML
// spellings, safe-path-first ordering, and credential-looking content through NON-GLOBAL clones.
import { describe, expect, test } from "bun:test";
import { SECRET_PATTERNS } from "../../security/secret-patterns.ts";
import { COMMIT_INPUT_REFUSALS } from "./commit-limits.ts";
import {
  COMMIT_BIDI_REFUSAL,
  COMMIT_CREDENTIAL_REFUSAL,
  COMMIT_PATH_REFUSAL,
  COMMIT_REFUSED_BASENAMES,
  COMMIT_REFUSED_PATHS,
  COMMIT_WRITE_TOOL_IDS,
  CREDENTIAL_PATTERN_COUNT,
  commitModelRefusal,
  isRefusedCommitPath,
  looksLikeCredential,
} from "./commit-paths.ts";
import { modelWriteRefusal } from "./model-write-refusals.ts";

const GH = "github_file_commit";
const GL = "gitlab_commit_create";
const ctx = { chatops: undefined, kb: undefined } as const;
const withFiles = (...files: Array<{ path: string; content?: string }>) => ({
  message: "m",
  files: files.map((f) => ({ path: f.path, content: f.content ?? "x\n" })),
});

/** Samples built at runtime from parts, so no credential-shaped literal exists in source. */
const a = (n: number) => "a".repeat(n);
const SAMPLES: Readonly<Record<string, string>> = {
  aws_access_key: `AK${"IA"}${"Z".repeat(16)}`,
  github_pat_classic: `gh${"p_"}${a(36)}`,
  github_pat_fine_grained: `github${"_pat_"}${a(82)}`,
  github_oauth: `gh${"o_"}${a(36)}`,
  gitlab_pat: `glpat${"-"}${a(20)}`,
  slack_bot_token: `xox${"b-"}${"1".repeat(10)}-${"1".repeat(10)}-${a(24)}`,
  slack_user_token: `xox${"p-"}${"1".repeat(10)}-${"1".repeat(10)}-${"1".repeat(10)}-${a(32)}`,
  anthropic_api_key: `sk${"-ant-"}${a(32)}`,
  openai_api_key: `sk${"-"}${a(20)}`,
  stripe_live_secret: `sk${"_live_"}${a(20)}`,
  stripe_test_secret: `sk${"_test_"}${a(20)}`,
  twilio_sid: `AC${a(32)}`,
  google_api_key: `AI${"za"}${a(35)}`,
  gcp_service_account_json: `"type": "service${"_account"}"`,
  npm_token: `npm${"_"}${a(36)}`,
  docker_token: `dckr${"_pat_"}${a(27)}`,
  pem_private_key: `-----BEGIN ${"RSA "}PRIVATE KEY-----`,
  pgp_private_key: `-----BEGIN PGP ${"PRIVATE KEY"} BLOCK-----`,
  jwt: `ey${"J"}hbGci.ey${"J"}zdWIi.${a(10)}`,
  sendgrid_api_key: `SG${"."}${a(22)}.${a(43)}`,
  mailgun_api_key: `key${"-"}${a(32)}`,
};

describe("the refused path table", () => {
  test("is frozen, lower-case, without trailing slash, with a reason per entry", () => {
    expect(Object.isFrozen(COMMIT_REFUSED_PATHS)).toBe(true);
    for (const e of COMMIT_REFUSED_PATHS) {
      expect(e.entry, e.entry).toBe(e.entry.toLowerCase());
      expect(e.entry.endsWith("/"), e.entry).toBe(false);
      expect(e.why.length, e.entry).toBeGreaterThan(5);
    }
    expect(new Set(COMMIT_REFUSED_PATHS.map((e) => e.entry)).size).toBe(
      COMMIT_REFUSED_PATHS.length,
    );
  });

  test("every entry, as itself, as a nested file and in other casing, is refused on both rows", () => {
    for (const { entry } of COMMIT_REFUSED_PATHS) {
      for (const path of [entry, `${entry}/x.sh`, entry.toUpperCase(), `${entry}/a/b/c.yml`]) {
        for (const tool of [GH, GL]) {
          expect(commitModelRefusal(tool, withFiles({ path })), `${tool} ${path}`).toBe(
            COMMIT_PATH_REFUSAL,
          );
        }
      }
    }
  });

  test("the named CI files are refused in both YAML spellings", () => {
    for (const base of [
      ".gitlab-ci",
      "azure-pipelines",
      "bitbucket-pipelines",
      ".travis",
      ".drone",
    ]) {
      for (const ext of [".yml", ".yaml"]) {
        expect(isRefusedCommitPath(`${base}${ext}`), `${base}${ext}`).toBe(true);
      }
    }
    expect(isRefusedCommitPath(".circleci/config.yaml")).toBe(true);
    expect(isRefusedCommitPath(".circleci/config.yml")).toBe(true);
    expect(isRefusedCommitPath(".github/workflows/ci.yaml")).toBe(true);
    expect(isRefusedCommitPath("Jenkinsfile")).toBe(true);
  });

  test("CODEOWNERS, .gitattributes and .gitmodules are refused by basename in any directory", () => {
    expect([...COMMIT_REFUSED_BASENAMES].sort()).toEqual([
      ".gitattributes",
      ".gitmodules",
      "codeowners",
    ]);
    for (const base of [
      "CODEOWNERS",
      "codeowners",
      "CodeOwners",
      ".gitattributes",
      ".gitmodules",
    ]) {
      for (const dir of ["", ".github/", ".gitlab/", "docs/", "a/b/c/"]) {
        expect(isRefusedCommitPath(`${dir}${base}`), `${dir}${base}`).toBe(true);
      }
    }
  });

  test("prefix matching is by whole segment: lookalikes are not matched by the entry", () => {
    expect(isRefusedCommitPath(".github/workflowsx/a.yml")).toBe(false);
    expect(isRefusedCommitPath(".github/workflows-old/a.yml")).toBe(false);
    expect(isRefusedCommitPath("src/.github/workflows/a.yml")).toBe(false);
    expect(isRefusedCommitPath("docs/.husky-notes.md")).toBe(false);
    expect(isRefusedCommitPath("mycodeowners")).toBe(false);
    expect(isRefusedCommitPath("jenkinsfile.bak")).toBe(false);
    // The directory itself, as a file path, is refused.
    expect(isRefusedCommitPath(".github/workflows")).toBe(true);
    // A path that only CONTAINS a segment of an entry is allowed.
    expect(isRefusedCommitPath("src/ci/workflows/a.ts")).toBe(false);
  });

  test("a benign commit is allowed", () => {
    expect(
      commitModelRefusal(GH, withFiles({ path: "src/index.ts" }, { path: "docs/CHANGELOG.md" })),
    ).toBeUndefined();
  });

  test("an unsafe path is refused as unsafe BEFORE any path rule, so a prefix trick cannot slip past", () => {
    for (const path of [
      "./.github/workflows/x.yml",
      "a/../.github/workflows/x.yml",
      ".github//workflows/x.yml",
      ".github\\workflows\\x.yml",
      "/.github/workflows/x.yml",
      ".github/workflows/",
      ".github/workflows/x\u0000.yml",
    ]) {
      expect(commitModelRefusal(GH, withFiles({ path })), path).toBe(
        COMMIT_INPUT_REFUSALS.pathUnsafe,
      );
    }
  });

  test("only the two commit rows are touched; other rows and malformed files are left to the gate", () => {
    expect([...COMMIT_WRITE_TOOL_IDS].sort()).toEqual([GH, GL].sort());
    expect(
      commitModelRefusal("github_issue_create", withFiles({ path: ".github/workflows/a.yml" })),
    ).toBeUndefined();
    expect(commitModelRefusal(GH, { message: "m" })).toBeUndefined();
    expect(commitModelRefusal(GH, { files: "nope" })).toBeUndefined();
    expect(commitModelRefusal(GH, { files: [null, 3, { path: 4, content: 5 }] })).toBeUndefined();
    // The same path rule still applies to a well-formed entry beside a malformed one.
    expect(commitModelRefusal(GH, { files: [null, { path: "CODEOWNERS", content: "x" }] })).toBe(
      COMMIT_PATH_REFUSAL,
    );
  });

  test("the refusal is fixed text and names none of the input", () => {
    const out = commitModelRefusal(GH, withFiles({ path: ".github/workflows/zzz-marker.yml" }));
    expect(out).toBe(COMMIT_PATH_REFUSAL);
    expect(out).not.toContain("zzz-marker");
  });

  test("the model-door entry point (modelWriteRefusal) applies it; nothing else does", () => {
    expect(modelWriteRefusal(GH, withFiles({ path: ".husky/pre-commit" }), ctx)).toBe(
      COMMIT_PATH_REFUSAL,
    );
    expect(modelWriteRefusal(GL, withFiles({ path: "README.md" }), ctx)).toBeUndefined();
  });
});

describe("credential-looking content", () => {
  test("the sample table covers EVERY high-confidence pattern (a new pattern fails here)", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(SECRET_PATTERNS.map((p) => p.name).sort());
    expect(CREDENTIAL_PATTERN_COUNT).toBe(SECRET_PATTERNS.length);
  });

  test.each(Object.entries(SAMPLES))(
    "%s is refused on both rows, and its text is never echoed",
    (_name, sample) => {
      for (const tool of [GH, GL]) {
        const out = commitModelRefusal(
          tool,
          withFiles({ path: "src/a.ts", content: `x = "${sample}"\n` }),
        );
        expect(out).toBe(COMMIT_CREDENTIAL_REFUSAL);
        expect(out).not.toContain(sample);
      }
    },
  );

  test("checking the same content twice, or a credential in the SECOND file, still refuses (no shared lastIndex)", () => {
    const bad = SAMPLES["aws_access_key"] ?? "";
    const input = withFiles({ path: "a.ts", content: bad }, { path: "b.ts", content: bad });
    for (let i = 0; i < 5; i += 1)
      expect(commitModelRefusal(GH, input), String(i)).toBe(COMMIT_CREDENTIAL_REFUSAL);
    const second = withFiles({ path: "a.ts", content: "fine\n" }, { path: "b.ts", content: bad });
    for (let i = 0; i < 5; i += 1)
      expect(commitModelRefusal(GL, second), String(i)).toBe(COMMIT_CREDENTIAL_REFUSAL);
    // the shared global instances were never used: their lastIndex is untouched
    for (const p of SECRET_PATTERNS) expect(p.regex.lastIndex, p.name).toBe(0);
    expect(looksLikeCredential(bad)).toBe(true);
    expect(looksLikeCredential(bad)).toBe(true);
  });

  test("ordinary source and prose pass", () => {
    expect(looksLikeCredential("const key = process.env.API_KEY;\n// sk is short\n")).toBe(false);
    expect(
      commitModelRefusal(
        GH,
        withFiles({ path: "a.md", content: "Use a token from your settings page.\n" }),
      ),
    ).toBeUndefined();
  });

  test("a path refusal wins over a credential (checked first), and neither is built from the input", () => {
    const both = withFiles({ path: "CODEOWNERS", content: SAMPLES["aws_access_key"] ?? "" });
    expect(commitModelRefusal(GH, both)).toBe(COMMIT_PATH_REFUSAL);
  });
});

describe("bidirectional controls in new content (Trojan Source)", () => {
  const points = [
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
  ];
  test.each(points)("U+%i is refused on both rows, whichever file holds it", (cp) => {
    const ch = String.fromCodePoint(cp);
    for (const tool of [GH, GL]) {
      const input = withFiles(
        { path: "a.ts", content: "fine\n" },
        { path: "b.ts", content: `if (x) {${ch}}\n` },
      );
      expect(commitModelRefusal(tool, input)).toBe(COMMIT_BIDI_REFUSAL);
    }
  });

  test("the literal text of an escape is not a bidi control, and the refusal names nothing", () => {
    expect(
      commitModelRefusal(GH, withFiles({ path: "a.md", content: String.raw`\u{202E}` })),
    ).toBeUndefined();
    expect(COMMIT_BIDI_REFUSAL).not.toContain("202");
  });
});
