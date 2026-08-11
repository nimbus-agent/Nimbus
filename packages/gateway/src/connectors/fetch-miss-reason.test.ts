import { expect, test } from "bun:test";

import { fetchOneMissForResponse } from "./fetch-miss-reason.ts";

test("401 and 403 are unauthorized", () => {
  expect(fetchOneMissForResponse(401)).toEqual({ status: "not_found", reason: "unauthorized" });
  expect(fetchOneMissForResponse(403)).toEqual({ status: "not_found", reason: "unauthorized" });
});

test("404 is absent", () => {
  expect(fetchOneMissForResponse(404)).toEqual({ status: "not_found", reason: "absent" });
});

// Routed to the EXISTING rate_limited arm, not a reason: the clipper already
// handles that arm, so provider throttling becomes actionable with no client change.
test("429 is rate_limited, not a not_found reason", () => {
  expect(fetchOneMissForResponse(429)).toEqual({ status: "rate_limited" });
});

test("5xx and anything else are upstream_error", () => {
  expect(fetchOneMissForResponse(500)).toEqual({ status: "not_found", reason: "upstream_error" });
  expect(fetchOneMissForResponse(418)).toEqual({ status: "not_found", reason: "upstream_error" });
});
