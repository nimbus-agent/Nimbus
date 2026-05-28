export type PagerdutyIncidentSeed = {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt?: string;
  status: "triggered" | "acknowledged" | "resolved";
  htmlUrl?: string;
  priorityName?: string | null;
  serviceId?: string | null;
};

export function buildPagerdutyIncident(seed: PagerdutyIncidentSeed): Record<string, unknown> {
  const row: Record<string, unknown> = {
    id: seed.id,
    title: seed.title ?? `Incident ${seed.id}`,
    created_at: seed.createdAt,
    updated_at: seed.updatedAt ?? seed.createdAt,
    status: seed.status,
  };
  if (seed.htmlUrl !== undefined) {
    row.html_url = seed.htmlUrl;
  }
  if (seed.priorityName === null) {
    row.priority = null;
  } else if (seed.priorityName !== undefined) {
    row.priority = { id: `pri_${seed.priorityName}`, name: seed.priorityName };
  }
  if (seed.serviceId !== null && seed.serviceId !== undefined) {
    row.service = { id: seed.serviceId, summary: `Service ${seed.serviceId}` };
  }
  return row;
}
