export function sanitizeExternalError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replaceAll(/(key|token|secret|Bearer)\s*[=:]\s*\S{8,}/gi, "[REDACTED]");
}
