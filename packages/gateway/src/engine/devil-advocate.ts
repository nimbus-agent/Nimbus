/**
 * Devil's-advocate mode (`nimbus ask --devil`) — the confirmation-bias antidote.
 *
 * ONE definition, injected at ONE place. A turn is answered by either the local LLM router
 * (`runViaLocalRouter`) or the Mastra agent (`runViaAgent`), and those two read different
 * prompt surfaces: the router takes its own `systemPrompt` argument, while each Mastra agent
 * carries baked-in `instructions` fixed at construction time in `engine/agent.ts`. A directive
 * written into either of those places covers one path and silently no-ops on the other —
 * `docs/roadmap.md` recorded exactly that hazard for this feature.
 *
 * So the directive goes into neither. `applyDevilAdvocate` below prefixes it to the prompt
 * `buildPromptText` returns, at the single site above the router-vs-agent fork — so both paths
 * carry it structurally, rather than by anyone remembering to update two prompt strings.
 * (`buildPromptText` itself is untouched; it builds the prompt, this wraps the result.)
 * `engine/agent.ts` is deliberately untouched, and the mode composes with `--agent
 * devops|research` for free, since it rides the prompt rather than one agent's own identity.
 *
 * STATED TRADEOFF: a directive in the user prompt carries less weight with most models than
 * one in the system slot, and the router path does expose a system slot this could also use.
 * Using both would mean two application sites free to drift apart — the defect this shape
 * exists to prevent — so the prompt is the single site. If the mode proves too weak in
 * practice, strengthening the router's system prompt is a follow-up that reads this same
 * constant, and cannot diverge from it.
 *
 * The final clause is load-bearing, not politeness: a mode that asks a model to argue against
 * the user is a mode that invites invented objections. It must not manufacture evidence to
 * win the argument it was told to have.
 */
export const DEVIL_ADVOCATE_DIRECTIVE = [
  "Devil's-advocate mode: argue AGAINST the plan, claim or assumption in the question below,",
  "rather than helping to carry it out. Give the strongest case that it is wrong: the risks it",
  "runs, the edge cases it ignores, and the alternative readings of the evidence it skips. Ground",
  "each",
  "objection in indexed evidence you can cite; where an objection is not supported by the index,",
  "say that it is unsupported rather than inventing support for it. Do not flatten this into a",
  "balanced summary, and do not close by endorsing the plan unless the evidence genuinely",
  "supports it.",
].join(" ");

/** Prefix `prompt` with the directive. Identity when `devil` is false — the default answer must not move. */
export function applyDevilAdvocate(prompt: string, devil: boolean | undefined): string {
  return devil === true ? `${DEVIL_ADVOCATE_DIRECTIVE}\n\n${prompt}` : prompt;
}
