// Phase 9.7 D3b: the seven deploy-trigger and mobile-release rows (connectors 0.10.0): their
// template keys against the installed source, their readers, the Netlify and TestFlight guards,
// their confirm texts and the model-door refusals. Reply fixtures follow the connector's own
// projections for `vercel_project_production_get`, `netlify_deploy_list`, `bitrise_build_latest`,
// `codemagic_build_latest`, `testflight_beta_groups_list` and `testflight_build_groups_get`
// (checked against the installed source below). The tests named "documented shape" use the
// vendors' documented JSON for `vercel_get`, `netlify_get` and `firebase_get`, which the connector
// returns raw and which are NOT verified against a live account.
import { describe, expect, test } from "bun:test";
import { dirname } from "node:path";

import { stripComments } from "../../../../../scripts/structure-audit/lib.ts";
import { isReadOnlyToolId } from "../../share/read-tool-registry.ts";
import { isConnectorWriteToolId } from "../connector-write-registry.ts";
import {
  declaredInputKeys,
  withSchemaArgumentDeclarations,
} from "../testing/connector-schema-source.ts";
import {
  installedConnectorsPackageRoot,
  readConnectorPackageSources,
  scanWriteToolRegistrations,
} from "../testing/connector-write-registrations.ts";
import { beforeReaderProblems } from "./before-reader.ts";
import { renderConfirmText } from "./confirm.ts";
import { DEPLOY_MOBILE_ROWS } from "./deploy-mobile.ts";
import {
  FIREBASE_TESTER_EMAIL_REFUSAL,
  NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL,
} from "./deploy-refusals.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { modelWriteRefusal } from "./model-write-refusals.ts";
import {
  type BeforeStateField,
  beforeReaderArgKeys,
  type ConnectorWriteRow,
  pickBeforeReaderArgs,
  previewTemplateKeys,
} from "./types.ts";

const IDS = [
  "vercel_deployment_redeploy",
  "vercel_deployment_promote",
  "netlify_build_trigger",
  "bitrise_build_trigger",
  "codemagic_build_trigger",
  "testflight_build_distribute",
  "firebase_app_distribution_distribute",
] as const;
type Id = (typeof IDS)[number];

/** The input keys the installed 0.10.0 source declares for each write (sorted). */
const DECLARED: Readonly<Record<Id, readonly string[]>> = {
  vercel_deployment_redeploy: ["deploymentId", "target", "withLatestCommit"],
  vercel_deployment_promote: ["deploymentId", "projectId"],
  netlify_build_trigger: ["branch", "clearCache", "production", "siteId"],
  bitrise_build_trigger: ["appSlug", "branch", "workflow"],
  codemagic_build_trigger: ["appId", "branch", "workflowId"],
  testflight_build_distribute: ["appId", "betaGroupIds", "buildId"],
  firebase_app_distribution_distribute: ["appId", "groupAliases", "releaseId", "testerEmails"],
};

/** The reader of each row: the read tool, the keys `args` sends, the second read's tool and keys. */
const READERS: Readonly<
  Record<
    Id,
    {
      readonly tool: string;
      readonly sent: readonly string[];
      readonly also?: { readonly tool: string; readonly sent: readonly string[] };
    }
  >
> = {
  vercel_deployment_redeploy: { tool: "vercel_get", sent: ["idOrUrl"] },
  vercel_deployment_promote: {
    tool: "vercel_project_production_get",
    sent: ["projectId"],
    also: { tool: "vercel_get", sent: ["idOrUrl"] },
  },
  netlify_build_trigger: {
    tool: "netlify_get",
    sent: ["siteId"],
    also: { tool: "netlify_deploy_list", sent: ["perPage", "siteId"] },
  },
  bitrise_build_trigger: { tool: "bitrise_build_latest", sent: ["appSlug", "branch", "workflow"] },
  codemagic_build_trigger: {
    tool: "codemagic_build_latest",
    sent: ["appId", "branch", "workflowId"],
  },
  testflight_build_distribute: {
    tool: "testflight_beta_groups_list",
    sent: ["appId", "limit"],
    also: { tool: "testflight_build_groups_get", sent: ["buildId"] },
  },
  firebase_app_distribution_distribute: { tool: "firebase_get", sent: ["appId", "releaseId"] },
};

const MIN: Readonly<Record<Id, Record<string, unknown>>> = {
  vercel_deployment_redeploy: { deploymentId: "dpl_abcdefgh12345678", target: "production" },
  vercel_deployment_promote: { projectId: "prj_0123456789abcdef", deploymentId: "dpl_new00000001" },
  netlify_build_trigger: { siteId: "11111111-2222-3333-4444-555555555555", branch: "feature-x" },
  bitrise_build_trigger: {
    appSlug: "app-slug-1234abcd",
    branch: "release/1.2",
    workflow: "deploy",
  },
  codemagic_build_trigger: { appId: "5f0000000000000000000abc", workflowId: "ios", branch: "main" },
  testflight_build_distribute: {
    appId: "1234567890",
    buildId: "b-0000-1111-2222-3333",
    betaGroupIds: ["g-int", "g-ext"],
  },
  firebase_app_distribution_distribute: {
    appId: "1:123456789:android:abc",
    releaseId: "rel_1",
    groupAliases: ["qa"],
  },
};

const sources = readConnectorPackageSources(installedConnectorsPackageRoot());
const scan = scanWriteToolRegistrations(sources);
const codeByFile = new Map(sources.map((s) => [s.rel, stripComments(s.text)]));

function writeRegistration(toolId: string): { file: string; keys: string[] } {
  const reg = scan.registrations.find((r) => r.id === toolId);
  if (reg === undefined)
    throw new Error(`${toolId}: not a registered write in the installed package`);
  const code = codeByFile.get(reg.file) ?? "";
  const call = code.slice(reg.span[0], reg.span[1] + 1);
  return {
    file: reg.file,
    keys: declaredInputKeys(withSchemaArgumentDeclarations(sources, code, call)),
  };
}

function rowOf(toolId: string): ConnectorWriteRow {
  const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === toolId);
  if (r === undefined) throw new Error(`no row ${toolId}`);
  return r;
}

const mcp = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });

/** The before-state fields the row's selector returns for these replies. */
function state(
  id: Id,
  input: Record<string, unknown>,
  reply: unknown,
  alsoReply?: unknown,
): readonly BeforeStateField[] {
  const reader = rowOf(id).before;
  if (reader === undefined) throw new Error(id);
  const picked = pickBeforeReaderArgs(beforeReaderArgKeys(reader), input);
  return reader.select(reply, picked, alsoReply);
}

const asText = (f: readonly BeforeStateField[]): string[] => f.map((x) => `${x.label}: ${x.value}`);

describe("D3b rows: shape and offerability", () => {
  test("seven Wave 4 mesh rows, each with a preview, a reader and a confirm, all offerable and none a bare write", () => {
    expect(DEPLOY_MOBILE_ROWS.map((r) => r.toolId)).toEqual([...IDS]);
    for (const id of IDS) {
      const r = rowOf(id);
      expect(r.wave, id).toBe(4);
      expect(r.transport, id).toBe("mesh");
      expect(r.preview, id).toBeDefined();
      expect(r.before, id).toBeDefined();
      expect(r.confirm, id).toBeDefined();
      expect(r.bound, id).toBeUndefined();
      expect(isConnectorWriteToolId(id), id).toBe(true);
      expect(isModelOfferableRow(r), id).toBe(true);
      expect(beforeReaderProblems(r), id).toEqual([]);
    }
  });

  test("the template keys equal the installed schema keys, and the spelled-out keys equal the source", () => {
    for (const id of IDS) {
      const declared = writeRegistration(id).keys;
      expect(declared.length, `${id}: the schema shape was not recognised`).toBeGreaterThan(0);
      expect(
        [...declared].sort((a, b) => a.localeCompare(b)),
        id,
      ).toEqual([...DECLARED[id]]);
      expect(
        [...previewTemplateKeys(rowOf(id).preview ?? { target: "", summary: "", fields: [] })].sort(
          (a, b) => a.localeCompare(b),
        ),
        id,
      ).toEqual([...DECLARED[id]]);
    }
  });

  test("every reader is a registered read of the SAME connector, a read the dispatcher accepts, and sends only keys the read declares", () => {
    for (const id of IDS) {
      const reader = rowOf(id).before;
      if (reader === undefined) throw new Error(id);
      const want = READERS[id];
      const reads = [
        { read: reader, want },
        ...(reader.also === undefined || want.also === undefined
          ? []
          : [{ read: reader.also, want: want.also }]),
      ];
      expect(reader.also === undefined, id).toBe(want.also === undefined);
      for (const { read, want: w } of reads) {
        expect(read.tool, id).toBe(w.tool);
        expect(isReadOnlyToolId(read.tool), `${id}: ${read.tool}`).toBe(true);
        expect(isConnectorWriteToolId(read.tool), id).toBe(false);
        const sent = read.args(MIN[id]);
        expect(sent, `${id}: args refused the minimal input`).toBeDefined();
        expect(
          Object.keys(sent ?? {}).sort((a, b) => a.localeCompare(b)),
          id,
        ).toEqual([...w.sent]);
        // The read is registered in the same connector directory as the write.
        const dir = dirname(dirname(writeRegistration(id).file));
        const file = sources.find(
          (s) => dirname(dirname(s.rel)) === dir && s.text.includes(`"${read.tool}"`),
        );
        expect(file, `${id}: ${read.tool} is not registered in ${dir}`).toBeDefined();
      }
    }
  });

  test("the two _latest readers are read-only only by the explicit id list", () => {
    expect(isReadOnlyToolId("bitrise_build_latest")).toBe(true);
    expect(isReadOnlyToolId("codemagic_build_latest")).toBe(true);
    expect(isReadOnlyToolId("vercel_deployment_latest")).toBe(false);
  });

  test("the connector projections the fixtures follow still carry these keys (installed source)", () => {
    const text = (rel: string): string => sources.find((s) => s.rel.endsWith(rel))?.text ?? "";
    for (const k of ["slug", "status_text", "branch", "triggered_workflow", "triggered_at"]) {
      expect(text("bitrise/src/tools.ts"), k).toContain(k);
    }
    for (const k of ["workflowId", "index", "createdAt", "finishedAt", "scanned"]) {
      expect(text("codemagic/src/tools.ts"), k).toContain(k);
    }
    for (const k of ["isInternalGroup", "publicLinkEnabled", "groups"]) {
      expect(text("testflight/src/tools.ts"), k).toContain(k);
    }
    for (const k of ["commit_ref", "context", "published_at", "error_message"]) {
      expect(text("netlify/src/tools.ts"), k).toContain(k);
    }
    for (const k of ["readyState", "production", "projectId"]) {
      expect(text("vercel/src/tools.ts"), k).toContain(k);
    }
    // The production branch the Netlify guard reads is the one the connector's own search reads.
    expect(text("netlify/src/search-filter.ts")).toContain('"build_settings", "repo_branch"');
  });
});

describe("D3b confirm texts", () => {
  const text = (id: Id, input: Record<string, unknown>) => {
    const r = renderConfirmText(rowOf(id), input);
    return r.ok ? r.text : r.reason;
  };

  test("each renders for a realistic input", () => {
    expect(text("vercel_deployment_redeploy", MIN.vercel_deployment_redeploy)).toBe(
      "vercel/redeploy 12345678 production",
    );
    expect(text("vercel_deployment_promote", MIN.vercel_deployment_promote)).toBe(
      "vercel/promote 89abcdef 00000001",
    );
    expect(text("netlify_build_trigger", MIN.netlify_build_trigger)).toBe("netlify/build 55555555");
    expect(text("bitrise_build_trigger", MIN.bitrise_build_trigger)).toBe(
      "bitrise/build 1234abcd release/1.2 deploy",
    );
    expect(text("codemagic_build_trigger", MIN.codemagic_build_trigger)).toBe(
      "codemagic/build 00000abc ios main",
    );
    expect(text("testflight_build_distribute", MIN.testflight_build_distribute)).toBe(
      "testflight/distribute 1234567890 222-3333",
    );
    expect(
      text("firebase_app_distribution_distribute", MIN.firebase_app_distribution_distribute),
    ).toBe("firebase/distribute 1:123456789:android:abc rel_1");
  });

  test("a Netlify production publish types a different text from a branch build", () => {
    const branch = text("netlify_build_trigger", MIN.netlify_build_trigger);
    const prod = text("netlify_build_trigger", {
      siteId: MIN.netlify_build_trigger.siteId,
      production: true,
    });
    expect(prod).toBe("netlify/publish production 55555555");
    expect(prod).not.toBe(branch);
  });

  test("a value holding a space is refused, not shortened", () => {
    expect(
      text("bitrise_build_trigger", { ...MIN.bitrise_build_trigger, branch: "a b" }),
    ).toContain("confirm:");
    expect(
      text("codemagic_build_trigger", { ...MIN.codemagic_build_trigger, workflowId: "a b" }),
    ).toContain("confirm:");
  });

  test("a branch long enough to pass 200 characters is refused as too long to type", () => {
    expect(
      text("bitrise_build_trigger", { ...MIN.bitrise_build_trigger, branch: "b".repeat(220) }),
    ).toBe("confirm: the target is too long to type");
  });
});

describe("D3b readers: golden before-state lines", () => {
  // documented shape: `vercel_get` returns the vendor's deployment object as is.
  const VERCEL_DEPLOYMENT = {
    id: "dpl_abcdefgh12345678",
    name: "web",
    projectId: "prj_0123456789abcdef",
    target: null,
    readyState: "READY",
    url: "web-git-feature-acme.vercel.app",
    createdAt: 1_762_000_000_000,
    meta: { githubCommitMessage: "Fix the login redirect" },
  };

  test("vercel redeploy (documented shape of vercel_get): the source, then the asked target and effect", () => {
    expect(
      asText(
        state("vercel_deployment_redeploy", MIN.vercel_deployment_redeploy, mcp(VERCEL_DEPLOYMENT)),
      ),
    ).toEqual([
      "Source deployment: dpl_abcdefgh12345678",
      "Source project: web",
      "Source target: preview",
      "Source state: READY",
      "Source URL: web-git-feature-acme.vercel.app",
      "Source created: 2025-11-01T12:26:40.000Z",
      "Source commit message: Fix the login redirect",
      "Asked: preview -> production",
      "Effect: a PRODUCTION build: it replaces the live site once ready; the deployment it replaces is not shown (the request names no project)",
    ]);
  });

  test("vercel redeploy: a preview request says it does not replace the live site", () => {
    const out = asText(
      state(
        "vercel_deployment_redeploy",
        { deploymentId: "d", target: "preview" },
        mcp(VERCEL_DEPLOYMENT),
      ),
    );
    expect(out.at(-1)).toBe("Effect: a preview build: it does not replace the live site");
  });

  test("vercel redeploy: a hostile commit message is capped and never leaves the label alone", () => {
    const out = state(
      "vercel_deployment_redeploy",
      MIN.vercel_deployment_redeploy,
      mcp({ ...VERCEL_DEPLOYMENT, meta: { githubCommitMessage: "x".repeat(1500) } }),
    );
    const commit = out.find((f) => f.label === "Source commit message")?.value ?? "";
    expect(commit.endsWith("(500 more characters not shown)")).toBe(true);
  });

  test("vercel promote: the connector's projection of the current production, beside the deployment to promote", () => {
    const project = {
      projectId: "prj_0123456789abcdef",
      name: "web",
      production: {
        id: "dpl_current0001",
        url: "web-acme.vercel.app",
        readyState: "READY",
        createdAt: 1_761_000_000_000,
      },
    };
    expect(
      asText(
        state(
          "vercel_deployment_promote",
          MIN.vercel_deployment_promote,
          mcp(project),
          mcp(VERCEL_DEPLOYMENT),
        ),
      ),
    ).toEqual([
      "Project: prj_0123456789abcdef",
      "Project name: web",
      "Current production: dpl_current0001",
      "Current production URL: web-acme.vercel.app",
      "Current production state: READY",
      "Current production since: 2025-10-20T22:40:00.000Z",
      "Will become production: deployment: dpl_abcdefgh12345678",
      "Will become production: project: web",
      "Will become production: target: preview",
      "Will become production: state: READY",
      "Will become production: URL: web-git-feature-acme.vercel.app",
      "Will become production: created: 2025-11-01T12:26:40.000Z",
      "Will become production: commit message: Fix the login redirect",
    ]);
  });

  test("vercel promote: no production yet reads (none); promoting production again, or another project's deployment, says so", () => {
    const none = { projectId: "prj_0123456789abcdef", name: "web", production: null };
    expect(
      asText(
        state(
          "vercel_deployment_promote",
          MIN.vercel_deployment_promote,
          mcp(none),
          mcp(VERCEL_DEPLOYMENT),
        ),
      ),
    ).toContain("Current production: (none)");
    const current = { ...none, production: { id: "dpl_new00000001" } };
    expect(
      asText(
        state(
          "vercel_deployment_promote",
          MIN.vercel_deployment_promote,
          mcp(current),
          mcp(VERCEL_DEPLOYMENT),
        ),
      ),
    ).toContain("Note: this deployment is production already");
    expect(
      asText(
        state(
          "vercel_deployment_promote",
          MIN.vercel_deployment_promote,
          mcp(none),
          mcp({ ...VERCEL_DEPLOYMENT, projectId: "prj_other" }),
        ),
      ),
    ).toContain("Note: this deployment belongs to a different project than the one named");
  });

  // documented shape: `netlify_get` returns the vendor's site object as is.
  const NETLIFY_SITE = {
    id: "11111111-2222-3333-4444-555555555555",
    name: "acme-web",
    url: "http://acme-web.netlify.app",
    ssl_url: "https://acme-web.netlify.app",
    build_settings: { repo_url: "https://github.com/acme/web", repo_branch: "main" },
    published_deploy: { id: "dep1", state: "ready", branch: "main", commit_ref: "abc123" },
  };
  // The connector's own projection of `netlify_deploy_list`.
  const NETLIFY_DEPLOYS = [
    {
      id: "dep1",
      state: "ready",
      branch: "main",
      context: "production",
      commit_ref: "abc123",
      created_at: "2026-11-01T10:00:00Z",
      published_at: "2026-11-01T10:02:00Z",
      error_message: null,
    },
    {
      id: "dep0",
      state: "error",
      branch: "feature-x",
      context: "branch-deploy",
      commit_ref: "def456",
      created_at: "2026-10-31T10:00:00Z",
      published_at: null,
      error_message: "build failed",
    },
  ];

  test("netlify (documented shape of netlify_get + the connector's deploy projection): site, production branch, live deploy, recent deploys", () => {
    expect(
      asText(
        state(
          "netlify_build_trigger",
          MIN.netlify_build_trigger,
          mcp(NETLIFY_SITE),
          mcp(NETLIFY_DEPLOYS),
        ),
      ),
    ).toEqual([
      "Site: acme-web",
      "URL: https://acme-web.netlify.app",
      "Production branch: main",
      "Live deploy: dep1 | ready | main | abc123",
      "Effect: a branch deploy: it is not published to the live site",
      "Recent deploys: 1. ready | production | main | abc123 | 2026-11-01T10:00:00Z; 2. error | branch-deploy | feature-x | def456 | 2026-10-31T10:00:00Z",
    ]);
  });

  test("netlify: the effect line names a production publish, and the production branch as a branch", () => {
    const prod = asText(
      state(
        "netlify_build_trigger",
        { siteId: "s", production: true },
        mcp(NETLIFY_SITE),
        mcp(NETLIFY_DEPLOYS),
      ),
    );
    expect(prod).toContain(
      "Effect: PRODUCTION: the build is published to the live site when it succeeds",
    );
    const onMain = asText(
      state(
        "netlify_build_trigger",
        { siteId: "s", branch: "main" },
        mcp(NETLIFY_SITE),
        mcp(NETLIFY_DEPLOYS),
      ),
    );
    expect(onMain).toContain(
      "Effect: this is the production branch: it would be published to the live site",
    );
  });

  test("bitrise (the connector's projection): the latest build of the branch and workflow, or none", () => {
    const build = {
      build: {
        slug: "build-slug-1",
        status: 1,
        status_text: "success",
        branch: "release/1.2",
        triggered_workflow: "deploy",
        triggered_at: "2026-11-01T09:00:00Z",
        finished_at: "2026-11-01T09:12:00Z",
      },
    };
    expect(asText(state("bitrise_build_trigger", MIN.bitrise_build_trigger, mcp(build)))).toEqual([
      "Latest build: build-slug-1",
      "Status: success",
      "Branch: release/1.2",
      "Workflow: deploy",
      "Triggered: 2026-11-01T09:00:00Z",
      "Finished: 2026-11-01T09:12:00Z",
    ]);
    expect(
      asText(state("bitrise_build_trigger", MIN.bitrise_build_trigger, mcp({ build: null }))),
    ).toEqual(["Latest build: (none: no build of this branch and workflow yet)"]);
  });

  test("bitrise: a reply with no build key is unavailable, not none", () => {
    expect(() => state("bitrise_build_trigger", MIN.bitrise_build_trigger, mcp({}))).toThrow();
  });

  test("codemagic (the connector's projection; its field names are unverified upstream): the latest build, or none with the scan count", () => {
    const build = {
      build: {
        id: "build-id-1",
        status: "finished",
        branch: "main",
        workflowId: "ios",
        index: 42,
        createdAt: "2026-11-01T09:00:00Z",
        startedAt: "2026-11-01T09:01:00Z",
        finishedAt: "2026-11-01T09:20:00Z",
      },
      scanned: 50,
    };
    expect(
      asText(state("codemagic_build_trigger", MIN.codemagic_build_trigger, mcp(build))),
    ).toEqual([
      "Latest build: build-id-1",
      "Status: finished",
      "Branch: main",
      "Workflow: ios",
      "Build number: 42",
      "Created: 2026-11-01T09:00:00Z",
      "Finished: 2026-11-01T09:20:00Z",
    ]);
    expect(
      asText(
        state(
          "codemagic_build_trigger",
          MIN.codemagic_build_trigger,
          mcp({ build: null, scanned: 50 }),
        ),
      ),
    ).toEqual(["Latest build: (none of this workflow and branch in the app's last 50 builds)"]);
  });

  // The connector's own projection of both TestFlight reads.
  const GROUPS = {
    groups: [
      { id: "g-int", name: "Internal QA", isInternalGroup: true, publicLinkEnabled: false },
      { id: "g-ext", name: "Public Beta", isInternalGroup: false, publicLinkEnabled: true },
      { id: "g-other", name: "Partners", isInternalGroup: false, publicLinkEnabled: false },
    ],
  };
  const BUILD_GROUPS = { groups: [{ id: "g-other", name: "Partners" }] };

  test("testflight: each target group's name, kind and public-link state, then the groups the build is already in", () => {
    expect(
      asText(
        state(
          "testflight_build_distribute",
          MIN.testflight_build_distribute,
          mcp(GROUPS),
          mcp(BUILD_GROUPS),
        ),
      ),
    ).toEqual([
      "Target group g-int: Internal QA (internal; public link off)",
      "Target group g-ext: Public Beta (external; PUBLIC LINK ON (anyone with the link can join))",
      "Build already in: Partners",
    ]);
  });

  test("testflight: a target that is not a group of the app says so, and twenty targets stay under the field cap", () => {
    const out = asText(
      state(
        "testflight_build_distribute",
        { appId: "1", buildId: "b", betaGroupIds: ["nope"] },
        mcp(GROUPS),
        mcp({ groups: [] }),
      ),
    );
    expect(out).toEqual(["Target group nope: NOT a group of this app", "Build already in: (none)"]);
    const ids = Array.from({ length: 20 }, (_, i) => `g${String(i)}`);
    const many = state(
      "testflight_build_distribute",
      { appId: "1", buildId: "b", betaGroupIds: ids },
      mcp({
        groups: ids.map((id) => ({
          id,
          name: id,
          isInternalGroup: false,
          publicLinkEnabled: true,
        })),
      }),
      mcp({ groups: [] }),
    );
    expect(many.length).toBe(14);
    const folded = many.find((f) => f.label === "More target groups (8)")?.value ?? "";
    expect(folded).toContain("g19: g19 (external; PUBLIC LINK ON");
  });

  // documented shape: `firebase_get` returns the vendor's release object as is.
  test("firebase (documented shape of firebase_get): the release, then the fixed 'cannot say who already has it' line", () => {
    const release = {
      name: "projects/123/apps/1:123:android:abc/releases/rel_1",
      displayVersion: "2.4.0",
      buildVersion: "240",
      createTime: "2026-11-01T08:00:00Z",
      releaseNotes: { text: "Bug fixes" },
    };
    expect(
      asText(
        state(
          "firebase_app_distribution_distribute",
          MIN.firebase_app_distribution_distribute,
          mcp(release),
        ),
      ),
    ).toEqual([
      "Display version: 2.4.0",
      "Build version: 240",
      "Created: 2026-11-01T08:00:00Z",
      "Release notes: Bug fixes",
      "Already sent: Firebase cannot say who already has this release: every group and tester above is sent it",
    ]);
    expect(() =>
      state(
        "firebase_app_distribution_distribute",
        MIN.firebase_app_distribution_distribute,
        mcp({}),
      ),
    ).toThrow();
  });
});

describe("D3b guards (the reader refuses before any prompt, fail closed)", () => {
  const netlify = () => {
    const g = rowOf("netlify_build_trigger").before?.guard;
    if (g === undefined) throw new Error("no guard");
    return g;
  };
  const site = (branch: unknown) =>
    mcp({ name: "n", build_settings: branch === undefined ? {} : { repo_branch: branch } });
  const pick = (o: Record<string, unknown>) =>
    pickBeforeReaderArgs(["siteId", "branch", "production"], o);

  test("netlify: a branch equal to the production branch refuses; another allows", () => {
    const g = netlify();
    expect(g.appliesTo(pick({ siteId: "s", branch: "main" }), undefined)).toBe(true);
    expect(
      g.allows(site("main"), pick({ siteId: "s", branch: "main" }), undefined, undefined),
    ).toBe(false);
    expect(
      g.allows(site("main"), pick({ siteId: "s", branch: "feature" }), undefined, undefined),
    ).toBe(true);
  });

  test("netlify: the long ref form cannot slip past, and a case change is a different branch", () => {
    const g = netlify();
    expect(
      g.allows(
        site("main"),
        pick({ siteId: "s", branch: "refs/heads/main" }),
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect(
      g.allows(
        site("refs/heads/main"),
        pick({ siteId: "s", branch: "main" }),
        undefined,
        undefined,
      ),
    ).toBe(false);
    expect(
      g.allows(site("main"), pick({ siteId: "s", branch: "Main" }), undefined, undefined),
    ).toBe(true);
  });

  test("netlify: an unreadable production branch refuses (absent, blank, not a string, a bad reply)", () => {
    const g = netlify();
    const p = pick({ siteId: "s", branch: "feature" });
    for (const reply of [
      site(undefined),
      site(""),
      site("  "),
      site(7),
      mcp([]),
      "text",
      undefined,
    ]) {
      let allowed: boolean;
      try {
        allowed = g.allows(reply, p, undefined, undefined);
      } catch {
        allowed = false;
      }
      expect(allowed).toBe(false);
    }
  });

  test("netlify: a production publish (no branch) is not the guard's business", () => {
    expect(netlify().appliesTo(pick({ siteId: "s", production: true }), undefined)).toBe(false);
  });

  const tf = () => {
    const g = rowOf("testflight_build_distribute").before?.guard;
    if (g === undefined) throw new Error("no guard");
    return g;
  };
  const tfPick = (ids: unknown) =>
    pickBeforeReaderArgs(["appId", "betaGroupIds"], { appId: "1", betaGroupIds: ids });
  const groups = (g: unknown[]) => mcp({ groups: g });

  test("testflight: a public-link group refuses, a private one allows, an absent one refuses", () => {
    const g = tf();
    const list = groups([
      { id: "a", name: "A", isInternalGroup: false, publicLinkEnabled: false },
      { id: "b", name: "B", isInternalGroup: false, publicLinkEnabled: true },
    ]);
    expect(g.allows(list, tfPick(["a"]), undefined, undefined)).toBe(true);
    expect(g.allows(list, tfPick(["b"]), undefined, undefined)).toBe(false);
    expect(g.allows(list, tfPick(["a", "b"]), undefined, undefined)).toBe(false);
    expect(g.allows(list, tfPick(["missing"]), undefined, undefined)).toBe(false);
    expect(g.allows(list, tfPick(["a", "missing"]), undefined, undefined)).toBe(false);
  });

  test("testflight: an unreadable link state refuses, except an internal group, which has none", () => {
    const g = tf();
    const list = groups([
      { id: "i", name: "I", isInternalGroup: true },
      { id: "x", name: "X", isInternalGroup: false },
      { id: "n", name: "N", isInternalGroup: true, publicLinkEnabled: null },
      { id: "s", name: "S", isInternalGroup: false, publicLinkEnabled: "false" },
    ]);
    expect(g.allows(list, tfPick(["i"]), undefined, undefined)).toBe(true);
    expect(g.allows(list, tfPick(["n"]), undefined, undefined)).toBe(true);
    expect(g.allows(list, tfPick(["x"]), undefined, undefined)).toBe(false);
    expect(g.allows(list, tfPick(["s"]), undefined, undefined)).toBe(false);
  });

  test("testflight: malformed targets or a malformed reply refuse", () => {
    const g = tf();
    const list = groups([{ id: "a", isInternalGroup: false, publicLinkEnabled: false }]);
    for (const ids of [[], "a", [1], [""], undefined, null]) {
      expect(g.allows(list, tfPick(ids), undefined, undefined), JSON.stringify(ids)).toBe(false);
    }
    expect(() => g.allows(undefined, tfPick(["a"]), undefined, undefined)).toThrow();
  });
});

describe("D3b model-door refusals", () => {
  const ctx = { chatops: undefined, kb: undefined };
  const refuse = (id: string, input: Record<string, unknown>) => modelWriteRefusal(id, input, ctx);

  test("netlify: neither or both of branch and production is refused with a fixed text", () => {
    expect(refuse("netlify_build_trigger", { siteId: "s" })).toBe(
      NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL,
    );
    expect(refuse("netlify_build_trigger", { siteId: "s", branch: "x", production: true })).toBe(
      NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL,
    );
    expect(refuse("netlify_build_trigger", { siteId: "s", production: false })).toBe(
      NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL,
    );
    expect(refuse("netlify_build_trigger", { siteId: "s", branch: "x" })).toBeUndefined();
    expect(refuse("netlify_build_trigger", { siteId: "s", production: true })).toBeUndefined();
    expect(refuse("netlify_build_trigger", { siteId: "s", branch: null })).toContain(
      "cannot be null",
    );
  });

  test("firebase: tester emails are refused (any non-empty or non-list value); groups only is allowed", () => {
    const base = { appId: "1:1:android:a", releaseId: "r" };
    expect(
      refuse("firebase_app_distribution_distribute", { ...base, testerEmails: ["a@b.co"] }),
    ).toBe(FIREBASE_TESTER_EMAIL_REFUSAL);
    expect(
      refuse("firebase_app_distribution_distribute", { ...base, testerEmails: "a@b.co" }),
    ).toBe(FIREBASE_TESTER_EMAIL_REFUSAL);
    expect(
      refuse("firebase_app_distribution_distribute", {
        ...base,
        testerEmails: [],
        groupAliases: ["qa"],
      }),
    ).toBeUndefined();
    expect(
      refuse("firebase_app_distribution_distribute", { ...base, groupAliases: ["qa"] }),
    ).toBeUndefined();
  });

  test("production deploys are NOT refused to the model (OR-D3-1)", () => {
    expect(
      refuse("vercel_deployment_redeploy", { deploymentId: "d", target: "production" }),
    ).toBeUndefined();
    expect(
      refuse("vercel_deployment_promote", { projectId: "p", deploymentId: "d" }),
    ).toBeUndefined();
    expect(refuse("netlify_build_trigger", { siteId: "s", production: true })).toBeUndefined();
  });

  test("the refusals name no input", () => {
    for (const text of [NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL, FIREBASE_TESTER_EMAIL_REFUSAL]) {
      expect(text).not.toMatch(/[{}]/);
    }
  });
});
