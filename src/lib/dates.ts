import { z } from "zod";

/**
 * A YYYY-MM-DD string that is also a real calendar day. The format check
 * alone lets 2026-02-30 through to the API.
 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
  .refine(isCalendarDate, "Date must be a real calendar day");

export function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  // setUTCFullYear, unlike Date.UTC, does not map years 0-99 to 1900-1999
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * YYYY-MM-DD of the given moment in this machine's timezone. Transaction
 * dates are calendar days as the user sees them, while toISOString() gives the
 * UTC day, which east of Greenwich is still yesterday for the first hours
 * after midnight.
 */
export function localDate(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}
