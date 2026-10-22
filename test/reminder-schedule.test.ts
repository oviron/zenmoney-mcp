import { describe, expect, it } from "vitest";
import { occurrenceDates, resolveSchedule } from "../src/lib/reminder-schedule.js";

function dates(input: Parameters<typeof resolveSchedule>[0]) {
  return [...occurrenceDates(resolveSchedule(input))];
}

describe("reminder calendar schedules", () => {
  it("plans a single date for a non-recurring reminder", () => {
    expect(dates({ start_date: "2026-03-20" })).toEqual(["2026-03-20"]);
  });

  it("uses the API's offsets inside a step window for daily points", () => {
    expect(dates({ interval: "day", step: 7, points: [4, 0, 2, 2], start_date: "2017-03-08", end_date: "2017-03-19" }))
      .toEqual(["2017-03-08", "2017-03-10", "2017-03-12", "2017-03-15", "2017-03-17", "2017-03-19"]);
  });

  it("uses weekly step and points across a daylight saving transition", () => {
    expect(dates({ interval: "week", step: 3, points: [0, 2], start_date: "2026-03-22", end_date: "2026-04-26" }))
      .toEqual(["2026-03-22", "2026-04-05", "2026-04-12", "2026-04-26"]);
  });

  it("clamps month-end to February and returns to the original 31st without drift", () => {
    expect(dates({ interval: "month", step: 2, points: [0, 1], start_date: "2026-01-31", end_date: "2026-05-31" }))
      .toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("clamps leap days and restores February 29 in the next leap year", () => {
    expect(dates({ interval: "year", step: 3, points: [0, 1], start_date: "2024-02-29", end_date: "2028-02-29" }))
      .toEqual(["2024-02-29", "2025-02-28", "2027-02-28", "2028-02-29"]);
  });

  it("does not treat years 0-99 as 1900-1999", () => {
    expect(dates({ interval: "month", start_date: "0096-01-31", end_date: "0096-03-31" }))
      .toEqual(["0096-01-31", "0096-02-29", "0096-03-31"]);
  });

  it("generates all 1096 dates of a long daily series, including end_date", () => {
    const all = dates({ interval: "day", start_date: "2024-01-01", end_date: "2026-12-31" });
    expect(all).toHaveLength(1096);
    expect(new Set(all).size).toBe(1096);
    expect(all[0]).toBe("2024-01-01");
    expect(all.at(-1)).toBe("2026-12-31");
  });

  it("materializes an open-ended series through one calendar year from its start", () => {
    const all = dates({ interval: "day", start_date: "2024-02-29" });
    expect(all).toHaveLength(366);
    expect(all.at(-1)).toBe("2025-02-28");
  });

  it("stops safely at the last supported calendar date", () => {
    expect(dates({ interval: "year", start_date: "9999-12-31" })).toEqual(["9999-12-31"]);
  });

  it.each(["day", "week", "month", "year"] as const)("validates points against step for %s", (interval) => {
    for (const points of [[], [-1], [2], [0.5], [NaN]]) {
      expect(() => resolveSchedule({ interval, step: 2, points, start_date: "2026-01-01" })).toThrow(/points/);
    }
  });

  it("rejects points=31 for a monthly step=1: points are offsets, not month days", () => {
    expect(() => resolveSchedule({ interval: "month", points: [31], start_date: "2026-01-31" })).toThrow(/points/);
  });

  it.each([
    { step: 2 }, { points: [0] }, { interval: "day", step: 0 },
    { interval: "week", step: -1 }, { interval: "month", step: 1.5 },
    { end_date: "2026-01-01" }, { start_date: "2026-02-30" }, { end_date: "2026-02-30" },
  ])("rejects an invalid schedule %j", (overrides) => {
    expect(() => resolveSchedule({ start_date: "2026-03-01", ...overrides } as Parameters<typeof resolveSchedule>[0])).toThrow();
  });
});
