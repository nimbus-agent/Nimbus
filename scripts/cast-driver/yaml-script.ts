import { parse as parseYaml } from "yaml";

export interface InputStep {
  readonly type: "input";
  readonly input: string;
  readonly expect?: string;
  readonly timeoutMs?: number;
}

export interface ConsentStep {
  readonly type: "consent";
  readonly consent: "approve" | "reject";
  readonly expect?: string;
}

export type Step = InputStep | ConsentStep;

/**
 * Optional per-script fixture repository.
 *
 * Exists because some commands are only meaningful inside a project — `nimbus
 * init` refuses to run outside a git repository, and the path it prints has to
 * be reproducible. The directory is created under the harness tmpdir, so the
 * existing `<TMP>` normalization rule scrubs it and the snapshot stays stable
 * across machines and CI. Without this the demo would run in whatever checkout
 * recorded it and bake that absolute path into the transcript.
 */
export interface RepoSetup {
  /** Directory name, created under the harness tmpdir. */
  readonly dir: string;
  /** Relative path -> file contents. Parent directories are created. */
  readonly files: Readonly<Record<string, string>>;
}

export interface SetupSpec {
  readonly repo?: RepoSetup;
}

export interface CastScript {
  readonly name: string;
  readonly description: string;
  readonly events: string;
  readonly setup?: SetupSpec;
  /**
   * Seconds between events in the emitted `.cast`, for playback pacing.
   * Omitted -> keep the raw harness timings (existing casts are unaffected).
   */
  readonly pacingSeconds?: number;
  readonly steps: ReadonlyArray<Step>;
}

export interface InputGroup {
  readonly input: InputStep;
  readonly consents: ReadonlyArray<ConsentStep>;
}

export interface CompiledScript {
  readonly script: CastScript;
  readonly inputGroups: ReadonlyArray<InputGroup>;
}

function fail(reason: string): never {
  throw new Error(`cast-script: ${reason}`);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") fail(`field "${field}" must be a string`);
  return v;
}

function parseStep(raw: unknown, idx: number): Step {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail(`step ${idx} must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const hasInput = "input" in o;
  const hasConsent = "consent" in o;
  if (hasInput && hasConsent) {
    fail(`step ${idx} cannot have both input and consent keys`);
  }
  if (!hasInput && !hasConsent) {
    fail(`step ${idx} must have either input or consent`);
  }
  if (hasInput) {
    const step: InputStep = {
      type: "input",
      input: asString(o["input"], `step ${idx}.input`),
      ...(typeof o["expect"] === "string" ? { expect: o["expect"] } : {}),
      ...(typeof o["timeoutMs"] === "number" ? { timeoutMs: o["timeoutMs"] } : {}),
    };
    return step;
  }
  const c = o["consent"];
  if (c !== "approve" && c !== "reject") {
    fail(`step ${idx}: consent must be "approve" or "reject"`);
  }
  const step: ConsentStep = {
    type: "consent",
    consent: c,
    ...(typeof o["expect"] === "string" ? { expect: o["expect"] } : {}),
  };
  return step;
}

function parseSetup(raw: unknown): SetupSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) fail('"setup" must be a mapping');
  const o = raw as Record<string, unknown>;
  const repoRaw = o["repo"];
  if (repoRaw === undefined || repoRaw === null) return {};
  if (typeof repoRaw !== "object" || Array.isArray(repoRaw)) fail('"setup.repo" must be a mapping');
  const r = repoRaw as Record<string, unknown>;
  const dir = asString(r["dir"], "setup.repo.dir");
  // A traversing dir would escape the harness tmpdir, so the transcript would
  // contain an un-normalised path and the write would land outside the sandbox.
  if (dir.includes("..") || dir.startsWith("/") || /^[A-Za-z]:/.test(dir)) {
    fail('"setup.repo.dir" must be a relative path inside the harness tmpdir');
  }
  const filesRaw = r["files"];
  if (typeof filesRaw !== "object" || filesRaw === null || Array.isArray(filesRaw)) {
    fail('"setup.repo.files" must be a mapping of path -> contents');
  }
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(filesRaw as Record<string, unknown>)) {
    if (k.includes("..") || k.startsWith("/") || /^[A-Za-z]:/.test(k)) {
      fail(`"setup.repo.files" key must be a relative path inside the repo: ${k}`);
    }
    files[k] = asString(v, `setup.repo.files["${k}"]`);
  }
  return { repo: { dir, files } };
}

export function parseCastScript(yaml: string): CompiledScript {
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    fail(`YAML parse error: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) fail("top-level YAML must be a mapping");
  const r = raw as Record<string, unknown>;
  if (!("name" in r)) fail('missing "name" field');
  if (!("description" in r)) fail('missing "description" field');
  if (!("events" in r)) fail('missing "events" field');
  if (!("steps" in r)) fail('missing "steps" field');
  const stepsRaw = r["steps"];
  if (!Array.isArray(stepsRaw)) fail('"steps" must be a list');
  const steps = stepsRaw.map((s, idx) => parseStep(s, idx));
  const setup = parseSetup(r["setup"]);
  const pacingRaw = r["pacingSeconds"];
  if (pacingRaw !== undefined && (typeof pacingRaw !== "number" || !(pacingRaw > 0))) {
    fail('"pacingSeconds" must be a positive number');
  }
  const script: CastScript = {
    name: asString(r["name"], "name"),
    description: asString(r["description"], "description"),
    events: asString(r["events"], "events"),
    ...(setup === undefined ? {} : { setup }),
    ...(typeof pacingRaw === "number" ? { pacingSeconds: pacingRaw } : {}),
    steps,
  };
  const groups: InputGroup[] = [];
  let current: { input: InputStep; consents: ConsentStep[] } | undefined;
  for (const step of steps) {
    if (step.type === "input") {
      if (current !== undefined) groups.push({ input: current.input, consents: current.consents });
      current = { input: step, consents: [] };
    } else {
      if (current === undefined) fail("consent step before any input");
      current.consents.push(step);
    }
  }
  if (current !== undefined) groups.push({ input: current.input, consents: current.consents });
  return { script, inputGroups: groups };
}
