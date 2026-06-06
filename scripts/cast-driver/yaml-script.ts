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

export interface CastScript {
  readonly name: string;
  readonly description: string;
  readonly events: string;
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
  const script: CastScript = {
    name: asString(r["name"], "name"),
    description: asString(r["description"], "description"),
    events: asString(r["events"], "events"),
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
