/**
 * A registry's signed version entries, read into the evidence lines an owner is shown (what was
 * tested, how long the registry has listed the package, what was checked) and the comparison of
 * two versions' scores. Pure: it reads nothing and decides nothing. Every line names the registry
 * that signed it, never states a verdict, and a score drop only informs. Registry and version
 * strings go through `oneLine` so none can forge a line of an approval prompt; a malformed score's
 * reason is never quoted here.
 */
import { type RegistryVersionEntry, readVersionQuality } from "@nimbus-dev/registry-format";
import { oneLine } from "../install-plan-text.ts";

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
export type HistoryEvidence =
  | {
      readonly state: "known";
      readonly firstPublished: string;
      readonly versions: number;
      readonly recordedBy: string;
      readonly text: string;
    }
  | { readonly state: "none"; readonly text: string };
export type CheckedEvidence = { readonly state: "none"; readonly text: string };
export type VersionEvidence = {
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
const NO_CHECKS: CheckedEvidence = { state: "none", text: "no checks published" };

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

export function versionEvidence(o: {
  readonly registry: string;
  readonly versions: Readonly<Record<string, RegistryVersionEntry>>;
  readonly version: string;
  readonly declaresNetwork: boolean;
  readonly starterPack: boolean;
  readonly now: number;
}): VersionEvidence {
  return {
    tested: testedEvidence(o),
    history: historyEvidence(o.registry, o.versions, o.now),
    checked: NO_CHECKS,
  };
}

export function localInstallEvidence(): VersionEvidence {
  return {
    tested: {
      state: "not-evaluated",
      why: "local",
      text: "not evaluated (installed from a local folder)",
    },
    history: { state: "none", text: "none (installed from a local folder)" },
    checked: NO_CHECKS,
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
  return notCompared("registry-unreadable", "the registry could not be read just now");
}
