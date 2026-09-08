/**
 * All user-visible attendance times in Qaans ERP are in India Standard Time.
 *
 * Backend already stores/returns times as IST strings (see `ist_time_str()`
 * in `backend/server.py`). This util exists for any client-side fallback
 * that isn't populated from the server — so no code path silently uses the
 * device local time.
 */

const IST_TZ = "Asia/Kolkata";

/** e.g. `"08:42 AM"` — the same shape the backend uses for `AttendanceRecord.time`. */
export function nowIstTime(now: Date = new Date()): string {
  return now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: IST_TZ,
  });
}

/** e.g. `"Fri, 5 Sep 2026"` — long-form IST date, useful for headers. */
export function todayIstLabel(now: Date = new Date()): string {
  return now.toLocaleDateString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: IST_TZ,
  });
}

/** e.g. `"2026-09-05"` — machine-parseable IST date. */
export function todayIstIso(now: Date = new Date()): string {
  // en-CA gives an ISO-shaped YYYY-MM-DD, respecting the timeZone option.
  return now.toLocaleDateString("en-CA", { timeZone: IST_TZ });
}
