import { itemPrimaryKey } from "../../index/item-store.ts";

export interface BuildIndexedItemInput {
  readonly service: string;
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview?: string;
  readonly url?: string | null;
  readonly canonicalUrl?: string | null;
  readonly modifiedAt: number;
  readonly authorId?: string | null;
  readonly metadata?: Record<string, unknown>;
  readonly pinned?: boolean;
  readonly syncedAt: number;
}

export interface BuiltIndexedItem {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview?: string;
  readonly url?: string | null;
  readonly canonicalUrl?: string | null;
  readonly modifiedAt: number;
  readonly authorId?: string | null;
  readonly metadata: Record<string, unknown>;
  readonly pinned?: boolean;
  readonly syncedAt: number;
}

export function buildIndexedItem(input: BuildIndexedItemInput): BuiltIndexedItem {
  if (input.externalId.length === 0) {
    throw new Error("externalId must be non-empty");
  }
  return {
    id: itemPrimaryKey(input.service, input.externalId),
    service: input.service,
    type: input.type,
    externalId: input.externalId,
    title: input.title,
    modifiedAt: input.modifiedAt,
    metadata: input.metadata ?? {},
    syncedAt: input.syncedAt,
    ...(input.bodyPreview !== undefined && { bodyPreview: input.bodyPreview }),
    ...(input.url !== undefined && { url: input.url }),
    ...(input.canonicalUrl !== undefined && { canonicalUrl: input.canonicalUrl }),
    ...(input.authorId !== undefined && { authorId: input.authorId }),
    ...(input.pinned !== undefined && { pinned: input.pinned }),
  };
}
