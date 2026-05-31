import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type MiroSearchMatchOptions = SearchMatchOptions;

/**
 * Miro board objects are flat — `{ id, name, description, owner: { name }, ... }`.
 * Match against the board name, description, and owner name (case-insensitive
 * substring). The owner is itself a nested object.
 */
function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  const owner = asObjectish(row["owner"]) ?? {};
  return [stringField(row, "name"), stringField(row, "description"), stringField(owner, "name")];
}

export const filterMiroBoards = makeQueryFilter(fieldsOf);
