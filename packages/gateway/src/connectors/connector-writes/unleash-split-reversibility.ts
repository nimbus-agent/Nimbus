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

/**
 * The Unleash toggle is undone by the opposite toggle, CONDITIONALLY (owner ruling): only when the
 * call changed the state, and either it turned the environment off or the before-read showed an
 * active strategy. Turning on an environment with no active strategy makes Unleash add a default
 * strategy (a gradual rollout to 100%), which turning it off does not remove, so that call cannot be
 * undone through Nimbus and `invert` returns `undefined` (an `unknown` active strategy, from a capped
 * list, counts as none: fail closed).
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
      const wanted = input["enabled"];
      if (
        projectId === undefined ||
        featureName === undefined ||
        environment === undefined ||
        typeof wanted !== "boolean" ||
        (before !== "true" && before !== "false") ||
        before === String(wanted) ||
        (wanted && captured["activeStrategy"] !== "yes")
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
