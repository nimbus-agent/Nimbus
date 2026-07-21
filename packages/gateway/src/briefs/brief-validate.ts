import { MAX_BRIEF_CHARS, MAX_SOURCES_PER_RUN } from "./brief-constants.ts";

/**
 * Hand-rolled validation, mirroring `clips/clip-ingest.ts` `ClipValidationError`.
 * `field` becomes the 400 body's `field` and the audit `reason` (`invalid_<field>`),
 * so it must never contain user data — only fixed field names.
 */
export class BriefValidationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "BriefValidationError";
    if (field !== undefined) this.field = field;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new BriefValidationError("body must be a JSON object");
  }
  return v as Record<string, unknown>;
}

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new BriefValidationError(`${field} must be a non-empty string`, field);
  }
  return v;
}

export type CreateBody = {
  brief: string;
  sources: { url: string; title: string }[];
  useIndex: boolean;
};

export function validateCreateInput(raw: unknown): CreateBody {
  const rec = asRecord(raw);

  const brief = nonEmptyString(rec["brief"], "brief");
  if (brief.length > MAX_BRIEF_CHARS) {
    throw new BriefValidationError(`brief exceeds ${MAX_BRIEF_CHARS} characters`, "brief");
  }

  const rawSources = rec["sources"];
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw new BriefValidationError("sources must be a non-empty array", "sources");
  }
  if (rawSources.length > MAX_SOURCES_PER_RUN) {
    throw new BriefValidationError(`at most ${MAX_SOURCES_PER_RUN} sources`, "sources");
  }

  const sources = rawSources.map((s) => {
    if (typeof s !== "object" || s === null || Array.isArray(s)) {
      throw new BriefValidationError("each source must be an object", "sources");
    }
    const rec2 = s as Record<string, unknown>;
    if (typeof rec2["url"] !== "string" || rec2["url"].trim().length === 0) {
      throw new BriefValidationError("each source needs a url", "sources");
    }
    if (typeof rec2["title"] !== "string") {
      throw new BriefValidationError("each source needs a title", "sources");
    }
    return { url: rec2["url"], title: rec2["title"] };
  });

  return { brief, sources, useIndex: rec["useIndex"] === true };
}

export type SourceBody = {
  url: string;
  title: string;
  body: string;
  capturedAt: number;
  truncated: boolean;
};

export function validateSourceInput(raw: unknown): SourceBody {
  const rec = asRecord(raw);
  const url = nonEmptyString(rec["url"], "url");
  if (typeof rec["title"] !== "string") {
    throw new BriefValidationError("title must be a string", "title");
  }
  const body = nonEmptyString(rec["body"], "body");
  // Epoch MILLISECONDS. A seconds value (~1.7e9) is a finite number too, so a bare
  // isFinite check would accept it silently and store modifiedAt in 1970 — wrong data,
  // no error, found much later. 1e12 is 2001-09-09; nothing legitimate predates it here.
  if (
    typeof rec["capturedAt"] !== "number" ||
    !Number.isFinite(rec["capturedAt"]) ||
    rec["capturedAt"] < 1e12
  ) {
    throw new BriefValidationError("capturedAt must be epoch milliseconds", "capturedAt");
  }
  return {
    url,
    title: rec["title"],
    body,
    capturedAt: rec["capturedAt"],
    truncated: rec["truncated"] === true,
  };
}
