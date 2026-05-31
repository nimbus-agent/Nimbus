import {
  asObjectish,
  makeQueryFilter,
  type SearchMatchOptions,
  stringField,
} from "../../shared/search-filter.ts";

export type RampSearchMatchOptions = SearchMatchOptions;

function cardHolderName(row: Record<string, unknown>): string {
  const holder = asObjectish(row["card_holder"]);
  if (holder === undefined) {
    return "";
  }
  const first = stringField(holder, "first_name") ?? "";
  const last = stringField(holder, "last_name") ?? "";
  const dept = stringField(holder, "department_name") ?? "";
  return [first, last, dept].filter((p) => p !== "").join(" ");
}

function fieldsOf(item: unknown): readonly string[] | null {
  const row = asObjectish(item);
  if (row === undefined) {
    return null;
  }
  return [
    stringField(row, "merchant_name"),
    stringField(row, "sk_category_name"),
    stringField(row, "state"),
    stringField(row, "currency_code"),
    stringField(row, "memo"),
    cardHolderName(row),
  ];
}

export const filterRampTransactions = makeQueryFilter(fieldsOf);
