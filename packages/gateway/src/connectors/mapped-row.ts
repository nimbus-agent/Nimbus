// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
/**
 * Common shape every connector item-mapper returns. The `service` and `type`
 * string-literal types are supplied per connector; every other field is uniform
 * across all mappers except the nullability of `canonicalUrl`.
 *
 * `C` is that nullability: a mapper that always derives a canonical URL passes
 * `string`, so its callers can rely on one being present. It defaults to
 * `string | null`, which is what most mappers return.
 */
export interface MappedRow<
  S extends string,
  T extends string,
  C extends string | null = string | null,
> {
  readonly service: S;
  readonly type: T;
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: C;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}
