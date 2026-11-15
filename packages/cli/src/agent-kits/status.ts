/**
 * `nimbus agent status` (Phase 28 AD7b): re-runs every kit's plan against the files as they are and
 * says whether the plan would change anything. It NEVER writes.
 *
 * Per file component: `ok` (the kit would change nothing), `drifted` (something of the kit's is
 * there but is not what the kit would write now: edited by hand, or written by an older kit),
 * `missing` (nothing of the kit's is there). A step the owner runs by hand is `manual`: Nimbus
 * cannot read where it lands, so it is neither healthy nor unhealthy and never changes the result.
 * A file that cannot be read as the kit's (`cannot tell`) is reported beside the kit's other files;
 * it needs attention only when the kit is otherwise installed.
 */
import { join } from "node:path";
import { quoteForPrintedCommand } from "../lib/shell-quote.ts";
import {
  KIT_IDS,
  type KitComponent,
  type KitEnforcement,
  type KitEnv,
  type KitId,
  type KitPlan,
  type KitScope,
} from "./kit-types.ts";
import { planKit, SUPPORTED_SCOPES } from "./kits/index.ts";
import { KitRefusal, sameText } from "./plan-files.ts";

export type ComponentState = "ok" | "drifted" | "missing" | "manual" | "cannot tell";

export interface ComponentStatus {
  readonly component: KitComponent;
  readonly state: ComponentState;
  /** The file, or for a manual step the command to run. */
  readonly where: string;
  /** For `cannot tell`: why the file could not be read as this kit's. */
  readonly reason?: string;
}

export interface KitStatus {
  readonly kit: KitId;
  readonly scope: KitScope;
  /** At least one file component is not `missing`. */
  readonly installed: boolean;
  readonly components: readonly ComponentStatus[];
  readonly enforcement: KitEnforcement;
  readonly notes: readonly string[];
  /** Set when the kit's files could not be read as a plan: Nimbus cannot tell. */
  readonly unreadable?: string;
}

function componentsOf(plan: KitPlan): ComponentStatus[] {
  const files = plan.files.map((f): ComponentStatus => {
    if (f.refusal !== undefined) {
      return { component: f.component, state: "cannot tell", where: f.path, reason: f.refusal };
    }
    let state: ComponentState;
    if (f.before !== null && sameText(f.before, f.after)) state = "ok";
    else state = f.present ? "drifted" : "missing";
    return { component: f.component, state, where: f.path };
  });
  const manual = plan.manual.map(
    (m): ComponentStatus => ({
      component: m.component,
      state: "manual",
      where: m.argv.map((a) => quoteForPrintedCommand(a)).join(" "),
    }),
  );
  return [...files, ...manual];
}

export function kitStatus(kit: KitId, env: KitEnv, scope: KitScope): KitStatus {
  try {
    const plan = planKit(kit, { ...env, tolerant: true }, scope);
    const components = componentsOf(plan);
    return {
      kit,
      scope,
      installed: components.some((c) => c.state === "ok" || c.state === "drifted"),
      components,
      enforcement: plan.enforcement,
      notes: plan.notes,
    };
  } catch (e) {
    if (!(e instanceof KitRefusal)) throw e;
    return {
      kit,
      scope,
      installed: false,
      components: [],
      enforcement: "none",
      notes: [],
      unreadable: e.message,
    };
  }
}

/** Every kit at user scope, and at project scope when the working directory is a repository. */
export function allKitStatuses(env: KitEnv): KitStatus[] {
  const inRepo = env.kind(join(env.cwd, ".git")) !== "absent";
  const out: KitStatus[] = [];
  for (const kit of KIT_IDS) {
    for (const scope of SUPPORTED_SCOPES[kit]) {
      if (scope === "project" && !inRepo) continue;
      out.push(kitStatus(kit, env, scope));
    }
  }
  return out;
}

/** True when an installed kit has a file component that is not `ok`. */
export function needsAttention(statuses: readonly KitStatus[]): boolean {
  return statuses.some(
    (s) =>
      s.installed &&
      s.components.some(
        (c) => c.state === "drifted" || c.state === "missing" || c.state === "cannot tell",
      ),
  );
}
