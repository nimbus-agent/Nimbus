import { type ConsentServer, createWriteToolRegistrar } from "../../shared/consent-kit.ts";
/**
 * Apple Calendar tool handlers (read + write) over an injected CalDavClient.
 *
 * All three tools are registered here and wired into registerAppleTools in Task C3.
 * The real CalDavClient (tsdav) lives in server.ts (coverage-excluded); this module
 * depends only on the injectable interface, making it fully unit-testable.
 */

import { buildVEvent } from "@nimbus-dev/sdk";
import { z } from "zod";
import { createRegisterSimpleTool, mcpJsonResult } from "../../shared/mcp-tool-kit.ts";
import { capPreview } from "./apple-mail-core.ts";
import {
  type CalDavClient,
  type CalendarRef,
  clampInstances,
  selectCalendars,
} from "./caldav-core.ts";

// ---------------------------------------------------------------------------
// Config shape (calendar subsection)
// ---------------------------------------------------------------------------

export interface CalendarToolConfig {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  /** Maximum events returned across all calendars (default: 200). */
  readonly maxInstances?: number;
}

// ---------------------------------------------------------------------------
// Zod arg schemas
// ---------------------------------------------------------------------------

const listArgs = z.object({
  startUtc: z.string().min(1),
  endUtc: z.string().min(1),
  calendar: z.string().min(1).optional(),
});

const createArgs = z.object({
  calendar: z.string().min(1).optional(),
  summary: z.string().min(1).max(1000),
  start: z.string().min(1),
  end: z.string().min(1),
  description: z.string().max(10_000).optional(),
  location: z.string().max(500).optional(),
  attendees: z.array(z.email()).optional(),
  uid: z.string().min(1).optional(),
});

const deleteArgs = z.object({
  href: z.string().min(1),
});

// ---------------------------------------------------------------------------
// ViewEvent — the shape returned to the LLM
// ---------------------------------------------------------------------------

interface ViewEvent {
  href: string;
  uid: string;
  summary: string | null;
  start: string | null;
  end: string | null;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  status: string | null;
  attendees: readonly string[];
  rrule: string | null;
  notes: string;
  calendar: string;
}

const DEFAULT_MAX_INSTANCES = 200;

// ---------------------------------------------------------------------------
// registerAppleCalendarTools
// ---------------------------------------------------------------------------

/**
 * Register the three iCloud Calendar tools onto an MCP server.
 *
 * @param server  - The MCP server instance.
 * @param options - Injected dependencies: the CalDAV client, a `now` factory
 *                  (returns the current UTC timestamp in iCalendar DTSTAMP
 *                  format, e.g. "20260601T090000Z"), and optional config.
 */
export function registerAppleCalendarTools(
  // Widened: the consent kit needs the real server surface, not just the `.tool` shim.
  server: ConsentServer & { tool: (...args: never) => unknown },
  options: {
    calendar: CalDavClient;
    now: () => string;
    config?: CalendarToolConfig | undefined;
  },
): void {
  const { calendar, now, config } = options;
  const maxInstances = config?.maxInstances ?? DEFAULT_MAX_INSTANCES;
  const registerSimpleTool = createRegisterSimpleTool(server);

  // -------------------------------------------------------------------------
  // apple_calendar_list
  // -------------------------------------------------------------------------

  registerSimpleTool(
    "apple_calendar_list",
    "List events across iCloud Calendar within a UTC time window. Returns event summaries, start/end times, location, organizer, attendee emails, and a <=2000-char notes preview. NEVER returns full event descriptions beyond the capped preview.",
    listArgs.shape,
    async (args: unknown) => {
      const parsed = listArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }

      const window = { startUtc: parsed.data.startUtc, endUtc: parsed.data.endUtc };

      let allCals = await calendar.listCalendars();

      // Filter by caller-supplied single calendar name or global config
      if (parsed.data.calendar === undefined) {
        allCals = selectCalendars(allCals, {
          include: config?.include,
          exclude: config?.exclude,
        });
      } else {
        allCals = selectCalendars(allCals, { include: [parsed.data.calendar] });
      }

      const items: ViewEvent[] = [];

      for (const cal of allCals) {
        const rows = await calendar.listEvents(cal, window);
        const clamped = clampInstances(rows, maxInstances - items.length);

        for (const { href, event } of clamped) {
          items.push({
            href,
            uid: event.uid,
            summary: event.summary,
            start: event.start,
            end: event.end,
            allDay: event.allDay,
            location: event.location,
            organizer: event.organizer,
            status: event.status,
            attendees: event.attendees,
            rrule: event.rrule,
            notes: capPreview(event.description ?? ""),
            calendar: cal.displayName,
          });
        }

        if (items.length >= maxInstances) {
          break;
        }
      }

      return mcpJsonResult({ items });
    },
  );

  // -------------------------------------------------------------------------
  // apple_calendar_event_create
  // -------------------------------------------------------------------------

  const registerWriteTool = createWriteToolRegistrar(server, {
    connector: "apple",
    scopeEnv: "NIMBUS_MCP_APPLE_WRITE_SCOPE",
    scopeKinds: ["calendar"],
  });

  registerWriteTool(
    "apple_calendar_event_create",
    {
      mutates: "apple.calendar.event.create",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "calendar", value: p.calendar ?? "default" }),
    },
    "Create a new event in iCloud Calendar via CalDAV PUT.",
    createArgs,
    async (parsedData) => {
      const parsed = { success: true as const, data: parsedData };

      // Resolve the target calendar
      let targetCal: CalendarRef | undefined;
      const allCals = await calendar.listCalendars();

      if (parsed.data.calendar === undefined) {
        const selected = selectCalendars(allCals, {
          include: config?.include,
          exclude: config?.exclude,
        });
        targetCal = selected[0];
        if (targetCal === undefined) {
          throw new Error("No calendar available to create the event in");
        }
      } else {
        targetCal = selectCalendars(allCals, { include: [parsed.data.calendar] })[0];
        if (targetCal === undefined) {
          throw new Error(`Calendar "${parsed.data.calendar}" not found`);
        }
      }

      // Capture a single timestamp so the derived UID and the DTSTAMP never
      // diverge (the injected now() returns a fresh value on each call).
      const stamp = now();
      // Determine UID: caller may supply one (for deterministic tests; Zod
      // rejects ""); otherwise derive from the captured stamp + summary to
      // avoid a non-pure Date.now().
      const uid =
        parsed.data.uid ??
        `nimbus-${stamp}-${parsed.data.summary.slice(0, 40).replace(/\s+/g, "-")}`;

      // Build the VEVENT ICS string
      const buildInput: {
        uid: string;
        summary: string;
        start: string;
        end: string;
        description?: string;
        location?: string;
        attendees?: readonly string[];
      } = {
        uid,
        summary: parsed.data.summary,
        start: parsed.data.start,
        end: parsed.data.end,
      };
      if (parsed.data.description !== undefined) {
        buildInput.description = parsed.data.description;
      }
      if (parsed.data.location !== undefined) {
        buildInput.location = parsed.data.location;
      }
      if (parsed.data.attendees !== undefined && parsed.data.attendees.length > 0) {
        buildInput.attendees = parsed.data.attendees;
      }

      const ics = buildVEvent(buildInput, stamp);

      // PUT the event to the CalDAV server
      const { href } = await calendar.putEvent(targetCal, uid, ics);

      return mcpJsonResult({ uid, href });
    },
  );

  // -------------------------------------------------------------------------
  // apple_calendar_event_delete
  // -------------------------------------------------------------------------

  registerWriteTool(
    "apple_calendar_event_delete",
    {
      mutates: "apple.calendar.event.delete",
      // A deleted CalDAV event is gone from the server; the href is all that identifies it
      // afterwards, so it IS the pre-state.
      recoverable: false,
      capturePreState: (p) => Promise.resolve({ href: p.href }),
      scopeTargetOf: (p) => ({ kind: "calendar", value: p.href }),
    },
    "Delete an event from iCloud Calendar via CalDAV DELETE by href.",
    deleteArgs,
    async (parsedData) => {
      const parsed = { success: true as const, data: parsedData };

      await calendar.deleteEvent(parsed.data.href);

      return mcpJsonResult({ deleted: true });
    },
  );
}

// Re-export the types needed by tests and tools.ts
export type { CalDavClient, CalendarRef };
