import { describe, expect, mock, test } from "bun:test";
import type {
  CatchupBrief,
  ConflictBrief,
  ExpertBrief,
  HuddleBrief,
  ImpactBrief,
  JanitorBrief,
  PreflightBrief,
} from "./findings.ts";
import type { OwnershipBrief } from "./ownership-types.ts";
import { synthesize } from "./synthesize.ts";

const EXPERT_FIXTURE: ExpertBrief = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { topicOrFile: "src/x.ts" },
  ranked: [],
};

const IMPACT_FIXTURE: ImpactBrief = {
  kind: "impact",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { fileOrPrUrl: "src/x.ts" },
  startEntityId: null,
  affected: [],
};

describe("synthesize(ExpertBrief)", () => {
  test("falls back to deterministic render when no LLM provided", async () => {
    const md = await synthesize(EXPERT_FIXTURE);
    expect(md).toContain("# Expert: src/x.ts");
    expect(md).toContain("_no people matched_");
  });

  test("falls back to deterministic render when LLM returns null/empty", async () => {
    const llm = {
      generateMarkdown: mock(async () => null),
    };
    const md = await synthesize(EXPERT_FIXTURE, { llm });
    expect(md).toContain("# Expert: src/x.ts");
    expect(llm.generateMarkdown).toHaveBeenCalledTimes(1);
  });

  test("uses LLM output when provided, and wraps payload before passing to LLM", async () => {
    const seenPrompt: string[] = [];
    const llm = {
      generateMarkdown: mock(async (prompt: string) => {
        seenPrompt.push(prompt);
        return "# LLM-rewritten Markdown";
      }),
    };
    const md = await synthesize(EXPERT_FIXTURE, { llm });
    expect(md).toBe("# LLM-rewritten Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.expert">[^<]*"kind":"expert"[^<]*<\/tool_output>/,
    );
  });

  test("on LLM throw, falls back to deterministic render and does not propagate", async () => {
    const llm = {
      generateMarkdown: mock(async () => {
        throw new Error("rate limited");
      }),
    };
    const md = await synthesize(EXPERT_FIXTURE, { llm });
    expect(md).toContain("# Expert: src/x.ts");
  });
});

describe("synthesize(ImpactBrief)", () => {
  test("falls back to deterministic render when no LLM provided", async () => {
    const md = await synthesize(IMPACT_FIXTURE);
    expect(md).toContain("# Impact: src/x.ts");
    expect(md).toContain("_no downstream impact resolved_");
  });

  test("falls back to deterministic render when LLM returns null/empty", async () => {
    const llm = {
      generateMarkdown: mock(async () => null),
    };
    const md = await synthesize(IMPACT_FIXTURE, { llm });
    expect(md).toContain("# Impact: src/x.ts");
    expect(llm.generateMarkdown).toHaveBeenCalledTimes(1);
  });

  test("on LLM throw, falls back to deterministic render and does not propagate", async () => {
    const llm = {
      generateMarkdown: mock(async () => {
        throw new Error("rate limited");
      }),
    };
    const md = await synthesize(IMPACT_FIXTURE, { llm });
    expect(md).toContain("# Impact: src/x.ts");
  });

  test("wraps ImpactBrief payload with correct tool name", async () => {
    const seenPrompt: string[] = [];
    const llm = {
      generateMarkdown: mock(async (prompt: string) => {
        seenPrompt.push(prompt);
        return "# LLM-rewritten Impact Markdown";
      }),
    };
    const md = await synthesize(IMPACT_FIXTURE, { llm });
    expect(md).toBe("# LLM-rewritten Impact Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.impact">[^<]*"kind":"impact"[^<]*<\/tool_output>/,
    );
  });
});

const CATCHUP_FIXTURE: CatchupBrief = {
  kind: "catchup",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { sinceMs: 1_000 },
  selfPersonId: "p-1",
  involvement: {
    ownedServices: [],
    activeRepos: [],
    incidentServices: [],
    collaboratorPersonIds: [],
  },
  sections: [],
};

describe("synthesize(CatchupBrief)", () => {
  test("falls back to deterministic render when no LLM provided", async () => {
    const md = await synthesize(CATCHUP_FIXTURE);
    expect(md).toContain("# Catchup");
    expect(md).toContain("_no activity in the requested window_");
  });

  test("falls back to deterministic render when LLM returns null", async () => {
    const llm = { generateMarkdown: mock(async () => null) };
    const md = await synthesize(CATCHUP_FIXTURE, { llm });
    expect(md).toContain("# Catchup");
    expect(llm.generateMarkdown).toHaveBeenCalledTimes(1);
  });

  test("on LLM throw, falls back to deterministic render", async () => {
    const llm = {
      generateMarkdown: mock(async () => {
        throw new Error("rate limited");
      }),
    };
    const md = await synthesize(CATCHUP_FIXTURE, { llm });
    expect(md).toContain("# Catchup");
  });

  test("wraps CatchupBrief payload with tool name agents.catchup (I11)", async () => {
    const seenPrompt: string[] = [];
    const llm = {
      generateMarkdown: mock(async (prompt: string) => {
        seenPrompt.push(prompt);
        return "# LLM-rewritten Catchup Markdown";
      }),
    };
    const md = await synthesize(CATCHUP_FIXTURE, { llm });
    expect(md).toBe("# LLM-rewritten Catchup Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.catchup">[^<]*"kind":"catchup"[^<]*<\/tool_output>/,
    );
  });
});

const CONFLICT_FIXTURE: ConflictBrief = {
  kind: "conflict",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { file: "src/x.ts" },
  startEntityId: null,
  collisions: [],
};

describe("synthesize(ConflictBrief)", () => {
  test("wraps ConflictBrief payload with tool name agents.conflicts (I11)", async () => {
    const seenPrompt: string[] = [];
    const llm = {
      generateMarkdown: mock(async (prompt: string) => {
        seenPrompt.push(prompt);
        return "# LLM-rewritten Conflict Markdown";
      }),
    };
    const md = await synthesize(CONFLICT_FIXTURE, { llm });
    expect(md).toBe("# LLM-rewritten Conflict Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.conflicts">[^<]*"kind":"conflict"[^<]*<\/tool_output>/,
    );
  });
});

const JANITOR_FIXTURE: JanitorBrief = {
  kind: "janitor",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { resourceRef: "i-12345", idleDays: 30 },
  idle: false,
  proposalSuppressed: false,
  cleanupAction: null,
  peersClear: 0,
  peersTouched: [],
};

describe("synthesize(JanitorBrief)", () => {
  test("wraps JanitorBrief payload with tool name agents.janitor (I11)", async () => {
    const seenPrompt: string[] = [];
    const llm = {
      generateMarkdown: mock(async (prompt: string) => {
        seenPrompt.push(prompt);
        return "# LLM-rewritten Janitor Markdown";
      }),
    };
    const md = await synthesize(JANITOR_FIXTURE, { llm });
    expect(md).toBe("# LLM-rewritten Janitor Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.janitor">[^<]*"kind":"janitor"[^<]*<\/tool_output>/,
    );
  });
});

const PREFLIGHT_FIXTURE: PreflightBrief = {
  kind: "preflight",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { ref: "main", namespace: "default" },
  downstreams: [],
  anyFailed: false,
  anyIncomplete: false,
};

describe("synthesize(PreflightBrief)", () => {
  test("wraps PreflightBrief payload with tool name agents.preflight (I11)", async () => {
    const seenPrompt: string[] = [];
    const llm = {
      generateMarkdown: mock(async (prompt: string) => {
        seenPrompt.push(prompt);
        return "# LLM-rewritten Preflight Markdown";
      }),
    };
    const md = await synthesize(PREFLIGHT_FIXTURE, { llm });
    expect(md).toBe("# LLM-rewritten Preflight Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.preflight">[^<]*"kind":"preflight"[^<]*<\/tool_output>/,
    );
  });
});

const HUDDLE_FIXTURE: HuddleBrief = {
  kind: "huddle",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { sinceMs: 1_000 },
  contributions: [],
};

describe("synthesize(HuddleBrief)", () => {
  test("wraps HuddleBrief payload with default tool name agents.huddle (I11)", async () => {
    const seenPrompt: string[] = [];
    const llm = {
      generateMarkdown: mock(async (prompt: string) => {
        seenPrompt.push(prompt);
        return "# LLM-rewritten Huddle Markdown";
      }),
    };
    const md = await synthesize(HUDDLE_FIXTURE, { llm });
    expect(md).toBe("# LLM-rewritten Huddle Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.huddle">[^<]*"kind":"huddle"[^<]*<\/tool_output>/,
    );
  });
});

const OWNERSHIP_FIXTURE: OwnershipBrief = {
  kind: "ownership",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [],
  query: { path: null, service: null },
  target: null,
  parentDirectory: null,
  service: null,
  coverage: {
    lastPassAt: null,
    lastDurationMs: 0,
    rootsTotal: 0,
    rootsCovered: 0,
    rootsWithRemote: 0,
    filesCovered: 0,
    filesExcluded: 0,
    servicesBound: 0,
    ownersEmitted: 0,
    entitiesReaped: 0,
  },
};

describe("synthesize(OwnershipBrief)", () => {
  // toolNameFor's ownership arm (`agents.ownership`) is reached only on the
  // LLM path (synthesize.ownership.test.ts calls synthesize with no LLM, which
  // never reaches toolNameFor). Without this test the arm could be deleted —
  // mislabelling the envelope as e.g. agents.huddle — and no test would fail.
  test("wraps OwnershipBrief payload with tool name agents.ownership (I11)", async () => {
    const seenPrompt: string[] = [];
    const llm = {
      generateMarkdown: mock(async (prompt: string) => {
        seenPrompt.push(prompt);
        return "# LLM-rewritten Ownership Markdown";
      }),
    };
    const md = await synthesize(OWNERSHIP_FIXTURE, { llm });
    expect(md).toBe("# LLM-rewritten Ownership Markdown");
    expect(seenPrompt[0]).toMatch(
      /<tool_output service="nimbus" tool="agents\.ownership">[^<]*"kind":"ownership"[^<]*<\/tool_output>/,
    );
  });
});

describe("no-LLM labelling", () => {
  test("no-LLM output is labelled as a deliberate mode, not silent degradation", async () => {
    const out = await synthesize(EXPERT_FIXTURE);
    expect(out).toContain("Rendered deterministically");
  });

  test("an LLM-backed render carries no such footer", async () => {
    const out = await synthesize(EXPERT_FIXTURE, {
      llm: { generateMarkdown: mock(async () => "# polished") },
    });
    expect(out).not.toContain("Rendered deterministically");
  });

  test("a configured-but-failing LLM is NOT labelled as unconfigured", async () => {
    // The user HAS configured an LLM here; claiming otherwise would misdirect
    // them into 'fixing' a setting that is already correct.
    const out = await synthesize(EXPERT_FIXTURE, {
      llm: {
        generateMarkdown: mock(async () => {
          throw new Error("provider down");
        }),
      },
    });
    expect(out).toContain("# Expert: src/x.ts");
    expect(out).not.toContain("Rendered deterministically");
  });

  test("an empty LLM response is NOT labelled as unconfigured either", async () => {
    const out = await synthesize(EXPERT_FIXTURE, {
      llm: { generateMarkdown: mock(async () => "  ") },
    });
    expect(out).not.toContain("Rendered deterministically");
  });
});
