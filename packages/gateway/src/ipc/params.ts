import type { ZodType } from "zod";

export function parseParams<T>(raw: unknown, schema: ZodType<T>): T {
  return schema.parse(raw);
}
