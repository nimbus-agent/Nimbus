import type { RegistryErrorCode } from "@nimbus-dev/registry-format";

/** Registry errors that mean the bytes could not be FETCHED, as opposed to fetched and refused. */
export const FETCH_FAILURE_CODES: ReadonlySet<RegistryErrorCode> = new Set<RegistryErrorCode>([
  "ERR_REGISTRY_UNREACHABLE",
  "ERR_REGISTRY_AIR_GAP",
  "ERR_REGISTRY_TRANSPORT_REFUSED",
  "ERR_REGISTRY_TOO_LARGE",
  "ERR_REGISTRY_NOT_FOUND",
]);
