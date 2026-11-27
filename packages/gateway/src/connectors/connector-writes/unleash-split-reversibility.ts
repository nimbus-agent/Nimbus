// packages/gateway/src/connectors/connector-writes/unleash-split-reversibility.ts
// The reversibility of the connectors 0.22.0 flag writes (owner rulings 2026-11-27), used by the ONE
// table in `reversibility.ts`. The captures are strict extractions from the before reader's reply,
// separate from the display `select` in `unleash-split-rows.ts`.
import type { BeforeCaptures, ReversibilityDecl } from "./types.ts";
import { splitKilledNow, unleashActiveStrategy, unleashEnabledNow } from "./unleash-split-rows.ts";

const asText = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined;

/** `enabled` (`true`/`false`) and `activeStrategy` (`yes`/`no`/`unknown`) of the ONE environment. */
export const UNLEASH_CAPTURES: BeforeCaptures = {
  keys: ["enabled", "activeStrategy"],
  pick(reply) {
    return {
      enabled: String(unleashEnabledNow(reply)),
      activeStrategy: unleashActiveStrategy(reply),
    };
  },
};

/** Whether the call changed the environment's on/off state, from a well-formed record. */
function toggleChanged(
  input: Readonly<Record<string, unknown>>,
  before: string | undefined,
): boolean {
  const wanted = input["enabled"];
  return (
    typeof wanted === "boolean" &&
    (before === "true" || before === "false") &&
    before !== String(wanted)
  );
}

/** The condition the Unleash toggle's reversibility rests on, shown wherever no before-read exists yet. */
export const UNLEASH_REVERSIBLE_IF = "the environment already has an active strategy";

/** Why a toggle outside {@link UNLEASH_REVERSIBLE_IF} cannot be undone, for a label shown before any before-read. */
export const UNLEASH_OTHERWISE =
  "Unleash adds a default strategy that serves everyone when it enables an environment with no active strategy, and turning it off does not remove it";

/**
 * Why THIS Unleash toggle cannot be undone, or `undefined` when nothing about Unleash prevents it (a call
 * that changed nothing has no inverse either, but for no Unleash reason). Unleash adds a default strategy
 * that serves everyone when it enables an environment with no active strategy, and turning the environment
 * off does not remove it: so a toggle ON made it, and the undo of a toggle OFF would make it.
 */
export function unleashToggleWhyNot(
  input: Readonly<Record<string, unknown>>,
  captured: Readonly<Record<string, string>>,
): string | undefined {
  const active = captured["activeStrategy"];
  if (active === "yes" || !toggleChanged(input, captured["enabled"])) return undefined;
  const unsure =
    active === "no"
      ? ""
      : "not every strategy was shown, so Nimbus cannot tell whether one is active; ";
  return input["enabled"] === true
    ? `${unsure}turning the environment on made Unleash add a default strategy that serves everyone, and turning it off does not remove it`
    : `${unsure}turning the environment back on, Unleash would add a default strategy that serves everyone, which it did not have`;
}

/**
 * The Unleash toggle is undone by the opposite toggle ONLY when the before-read showed an active strategy,
 * whichever way the call went (owner ruling 2026-11-27); otherwise {@link unleashToggleWhyNot} says why not
 * (an `unknown` active strategy, from a capped list, counts as none: fail closed).
 */
export function unleashToggleDecl(): ReversibilityDecl {
  return {
    class: "reversible",
    inverse: "unleash_feature_toggle",
    fromBefore: ["enabled", "activeStrategy"],
    invert: (input, captured) => {
      const projectId = asText(input["projectId"]);
      const featureName = asText(input["featureName"]);
      const environment = asText(input["environment"]);
      const before = captured["enabled"];
      if (
        projectId === undefined ||
        featureName === undefined ||
        environment === undefined ||
        !toggleChanged(input, before) ||
        captured["activeStrategy"] !== "yes"
      ) {
        return undefined;
      }
      return { projectId, featureName, environment, enabled: before === "true" };
    },
  };
}

/** `killed` (`true`/`false`) of the ONE environment. */
export const SPLIT_CAPTURES: BeforeCaptures = {
  keys: ["killed"],
  pick(reply) {
    return { killed: String(splitKilledNow(reply)) };
  },
};

/**
 * A Split kill or restore: the inverse is the other one, and only when the split really was in the
 * opposite state (`wasKilled`), so a call that changed nothing builds no inverse.
 */
export function splitDecl(inverse: string, wasKilled: "true" | "false"): ReversibilityDecl {
  return {
    class: "reversible",
    inverse,
    fromBefore: ["killed"],
    invert: (input, captured) => {
      const workspaceId = asText(input["workspaceId"]);
      const splitName = asText(input["splitName"]);
      const environment = asText(input["environment"]);
      return captured["killed"] === wasKilled &&
        workspaceId !== undefined &&
        splitName !== undefined &&
        environment !== undefined
        ? { workspaceId, splitName, environment }
        : undefined;
    },
  };
}
