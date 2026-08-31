/**
 * What PRIMITIVE each agent param is, and nothing else.
 *
 * This file exists because a `k=v` chat message yields STRINGS while some params are numbers or
 * arrays. It is a coercion table, NOT a validator: `ipc/agents-rpc.ts` still owns every bound,
 * every required/optional rule, every mutual exclusion (`ownership`'s `path` vs `service`), every
 * alias (`namespaces` beats `namespace`) and every `-32602` message. Nothing here duplicates any of
 * that, and no bounds constant appears in this file.
 *
 * It lives NEXT TO `agents-rpc.ts` on purpose: a param added to a validator is one line away from
 * the map that must learn about it. `scripts/structure-audit/check-agent-param-kinds.ts`
 * (`bun run audit:agent-param-kinds`, wired into `preflight:fast`) enforces the one-directional
 * bound described on its own `checkAgentParamKinds` — every validator field this file's line-walker
 * can see must have a matching entry here — so a new validator param one line away is also a
 * build failure one line away if it never lands in this map.
 *
 * Only the ELEVEN externally-permitted agents appear. `preflight`, `premortem`, `whyPeek` and
 * `negotiate` are excluded from every external surface, so declaring their params here would
 * advertise a grammar nothing serves.
 *
 * TWO boolean fields are in scope — `janitor.allowGaps` and `decisions.explain`. Note their
 * validators do NOT type-check them: `requireJanitorParams` reads `p["allowGaps"] === true` and
 * `requireDecisionsParams` reads `p.explain === true`, so an unrecognised value silently becomes
 * `false` rather than raising `-32602`. That is why coercing `"true"`/`"false"` HERE matters: it is
 * the only place a bad boolean is reported to the user instead of being silently dropped.
 */
export type ParamKind = "string" | "number" | "boolean" | "stringArray";

export const AGENT_PARAM_KINDS: Readonly<Record<string, Readonly<Record<string, ParamKind>>>> =
  Object.freeze({
    expert: Object.freeze({ topicOrFile: "string", limit: "number" }),
    impact: Object.freeze({ fileOrPrUrl: "string", depth: "number", service: "string" }),
    catchup: Object.freeze({ sinceMs: "number", service: "string" }),
    ghost: Object.freeze({ file: "string", namespace: "string", namespaces: "stringArray" }),
    conflicts: Object.freeze({ file: "string", namespace: "string", namespaces: "stringArray" }),
    huddle: Object.freeze({ sinceMs: "number", namespace: "string", namespaces: "stringArray" }),
    janitor: Object.freeze({
      resourceRef: "string",
      idleDays: "number",
      cleanupAction: "string",
      allowGaps: "boolean",
    }),
    ownership: Object.freeze({ path: "string", service: "string" }),
    why: Object.freeze({ ref: "string", line: "number", prUrl: "string" }),
    glossary: Object.freeze({ term: "string", limit: "number" }),
    decisions: Object.freeze({
      sinceMs: "number",
      minConfidence: "number",
      service: "string",
      explain: "boolean",
      limit: "number",
    }),
  });
