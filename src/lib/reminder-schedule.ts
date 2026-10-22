import type { Reminder } from "../api.js";
import { isoDate } from "./dates.js";

type Interval = NonNullable<Reminder["interval"]>;
type Schedule = Pick<Reminder, "interval" | "step" | "points" | "startDate" | "endDate">;

export function addInterval(date: string, interval: Interval, offset: number): string | undefined {
  const [year, month, day] = date.split("-").map(Number);
  const result = new Date(0);
  if (interval === "day" || interval === "week") {
    result.setUTCFullYear(year, month - 1, day + offset * (interval === "week" ? 7 : 1));
  } else {
    const months = year * 12 + month - 1 + offset * (interval === "year" ? 12 : 1);
    const targetYear = Math.floor(months / 12);
    const targetMonth = months % 12;
    result.setUTCFullYear(targetYear, targetMonth + 1, 0);
    result.setUTCDate(Math.min(day, result.getUTCDate()));
  }
  const targetYear = result.getUTCFullYear();
  if (!Number.isFinite(result.getTime()) || targetYear < 0 || targetYear > 9999) return undefined;
  return result.toISOString().slice(0, 10);
}

export function resolveSchedule(input: {
  interval?: Interval | null;
  step?: number;
  points?: number[];
  start_date: string;
  end_date?: string;
}): Schedule {
  const startDate = isoDate.parse(input.start_date);
  const endDate = input.end_date === undefined ? null : isoDate.parse(input.end_date);
  if (endDate && endDate < startDate) throw new Error("end_date must be on or after start_date.");
  const interval = input.interval ?? null;
  if (!interval) {
    if (input.step !== undefined || input.points !== undefined) {
      throw new Error("step and points require an interval; omit them for a one-off reminder.");
    }
    return { interval, step: null, points: null, startDate, endDate: endDate ?? startDate };
  }
  const step = input.step ?? 1;
  if (!Number.isSafeInteger(step) || step < 1) throw new Error("step must be a positive safe integer.");
  const points = input.points ?? [0];
  if (points.length === 0 || points.some((p) => !Number.isSafeInteger(p) || p < 0 || p >= step)) {
    throw new Error(`points must contain offsets in ${interval} units inside the step window: integers from 0 to ${step - 1}. They are not days of the month.`);
  }
  return { interval, step, points: [...new Set(points)].sort((a, b) => a - b), startDate, endDate };
}

export function scheduleLimit(schedule: Schedule): string {
  return schedule.endDate ?? addInterval(schedule.startDate, "year", 1) ?? "9999-12-31";
}

export function* occurrenceDates(schedule: Schedule): Generator<string> {
  if (!schedule.interval) {
    yield schedule.startDate;
    return;
  }
  const limit = scheduleLimit(schedule);
  const step = schedule.step ?? 1;
  const points = schedule.points ?? [0];
  for (let offset = 0; ; offset += step) {
    for (const point of points) {
      // Always offset from the original date: February's clamp must not move March's 31st.
      const date = addInterval(schedule.startDate, schedule.interval, offset + point);
      if (!date || date > limit) return;
      yield date;
    }
  }
}
