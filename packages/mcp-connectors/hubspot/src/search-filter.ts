import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type HubspotSearchMatchOptions = SearchMatchOptions;

/**
 * HubSpot deal objects nest their searchable text under a `properties` map:
 * `{ id, properties: { dealname, dealstage, pipeline, ... } }`. Match against the
 * deal name, stage, and pipeline (case-insensitive substring).
 */
function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  const props = asObjectish(row["properties"]) ?? {};
  return [
    stringField(props, "dealname"),
    stringField(props, "dealstage"),
    stringField(props, "pipeline"),
  ];
}

export const filterHubspotDeals = makeQueryFilter(fieldsOf);
