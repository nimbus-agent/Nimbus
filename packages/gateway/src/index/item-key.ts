/**
 * The `<service>:<externalId>` primary key shared by the item table and the
 * graph populator. Lives in its own dependency-free module because
 * `item-store.ts` imports the populator — importing the key helper back out
 * of `item-store` would close a cycle.
 */
export function itemPrimaryKey(service: string, externalId: string): string {
  const prefix = `${service}:`;
  if (externalId.startsWith(prefix)) {
    return externalId;
  }
  return `${service}:${externalId}`;
}
