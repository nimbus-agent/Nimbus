/**
 * Common shape every connector item-mapper returns. The `service` and `type`
 * string-literal types are supplied per connector; the remaining ten fields
 * are uniform across all mappers.
 */
export interface MappedRow<S extends string, T extends string> {
  readonly service: S;
  readonly type: T;
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}
