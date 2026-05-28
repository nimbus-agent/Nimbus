export interface GreenhouseSearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function namedArrayText(row: Record<string, unknown>, key: string): string {
  const arr = row[key];
  if (!Array.isArray(arr)) {
    return "";
  }
  const names: string[] = [];
  for (const e of arr) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      continue;
    }
    const name = (e as Record<string, unknown>)["name"];
    if (typeof name === "string") {
      names.push(name);
    }
  }
  return names.join(" ");
}

function officeLocationText(row: Record<string, unknown>): string {
  const arr = row["offices"];
  if (!Array.isArray(arr)) {
    return "";
  }
  const locs: string[] = [];
  for (const e of arr) {
    if (e === null || typeof e !== "object" || Array.isArray(e)) {
      continue;
    }
    const loc = (e as Record<string, unknown>)["location"];
    if (loc === null || typeof loc !== "object" || Array.isArray(loc)) {
      continue;
    }
    const name = (loc as Record<string, unknown>)["name"];
    if (typeof name === "string") {
      locs.push(name);
    }
  }
  return locs.join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  const name = stringField(row, "name");
  const status = stringField(row, "status");
  const requisitionId = stringField(row, "requisition_id");
  const departments = namedArrayText(row, "departments");
  const offices = namedArrayText(row, "offices");
  const officeLocations = officeLocationText(row);
  return `${name} ${status} ${requisitionId} ${departments} ${offices} ${officeLocations}`.toLowerCase();
}

export function filterGreenhouseJobs(
  jobs: readonly unknown[],
  options: GreenhouseSearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of jobs) {
    if (it === null || typeof it !== "object") {
      continue;
    }
    const row = it as Record<string, unknown>;
    if (!buildHaystack(row).includes(needle)) {
      continue;
    }
    out.push(it);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}
