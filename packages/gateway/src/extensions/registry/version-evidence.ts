/**
 * A registry's signed version entries, read into the evidence lines an owner is shown (what was
 * tested, how long the registry has listed the package, what was checked) and the comparison of
 * two versions' scores. Pure: it reads nothing and decides nothing. Every line names the registry
 * that signed it, never states a verdict, and a score drop only informs. Registry and version
 * strings go through `oneLine` so none can forge a line of an approval prompt; a malformed score's
 * reason is never quoted here.
 */
import {
  type EvalBaselineFailure,
  type LivenessTestFailure,
  type RegistryVersionEntry,
  readVersionBaseline,
  readVersionQuality,
} from "@nimbus-dev/registry-format";
import { oneLine } from "../install-plan-text.ts";
import type { RegistryLivenessRead } from "./registry-liveness.ts";

export type TestedEvidence =
  | {
      readonly state: "scored";
      readonly score: number;
      readonly cases: number;
      readonly passed: number;
      readonly measuredBy: string;
      readonly text: string;
    }
  | {
      readonly state: "not-evaluated";
      readonly why: "unscored" | "malformed" | "starter-pack" | "local";
      readonly text: string;
    };
export type BaselineEvidence =
  | {
      readonly state: "checked";
      readonly passed: boolean;
      readonly tools: number;
      readonly failure?: EvalBaselineFailure;
      readonly checkedBy: string;
      readonly text: string;
    }
  | {
      readonly state: "none";
      readonly why: "unchecked" | "malformed" | "starter-pack" | "local";
      readonly text: string;
    };
export type HistoryEvidence =
  | {
      readonly state: "known";
      readonly firstPublished: string;
      readonly versions: number;
      readonly recordedBy: string;
      readonly text: string;
    }
  | { readonly state: "none"; readonly text: string };
export type CheckedEvidence =
  | {
      readonly state: "none";
      readonly why: "unpublished" | "local" | "starter-pack" | "version-absent";
      readonly text: string;
    }
  | {
      readonly state: "unavailable";
      readonly why: "unreadable" | "malformed-entry";
      readonly text: string;
    }
  | {
      readonly state: "checked";
      readonly checkedAt: string;
      readonly stale: boolean;
      readonly nimbusVersion: string;
      readonly checkedBy: string;
      readonly hosts?: { readonly declared: number; readonly answered: number };
      readonly tests?:
        | { readonly cases: number; readonly passed: number }
        | { readonly failure: LivenessTestFailure };
      readonly baseline?: {
        readonly passed: boolean;
        readonly tools: number;
        readonly failure?: EvalBaselineFailure;
      };
      readonly text: string;
    };
export type VersionEvidence = {
  readonly baseline: BaselineEvidence;
  readonly tested: TestedEvidence;
  readonly history: HistoryEvidence;
  readonly checked: CheckedEvidence;
};
export type QualitySide = {
  readonly score: number;
  readonly cases: number;
  readonly passed: number;
};
export type QualityChange =
  | {
      readonly state: "compared";
      readonly from: QualitySide;
      readonly to: QualitySide;
      readonly delta: number;
      readonly text: string;
    }
  | {
      readonly state: "not-compared";
      readonly why:
        | "installed-unscored"
        | "candidate-unscored"
        | "both-unscored"
        | "installed-malformed"
        | "candidate-malformed"
        | "candidate-gone"
        | "registry-unreadable";
      readonly text: string;
    };

const DAY_MS = 86_400_000;
export const LIVENESS_STALE_DAYS = 14;
export const LIVENESS_CAVEAT = "does not prove the service's API is unchanged";

function testedEvidence(o: {
  readonly registry: string;
  readonly versions: Readonly<Record<string, RegistryVersionEntry>>;
  readonly version: string;
  readonly declaresNetwork: boolean;
  readonly starterPack: boolean;
}): TestedEvidence {
  if (o.starterPack) {
    return {
      state: "not-evaluated",
      why: "starter-pack",
      text: "not evaluated (a starter pack runs nothing)",
    };
  }
  const entry = o.versions[o.version];
  const read = entry === undefined ? { state: "unscored" as const } : readVersionQuality(entry);
  if (read.state === "invalid") {
    return {
      state: "not-evaluated",
      why: "malformed",
      text: "not evaluated (the registry's score for this version is malformed)",
    };
  }
  if (read.state === "unscored") {
    return { state: "not-evaluated", why: "unscored", text: "not evaluated" };
  }
  const { score, cases, passed } = read.quality;
  const measuredBy = oneLine(o.registry);
  const network = o.declaresNetwork ? "; tests ran with no network" : "";
  return {
    state: "scored",
    score,
    cases,
    passed,
    measuredBy,
    text: `${passed} of ${cases} cases passed (${score}/100), tests by the publisher, measured by ${measuredBy}${network}`,
  };
}

function toolCount(n: number): string {
  return n === 1 ? "1 tool" : `${n} tools`;
}

type BaselineFacts = {
  readonly passed: boolean;
  readonly tools: number;
  readonly failure?: EvalBaselineFailure;
};

/** The one wording of a baseline result, shared by the baseline line and the Checked line. */
function baselineWording(b: BaselineFacts): string {
  if (b.passed) {
    if (b.tools === 0) return "starts and lists no tools";
    const noun = b.tools === 1 ? "tool" : "tools";
    return `starts and lists ${b.tools} valid ${noun}`;
  }
  if (b.failure === "listing-timeout") {
    return "did not answer a tool listing in time when checked offline with no credentials";
  }
  if (b.failure === "invalid-tool") {
    return b.tools === 1
      ? "lists 1 tool, without a valid name or input schema"
      : `lists ${toolCount(b.tools)}, at least one without a valid name or input schema`;
  }
  return "did not start or answer a valid tool listing when checked offline with no credentials";
}

function baselineText(b: BaselineFacts, by: string): string {
  return `${baselineWording(b)} (checked by ${by})`;
}

function baselineEvidence(o: {
  readonly registry: string;
  readonly versions: Readonly<Record<string, RegistryVersionEntry>>;
  readonly version: string;
  readonly starterPack: boolean;
}): BaselineEvidence {
  if (o.starterPack) {
    return {
      state: "none",
      why: "starter-pack",
      text: "not run (a starter pack runs nothing)",
    };
  }
  const entry = o.versions[o.version];
  const read = entry === undefined ? { state: "unchecked" as const } : readVersionBaseline(entry);
  if (read.state === "invalid") {
    return {
      state: "none",
      why: "malformed",
      text: "no baseline check (the registry's record for this version is malformed)",
    };
  }
  if (read.state === "unchecked") {
    return { state: "none", why: "unchecked", text: "no baseline check published" };
  }
  const b = read.baseline;
  const checkedBy = oneLine(o.registry);
  return {
    state: "checked",
    passed: b.passed,
    tools: b.tools,
    ...(b.passed ? {} : { failure: b.failure }),
    checkedBy,
    text: baselineText(b, checkedBy),
  };
}

function agoText(days: number): string {
  if (days < 0) return "dated in the future";
  if (days === 0) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function historyEvidence(
  registry: string,
  versions: Readonly<Record<string, RegistryVersionEntry>>,
  now: number,
): HistoryEvidence {
  const times = Object.values(versions)
    .map((v) => Date.parse(v.publishedAt))
    .filter((t) => Number.isFinite(t));
  if (times.length === 0) return { state: "none", text: "none (no versions listed)" };
  const oldest = Math.min(...times);
  const firstPublished = new Date(oldest).toISOString();
  const day = firstPublished.slice(0, 10);
  const days = Math.floor(now / DAY_MS) - Math.floor(oldest / DAY_MS);
  const count = Object.keys(versions).length;
  const recordedBy = oneLine(registry);
  const noun = count === 1 ? "version" : "versions";
  return {
    state: "known",
    firstPublished,
    versions: count,
    recordedBy,
    text: `first published ${day} (${agoText(days)}) · ${count} ${noun} (recorded by ${recordedBy})`,
  };
}

const TEST_FAILURE_TEXT: Readonly<Record<LivenessTestFailure, string>> = {
  "run-failed": "run failed",
  "run-timeout": "run timed out",
  "sandbox-unavailable": "no sandbox",
};

const UNAVAILABLE_CHECKED: CheckedEvidence = {
  state: "unavailable",
  why: "unreadable",
  text: "no checks available",
};

/**
 * The Checked line: what the registry's signed liveness file says about this version, dated, and
 * never a verdict. Only the `checked` state carries the caveat; a missing or unreadable file states
 * only that no checks are available or published.
 */
export function checkedEvidence(o: {
  readonly registry: string;
  readonly starterPack: boolean;
  readonly liveness: RegistryLivenessRead | undefined;
  readonly now: number;
}): CheckedEvidence {
  if (o.starterPack) {
    return {
      state: "none",
      why: "starter-pack",
      text: "not checked (a starter pack runs nothing)",
    };
  }
  const read = o.liveness;
  if (read === undefined || read.state === "unavailable") return UNAVAILABLE_CHECKED;
  if (read.state === "none") {
    return { state: "none", why: "unpublished", text: "no checks published" };
  }
  if (read.entry.state === "absent") {
    return {
      state: "none",
      why: "version-absent",
      text: "no checks published for this version",
    };
  }
  if (read.entry.state === "invalid") {
    return { state: "unavailable", why: "malformed-entry", text: "no checks available" };
  }
  const e = read.entry.entry;
  const when = Date.parse(e.checkedAt);
  const day = Number.isFinite(when) ? new Date(when).toISOString().slice(0, 10) : "an unknown day";
  const days = Number.isFinite(when) ? Math.floor(o.now / DAY_MS) - Math.floor(when / DAY_MS) : 0;
  const stale = days > LIVENESS_STALE_DAYS;
  const checkedBy = oneLine(o.registry);
  const nimbusVersion = oneLine(read.nimbusVersion);
  const parts: string[] = [];
  if (e.hosts !== undefined) {
    parts.push(
      e.hosts.answered === 0
        ? "no declared host answered"
        : `${e.hosts.answered} of ${e.hosts.declared} declared hosts answered`,
    );
  }
  if (e.tests !== undefined) {
    parts.push(
      "failure" in e.tests
        ? `tests could not be run (${TEST_FAILURE_TEXT[e.tests.failure]})`
        : `tests: ${e.tests.passed} of ${e.tests.cases} cases passed`,
    );
  }
  if (e.baseline !== undefined) {
    const b = e.baseline;
    parts.push(baselineWording(b));
  }
  const body = parts.length === 0 ? "no checks recorded" : parts.join(" · ");
  const staleText = stale ? ", stale" : "";
  const text = `${body} (checked ${day}, ${agoText(days)}${staleText}, with Nimbus ${nimbusVersion}, by ${checkedBy}); ${LIVENESS_CAVEAT}`;
  return {
    state: "checked",
    checkedAt: e.checkedAt,
    stale,
    nimbusVersion,
    checkedBy,
    ...(e.hosts === undefined ? {} : { hosts: e.hosts }),
    ...(e.tests === undefined ? {} : { tests: e.tests }),
    ...(e.baseline === undefined
      ? {}
      : {
          baseline: {
            passed: e.baseline.passed,
            tools: e.baseline.tools,
            ...(e.baseline.passed ? {} : { failure: e.baseline.failure }),
          },
        }),
    text,
  };
}

export function versionEvidence(o: {
  readonly registry: string;
  readonly versions: Readonly<Record<string, RegistryVersionEntry>>;
  readonly version: string;
  readonly declaresNetwork: boolean;
  readonly starterPack: boolean;
  /** Absent reads as unavailable ("no checks available"), never as "none published". */
  readonly liveness?: RegistryLivenessRead;
  readonly now: number;
}): VersionEvidence {
  return {
    baseline: baselineEvidence(o),
    tested: testedEvidence(o),
    history: historyEvidence(o.registry, o.versions, o.now),
    checked: checkedEvidence({
      registry: o.registry,
      starterPack: o.starterPack,
      liveness: o.liveness,
      now: o.now,
    }),
  };
}

export function localInstallEvidence(): VersionEvidence {
  return {
    baseline: { state: "none", why: "local", text: "not run (from a local folder)" },
    tested: {
      state: "not-evaluated",
      why: "local",
      text: "not evaluated (from a local folder)",
    },
    history: { state: "none", text: "none (from a local folder)" },
    checked: {
      state: "none",
      why: "local",
      text: "no checks published (from a local folder)",
    },
  };
}

function notCompared(
  why: Extract<QualityChange, { state: "not-compared" }>["why"],
  text: string,
): QualityChange {
  return { state: "not-compared", why, text: `quality not compared: ${text}` };
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

export function compareVersionQuality(
  versions: Readonly<Record<string, RegistryVersionEntry>>,
  fromVersion: string,
  toVersion: string,
): QualityChange {
  const to = versions[toVersion];
  const from = versions[fromVersion];
  const f = oneLine(fromVersion);
  const t = oneLine(toVersion);
  if (to === undefined) return notCompared("candidate-gone", `${t} is no longer in the index`);
  const fromRead = from === undefined ? { state: "unscored" as const } : readVersionQuality(from);
  const toRead = readVersionQuality(to);
  if (fromRead.state === "invalid") {
    return notCompared("installed-malformed", `${f} has a malformed score`);
  }
  if (toRead.state === "invalid") {
    return notCompared("candidate-malformed", `${t} has a malformed score`);
  }
  if (fromRead.state === "unscored" && toRead.state === "unscored") {
    return notCompared("both-unscored", "neither version is scored");
  }
  if (fromRead.state === "unscored") {
    return notCompared("installed-unscored", `${f} is not scored`);
  }
  if (toRead.state === "unscored") {
    return notCompared("candidate-unscored", `${t} is not scored`);
  }
  const a = fromRead.quality;
  const b = toRead.quality;
  const sideA: QualitySide = { score: a.score, cases: a.cases, passed: a.passed };
  const sideB: QualitySide = { score: b.score, cases: b.cases, passed: b.passed };
  const delta = b.score - a.score;
  let text: string;
  if (a.cases !== b.cases) {
    text = `quality ${a.score}/100 on ${a.cases} cases → ${b.score}/100 on ${b.cases} cases`;
  } else if (delta === 0) {
    text = `quality unchanged at ${a.score}/100`;
  } else {
    text = `quality ${a.score} → ${b.score} (${signed(delta)})`;
  }
  return { state: "compared", from: sideA, to: sideB, delta, text };
}

export function qualityUnreadable(): QualityChange {
  return notCompared("registry-unreadable", "the registry could not be read or verified just now");
}

/**
 * The approval fields stating a package's evidence: the four lines (the baseline first), and, when the plan installs
 * more than one package, a scope line saying the lines are for the root only. One builder for both
 * install doors so each states the scope the same way.
 */
export function evidenceApprovalFields(
  evidence: VersionEvidence,
  id: string,
  planSize: number,
): {
  readonly baseline: string;
  readonly tested: string;
  readonly history: string;
  readonly checked: string;
  readonly evidenceScope?: string;
} {
  const base = {
    baseline: evidence.baseline.text,
    tested: evidence.tested.text,
    history: evidence.history.text,
    checked: evidence.checked.text,
  };
  const others = planSize - 1;
  if (others < 1) return base;
  const rest =
    others === 1
      ? "the other package in this plan is"
      : `the ${others} other packages in this plan are`;
  return { ...base, evidenceScope: `for ${oneLine(id)} only; ${rest} not summarised here` };
}
