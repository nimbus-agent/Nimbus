import type { UpdatePlan } from "../../src/extensions/auto-update-types.ts";
import type { RegistryDependencyResolver } from "../../src/extensions/registry/registry-dependency-fetcher.ts";

/**
 * An update plan that adds nothing, for test bags whose update has no dependencies: the approval
 * then asks exactly as before. Its resolver verifies nothing (nothing is added to show).
 */
export function emptyUpdatePlan(): UpdatePlan {
  const resolver = { verified: () => undefined } as unknown as RegistryDependencyResolver;
  return { resolver, plan: { nodes: [] }, addedPackages: [] };
}

/** `planUpdate` for such a bag. */
export const planNothing = (): Promise<UpdatePlan> => Promise.resolve(emptyUpdatePlan());
