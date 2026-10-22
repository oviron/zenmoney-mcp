import type { Reminder, ReminderMarker } from "../src/api.js";

export function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "reminder-1", changed: 1000, user: 1,
    incomeAccount: "acc-checking", incomeInstrument: 1, income: 0,
    outcomeAccount: "acc-checking", outcomeInstrument: 1, outcome: 50,
    tag: ["tag-food"], merchant: null, payee: "Rent", comment: null,
    interval: "month", step: 1, points: [0], startDate: "2026-01-31", endDate: null, notify: false,
    ...overrides,
  };
}

export function marker(overrides: Partial<ReminderMarker> = {}): ReminderMarker {
  const { interval, step, points, startDate, endDate, ...fields } = reminder();
  return { ...fields, id: "marker-1", reminder: "reminder-1", date: "2026-01-31", state: "planned", ...overrides };
}
