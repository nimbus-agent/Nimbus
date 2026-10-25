import { describe, expect, it } from "vitest";
import { prefillValues } from "../../src/briefs/brief-form";
import { connectedIds, suggestionsFrom } from "../../src/onboarding/connect-suggestions";
import {
  asDecisionStatus,
  type ConnectorProgress,
  type DecisionStatus,
  decisionsView,
} from "../../src/onboarding/decisions-progress";
import { endsOnDecisions, packFor, packRows, roleChoices } from "../../src/onboarding/role-choices";
import { onboardingSteps } from "../../src/pages/Onboarding";

const PACKS = {
  profile: "default",
  installed: [
    {
      id: "devops",
      name: "DevOps",
      version: "1.1.0",
      source: "bundled",
      updateAvailable: false,
      visibleAgents: ["oncall"],
      roles: ["devops", "sre"],
    },
  ],
  available: [
    {
      id: "pm",
      name: "Product",
      version: "1.0.0",
      description: "Decisions, glossary and catch-up for product work.",
      roles: ["product"],
      suggestedConnectors: ["slack", "jira"],
      visibleAgents: ["decisions", "glossary"],
    },
  ],
  skipped: [],
};

describe("role choices", () => {
  it("one per pack (installed first), then Engineering, Design, Something else", () => {
    expect(roleChoices(PACKS).map((c) => c.label)).toEqual([
      "DevOps",
      "Product",
      "Engineering",
      "Design",
      "Something else",
    ]);
    expect(roleChoices(PACKS)[1]).toMatchObject({
      value: "pack:pm",
      description: "Decisions, glossary and catch-up for product work.",
    });
  });

  it("a malformed reply leaves the three fixed answers", () => {
    expect(roleChoices(null).map((c) => c.value)).toEqual(["engineering", "design", "other"]);
    expect(packRows({ installed: [{ id: 1 }], available: "x" })).toEqual([]);
  });

  it("packFor resolves pack:<id>; fixed answers and unknown ids are undefined", () => {
    expect(packFor("pack:pm", PACKS)).toMatchObject({ id: "pm", installed: false });
    expect(packFor("pack:devops", PACKS)).toMatchObject({ installed: true });
    expect(packFor("engineering", PACKS)).toBeUndefined();
    expect(packFor("pack:nope", PACKS)).toBeUndefined();
  });

  it("onboarding ends on Decisions only for a pack that shows decisions", () => {
    expect(endsOnDecisions(packFor("pack:pm", PACKS))).toBe(true);
    expect(endsOnDecisions(packFor("pack:devops", PACKS))).toBe(false);
    expect(endsOnDecisions(undefined)).toBe(false);
  });
});

describe("onboarding step header", () => {
  it("shows Pack only while a pack is being set up, and ends on the route's last step", () => {
    expect(onboardingSteps("/onboarding/role", false).map((s) => s.label)).toEqual([
      "Welcome",
      "Role",
      "Connect",
      "Syncing",
    ]);
    expect(onboardingSteps("/onboarding/connect", true, true).at(-1)?.label).toBe("Decisions");
    expect(onboardingSteps("/onboarding/decisions", true).map((s) => s.label)).toEqual([
      "Welcome",
      "Role",
      "Pack",
      "Connect",
      "Decisions",
    ]);
  });
});

describe("connect suggestions", () => {
  it("reads display names and sign-in kinds; unknown kinds are terminal", () => {
    const rows = suggestionsFrom({
      connectors: [
        { id: "slack", displayName: "Slack", description: "d", signIn: "browser" },
        {
          kind: "extension",
          id: "com.example.x",
          serviceId: "ext_x",
          name: "X notes",
          signIn: "weird",
        },
      ],
      suggestedConnectors: ["slack", "ext_x", "unknown"],
    });
    expect(rows).toEqual([
      { id: "slack", displayName: "Slack", description: "d", signIn: "browser" },
      { id: "ext_x", displayName: "X notes", description: "", signIn: "terminal" },
      { id: "unknown", displayName: "unknown", description: "", signIn: "terminal" },
    ]);
  });

  it("connected = a string health that is not unauthenticated", () => {
    expect([
      ...connectedIds([
        { serviceId: "a", healthState: "healthy" },
        { serviceId: "b", healthState: "unauthenticated" },
        { serviceId: "c" },
        { serviceId: "d", healthState: 1 },
        "junk",
      ]),
    ]).toEqual(["a"]);
    expect(connectedIds("nope").size).toBe(0);
  });
});

function status(over: Partial<DecisionStatus> = {}): DecisionStatus {
  return {
    enabled: true,
    state: "idle",
    lastPassAt: 1,
    minConfidence: 0.3,
    windowDays: 90,
    sources: [
      { service: "slack", type: "message", kind: "message", items: 40 },
      { service: "jira", type: "issue", kind: "ticket", items: 1 },
    ],
    candidates: { pending: 0, extracted: 0, vetoed: 0 },
    shown: 0,
    recent: [],
    ...over,
  };
}

const SYNCED: readonly ConnectorProgress[] = [
  { id: "slack", displayName: "Slack", status: "ok", itemCount: 1240, lastSyncAt: 5 },
  { id: "jira", displayName: "Jira", status: "ok", itemCount: 1, lastSyncAt: 5 },
];

describe("decisions progress", () => {
  it("off: the pass is disabled — never a spinner", () => {
    const v = decisionsView(status({ enabled: false, state: "disabled" }), SYNCED);
    expect(v.phase).toBe("off");
    expect(v.headline).toBe(
      "The decisions pass is turned off in your config ([decisions] enabled).",
    );
  });

  it("working while a connector syncs, the pass runs, or candidates wait", () => {
    const syncing = [{ ...SYNCED[0], status: "syncing" } as ConnectorProgress];
    expect(decisionsView(status({ shown: 3 }), syncing)).toMatchObject({
      phase: "working",
      headline: "Looking for decisions… 3 found so far",
      syncLines: ["Syncing Slack… 1240 items"],
    });
    expect(decisionsView(status({ state: "running" }), SYNCED).phase).toBe("working");
    expect(
      decisionsView(status({ candidates: { pending: 2, extracted: 0, vetoed: 0 } }), SYNCED).phase,
    ).toBe("working");
    expect(decisionsView(null, SYNCED).phase).toBe("working");
    const firstSync = [{ ...SYNCED[0], lastSyncAt: null } as ConnectorProgress];
    expect(decisionsView(status(), firstSync).phase).toBe("working");
  });

  it("found: says how many", () => {
    expect(decisionsView(status({ shown: 1 }), SYNCED)).toMatchObject({
      phase: "found",
      headline: "1 decision found.",
    });
  });

  it("none, nothing scored: names what was read and the decision-language reason", () => {
    const v = decisionsView(status(), SYNCED);
    expect(v.phase).toBe("none");
    expect(v.headline).toBe(
      "We read 40 messages from Slack and 1 ticket from Jira and found no clear decisions.",
    );
    expect(v.reason).toBe("None of it used decision language like 'we decided' or 'Decision:'.");
  });

  it("none, but candidates were extracted: the confidence-floor reason (never the language one)", () => {
    const v = decisionsView(
      status({ candidates: { pending: 0, extracted: 3, vetoed: 0 } }),
      SYNCED,
    );
    expect(v.reason).toBe(
      "3 possible decisions were too uncertain to show (below your confidence floor).",
    );
  });

  it("none with nothing read says so, and gives no reason about decision language", () => {
    const v = decisionsView(status({ sources: [] }), SYNCED);
    expect(v.headline).toBe("Nothing has been read yet that could hold a decision.");
    expect(v.reason).toBeUndefined();
  });

  it("asDecisionStatus rejects a malformed reply", () => {
    expect(asDecisionStatus(null)).toBeNull();
    expect(asDecisionStatus({ enabled: true })).toBeNull();
    expect(
      asDecisionStatus({ ...status(), candidates: { pending: "1", extracted: 0 } }),
    ).toBeNull();
    expect(asDecisionStatus(status())).not.toBeNull();
  });
});

describe("brief prefill", () => {
  const params = [
    { name: "sinceMs", kind: "duration", label: "Since", required: false },
    { name: "service", kind: "string", label: "Service", required: false },
    { name: "explain", kind: "boolean", label: "Explain", required: false },
  ] as never;

  it("prefills a declared param and a known since preset only", () => {
    const q = new URLSearchParams("sinceMs=31536000000&service=slack&explain=true&other=1");
    expect(prefillValues(params, q)).toEqual({ sinceMs: "31536000000", service: "slack" });
  });

  it("drops a since value that is not a preset", () => {
    expect(prefillValues(params, new URLSearchParams("sinceMs=123"))).toEqual({});
  });
});
