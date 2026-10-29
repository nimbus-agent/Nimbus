import {
  isPromotedInstall,
  type PromotedInstallResult,
} from "../../src/extensions/install-from-local.ts";

/** Narrows an install result to a real install; a test that expected one fails on a promotion. */
export function assertInstalled<T extends object>(r: T | PromotedInstallResult): asserts r is T {
  if (isPromotedInstall(r)) {
    throw new Error(`${r.id} was promoted, not installed`);
  }
}
