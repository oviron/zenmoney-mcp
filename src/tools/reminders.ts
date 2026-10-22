import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Reminder, ReminderMarker } from "../api.js";
import type { ZenState } from "../state.js";
import { isoDate, localDate } from "../lib/dates.js";
import { accountTitle, currencyOf, tagTitles } from "../lib/format.js";
import { addInterval, occurrenceDates, resolveSchedule, scheduleLimit } from "../lib/reminder-schedule.js";
import { checkStillValid, resolveAccountStrict, resolveMerchantId, resolveTagsStrict, resolveTagStrict } from "../lib/resolve.js";
import { toolError, toolText } from "../lib/result.js";

const BATCH_SIZE = 500;
const filters = {
  account: z.string().optional().describe("Account name or UUID, on either side of the operation"),
  category: z.string().optional().describe("Category name or UUID (exact category)"),
};
const plannedAmountSchema = z.object({
  amount: z.number(), currency: z.string().nullable().describe("Currency shortTitle, or null when unknown"),
  account: z.string().describe("Displayed account title"),
});
const operationSchema = z.object({
  type: z.enum(["expense", "income", "transfer"]),
  outcome: plannedAmountSchema.optional().describe("Outgoing side, only when displayed"),
  income: plannedAmountSchema.optional().describe("Incoming side, only when displayed"),
  categories: z.array(z.string()), payee: z.string().optional(), comment: z.string().optional(),
});
const reminderSchema = operationSchema.extend({
  id: z.string(),
  schedule: z.object({
    interval: z.enum(["day", "week", "month", "year"]).nullable().describe("Null for a one-off operation"),
    startDate: isoDate, endDate: isoDate.nullable().optional().describe("Inclusive end of a recurring schedule; null means no end date"),
    step: z.number().optional(),
    points: z.array(z.number()).optional().describe("Zero-based offsets in interval units within each step window"),
  }),
  nextPlannedDates: z.array(isoDate).describe("At most five displayed future dates from stored planned markers"),
  truncated: z.boolean().describe("Additional stored planned dates are omitted from nextPlannedDates"),
  remainingCount: z.number().int().nonnegative().describe("Number of omitted dates"),
  materializedThrough: isoDate.nullable().describe("Last stored future planned date, or null when none remain"),
});

function operationData(state: ZenState, r: Reminder | ReminderMarker): z.infer<typeof operationSchema> {
  const type = r.incomeAccount !== r.outcomeAccount ? "transfer" : r.outcome > 0 ? "expense" : "income";
  const payee = r.payee ?? state.merchants.find((m) => m.id === r.merchant)?.title;
  return {
    type,
    ...(type !== "income" ? { outcome: { amount: r.outcome, currency: currencyOf(state, r.outcomeInstrument) || null, account: accountTitle(state, r.outcomeAccount) } } : {}),
    ...(type !== "expense" ? { income: { amount: r.income, currency: currencyOf(state, r.incomeInstrument) || null, account: accountTitle(state, r.incomeAccount) } } : {}),
    categories: (r.tag ?? []).map((id) => state.tags.find((tag) => tag.id === id)?.title ?? id),
    ...(payee ? { payee } : {}), ...(r.comment ? { comment: r.comment } : {}),
  };
}

function resolveFilters(state: ZenState, input: { account?: string; category?: string }) {
  let accountId: string | undefined;
  let tagId: string | undefined;
  if (input.account !== undefined) {
    const resolved = resolveAccountStrict(state, input.account);
    if ("error" in resolved) throw new Error(resolved.error);
    accountId = resolved.account.id;
  }
  if (input.category !== undefined) {
    const resolved = resolveTagStrict(state, input.category);
    if ("error" in resolved) throw new Error(resolved.error);
    tagId = resolved.tag.id;
  }
  // zerro keeps its settings in reminders on its service account
  const visible = new Set(state.getVisibleAccounts().map((a) => a.id));
  return (r: Reminder | ReminderMarker) =>
    visible.has(r.incomeAccount) && visible.has(r.outcomeAccount) &&
    (!accountId || r.incomeAccount === accountId || r.outcomeAccount === accountId) &&
    (!tagId || r.tag?.includes(tagId));
}

function operationLine(state: ZenState, r: Reminder | ReminderMarker): string {
  const from = `${r.outcome} ${currencyOf(state, r.outcomeInstrument)} (${accountTitle(state, r.outcomeAccount)})`;
  const to = `${r.income} ${currencyOf(state, r.incomeInstrument)} (${accountTitle(state, r.incomeAccount)})`;
  const amount = r.incomeAccount !== r.outcomeAccount ? `transfer ${from} -> ${to}`
    : r.outcome > 0 ? `expense ${from}` : `income ${to}`;
  const payee = r.payee ?? state.merchants.find((m) => m.id === r.merchant)?.title;
  return `${amount} | ${tagTitles(state, r.tag)}${payee ? ` | ${payee}` : ""}${r.comment ? ` | ${r.comment}` : ""}`;
}

function describeSchedule(r: Reminder): string {
  if (!r.interval) return `one-off on ${r.startDate}`;
  const step = r.step ?? 1;
  const points = r.points ?? [0];
  const day = Number(r.startDate.slice(8));
  const anchor = r.interval === "month" ? `, day ${day} (clamped to month-end)`
    : r.interval === "year" ? `, ${r.startDate.slice(5)} (clamped to month-end)` : "";
  return `every ${step === 1 ? r.interval : `${step} ${r.interval}s`}, from ${r.startDate}${anchor}, offsets ${points.join(", ")} ${r.interval}(s)${r.endDate ? `, until ${r.endDate} inclusive` : ", no end date"}`;
}

function sameVersion<T extends { changed: number }>(sent: T, saved: T | undefined): boolean {
  return saved !== undefined && Object.entries(sent).every(([key, value]) =>
    key === "changed" || JSON.stringify(value) === JSON.stringify(saved[key as keyof T]));
}

function occurrenceOf(r: Reminder, date: string): ReminderMarker {
  const { interval, step, points, startDate, endDate, ...operation } = r;
  return { ...operation, id: randomUUID(), reminder: r.id, date, state: "planned" };
}

export function registerReminderTools(server: McpServer, state: ZenState) {
  server.registerTool("list_reminders", {
    title: "List Reminders",
    description: "List recurring and one-off scheduled operations with their schedules, accounts, amounts, categories, payees and next planned dates. Filters use strict account/category resolution. Finished series are hidden by default. Only stored markers are shown; this tool does not extend schedules.",
    inputSchema: { ...filters, include_finished: z.boolean().default(false).describe("Include series whose endDate is before today") },
    outputSchema: { reminders: z.array(reminderSchema) },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const matches = resolveFilters(state, input);
      const today = localDate(new Date());
      const reminders = state.reminders.filter((r) => matches(r) && (input.include_finished || !r.endDate || r.endDate >= today));
      const planned = new Map<string, string[]>();
      for (const m of state.reminderMarkers) {
        if (m.state !== "planned" || m.date < today) continue;
        const dates = planned.get(m.reminder) ?? [];
        dates.push(m.date);
        planned.set(m.reminder, dates);
      }
      for (const dates of planned.values()) dates.sort();
      const rows: z.infer<typeof reminderSchema>[] = [];
      const lines = reminders.map((r) => {
        const dates = planned.get(r.id) ?? [];
        rows.push({
          ...operationData(state, r), id: r.id,
          schedule: {
            interval: r.interval, startDate: r.startDate,
            ...(r.interval ? { step: r.step ?? 1, points: r.points ?? [0], endDate: r.endDate } : {}),
          },
          nextPlannedDates: dates.slice(0, 5), truncated: dates.length > 5,
          remainingCount: Math.max(0, dates.length - 5), materializedThrough: dates.at(-1) ?? null,
        });
        const upcoming = dates.length ? `${dates.slice(0, 5).join(", ")}${dates.length > 5 ? ` (+${dates.length - 5} more)` : ""}; materialized through ${dates.at(-1)}` : "none";
        return `${operationLine(state, r)} | ${describeSchedule(r)} | next planned: ${upcoming} | id: ${r.id}`;
      });
      return { ...toolText(lines.length ? `${lines.length} reminders:\n${lines.join("\n")}` : "No reminders found."), structuredContent: { reminders: rows } };
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerTool("list_upcoming", {
    title: "List Upcoming Planned Operations",
    description: "List stored planned reminder markers over N calendar days, including today, sorted by date. For example days=7 shows what is scheduled this week. Does not generate more markers; open-ended series are initially materialized for one year from start_date.",
    inputSchema: { ...filters, days: z.number().int().min(1).max(36600).default(7).describe("Calendar days including today (1-36600)") },
    outputSchema: {
      startDate: isoDate, endDate: isoDate.describe("Inclusive end of the range of stored planned markers"),
      operations: z.array(operationSchema.extend({ id: z.string(), reminderId: z.string(), date: isoDate })),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const matches = resolveFilters(state, input);
      const today = localDate(new Date());
      const until = addInterval(today, "day", input.days - 1) ?? "9999-12-31";
      const markers = state.reminderMarkers.filter((m) => m.state === "planned" && m.date >= today && m.date <= until && matches(m))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
      const operations: (z.infer<typeof operationSchema> & { id: string; reminderId: string; date: string })[] = [];
      const lines = markers.map((m) => {
        operations.push({ ...operationData(state, m), id: m.id, reminderId: m.reminder, date: m.date });
        return `${m.date} | ${operationLine(state, m)} | reminder: ${m.reminder} | id: ${m.id}`;
      });
      return {
        ...toolText(`${markers.length} planned operations, ${today} to ${until} inclusive (stored markers only):${markers.length ? "\n" + lines.join("\n") : " none."}`),
        structuredContent: { startDate: today, endDate: until, operations },
      };
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });

  server.registerTool("add_reminder", {
    title: "Add Reminder",
    description: "Plan an expense, income or transfer, once or recurring. Creates the template AND planned markers through end_date inclusive; without end_date materializes one calendar year from start_date, not extended automatically. Uses batches of 500 markers without truncating long series. points are zero-based offsets in interval units within step, NOT weekdays or days of the month: day/step=7/points=[0,2,4] repeats on start_date and 2/4 days later each week. Month/year dates clamp to month-end without drift (Jan 31 -> Feb 28 -> Mar 31). On a partial or uncertain failure, do not repeat: sync and inspect the reported ids.",
    inputSchema: {
      type: z.enum(["expense", "income", "transfer"]).describe("Operation type"),
      account: z.string().optional().describe("Expense/income account name or UUID"),
      from_account: z.string().optional().describe("Transfer source account name or UUID"),
      to_account: z.string().optional().describe("Transfer destination account name or UUID"),
      amount: z.number().positive().optional().describe("Expense/income amount in account currency; alias for transfer outcome_amount"),
      outcome_amount: z.number().positive().optional().describe("Transfer amount in source currency; must equal amount if both are supplied"),
      income_amount: z.number().positive().optional().describe("Transfer amount in destination currency; required across currencies"),
      category: z.union([z.string(), z.array(z.string())]).optional().describe("Category name/UUID or array; empty means uncategorized"),
      payee: z.string().optional().describe("Payee/payer; an exact name links an existing merchant"),
      comment: z.string().optional(),
      interval: z.enum(["day", "week", "month", "year"]).nullable().optional().describe("Omit or null for one-off"),
      step: z.number().int().positive().optional().describe("Window length in interval units; default 1"),
      points: z.array(z.number().int().nonnegative()).optional().describe("Offsets in interval units inside each step window: 0 <= point < step; default [0]. For monthly on the 31st use start_date on the 31st and points=[0]."),
      start_date: isoDate,
      end_date: isoDate.optional().describe("Inclusive end; omit for a one-year materialization horizon"),
      notify: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (input, { signal }) => {
    let reminder: Reminder | undefined;
    let written = 0;
    let through: string | undefined;
    let attempted = false;
    try {
      const schedule = resolveSchedule(input);
      const user = state.getUser();
      if (!user) throw new Error("User not found. Run sync_data first.");
      const transfer = input.type === "transfer";
      if (transfer ? input.account !== undefined : input.from_account !== undefined || input.to_account !== undefined || input.outcome_amount !== undefined || input.income_amount !== undefined) {
        throw new Error("Use account and amount for expense/income; use from_account, to_account and transfer amounts for a transfer.");
      }
      const source = transfer ? input.from_account : input.account;
      const destination = transfer ? input.to_account : input.account;
      if (!source || !destination) throw new Error(transfer ? "from_account and to_account are required." : "account is required.");
      const fromMatch = resolveAccountStrict(state, source);
      if ("error" in fromMatch) throw new Error(fromMatch.error);
      const toMatch = resolveAccountStrict(state, destination);
      if ("error" in toMatch) throw new Error(toMatch.error);
      const from = fromMatch.account;
      const to = toMatch.account;
      if (transfer && from.id === to.id) throw new Error("A transfer needs two different accounts.");
      if (from.type === "debt" || to.type === "debt") {
        throw new Error("Debt accounts cannot be planned here: a debt needs both sides in the ordinary account's currency and a counterparty. Use add_debt when it happens.");
      }
      const outcomeInstrument = from.instrument ?? user.currency;
      const incomeInstrument = to.instrument ?? user.currency;
      if (transfer && input.amount !== undefined && input.outcome_amount !== undefined && input.amount !== input.outcome_amount) {
        throw new Error("amount and outcome_amount must be equal when both are provided.");
      }
      const amount = transfer ? input.outcome_amount ?? input.amount : input.amount;
      if (amount === undefined) throw new Error("amount (or outcome_amount for a transfer) is required.");
      if (transfer && incomeInstrument !== outcomeInstrument && input.income_amount === undefined) {
        throw new Error("Cross-currency transfers require income_amount in the destination currency.");
      }
      const tags = resolveTagsStrict(state, input.category ?? []);
      if ("error" in tags) throw new Error(tags.error);
      reminder = {
        id: randomUUID(), changed: Math.floor(Date.now() / 1000), user: user.id,
        incomeAccount: to.id, incomeInstrument, income: transfer ? input.income_amount ?? amount : input.type === "income" ? amount : 0,
        outcomeAccount: from.id, outcomeInstrument, outcome: input.type === "income" ? 0 : amount,
        tag: tags.tagIds, merchant: resolveMerchantId(state, input.payee), payee: input.payee ?? null, comment: input.comment ?? null,
        ...schedule, notify: input.notify,
      };
      const template = reminder;
      const writeBatch = async (batch: ReminderMarker[]) => {
        const first = written === 0;
        await state.write(() => {
          if (signal.aborted) throw new Error("Cancelled; no further batches were written.");
          checkStillValid(state, [{ account: from, instrument: outcomeInstrument }, { account: to, instrument: incomeInstrument }], tags.tagIds);
          if (!first && !sameVersion(template, state.reminders.find((r) => r.id === template.id))) {
            throw new Error("The reminder was deleted or changed meanwhile; no further markers were written.");
          }
          if (first) template.merchant = resolveMerchantId(state, input.payee);
          for (const m of batch) m.merchant = template.merchant;
          attempted = true;
          return { ...(first ? { reminder: [template] } : {}), reminderMarker: batch };
        }, () => {
          if (first) state.upsertReminder({ ...template });
          state.upsertReminderMarkers(batch);
        });
        const saved = state.reminders.find((r) => r.id === template.id);
        const markersById = new Map(state.reminderMarkers.map((m) => [m.id, m]));
        const confirmed = batch.filter((m) => sameVersion(m, markersById.get(m.id)));
        written += confirmed.length;
        through = confirmed.at(-1)?.date ?? through;
        if (!sameVersion(template, saved) || confirmed.length !== batch.length) {
          throw new Error("ZenMoney kept a different version of the reminder or its markers. Sync and inspect before changing this series further.");
        }
      };
      let batch: ReminderMarker[] = [];
      for (const date of occurrenceDates(schedule)) {
        batch.push(occurrenceOf(template, date));
        if (batch.length === BATCH_SIZE) {
          await writeBatch(batch);
          batch = [];
        }
      }
      if (batch.length) await writeBatch(batch);
      if (written === 0) throw new Error("No dates fall within this schedule. Nothing was saved.");
      return toolText(`Reminder added: ${operationLine(state, template)}\n${describeSchedule(template)}\n${written} planned markers, last date ${through}; materialization limit ${scheduleLimit(schedule)} inclusive.${schedule.interval && !schedule.endDate ? " One calendar year from start_date; not extended automatically." : ""}\nID: ${template.id}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return toolError(`Failed to add reminder: ${reason}${reminder && attempted ? `\nReminder ID: ${reminder.id}. ${written} confirmed marker writes${through ? ` through ${through}` : ""}; the series may be incomplete. Do not repeat add_reminder: run sync_data, inspect list_reminders (include_finished=true) and list_upcoming before further changes.` : ""}`);
    }
  });

  server.registerTool("delete_reminder", {
    title: "Delete Reminder",
    description: "Delete a reminder series by id, and its planned markers dated today or later, using deletion records. Requires confirm=true; otherwise returns a preview. Does not send changes to processed markers or transactions created from them. Past planned markers are retained locally unless the API itself deletes them with the series.",
    inputSchema: { id: z.string().describe("Reminder id from list_reminders"), confirm: z.boolean().default(false) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ id, confirm }, { signal }) => {
    const planned = () => state.reminderMarkers.filter((m) => m.reminder === id && m.state === "planned" && m.date >= localDate(new Date()));
    const target = state.reminders.find((r) => r.id === id);
    // A series deleted elsewhere may leave planned markers behind
    if (!target && planned().length === 0) return toolError(`Reminder ${id} not found. Use list_reminders with include_finished=true.`);
    const today = localDate(new Date());
    if (!confirm) return toolText(`Delete ${target ? operationLine(state, target) : "what is left of a deleted series"} | id: ${id}, and ${planned().length} planned markers from ${today}? Nothing was deleted. Call delete_reminder with confirm=true.`);
    let removed = 0;
    try {
      // The response to a batch may bring markers written meanwhile, so go on
      // until neither the series nor a future planned marker is left
      while (state.reminders.some((r) => r.id === id) || planned().length > 0) {
        let sentIds: string[] = [];
        let sentReminder = false;
        await state.write(() => {
          if (signal.aborted) throw new Error("Cancelled; no further deletions were sent.");
          const current = state.reminders.find((r) => r.id === id);
          const pending = planned();
          const batch = pending.slice(0, BATCH_SIZE);
          const stamp = Math.floor(Date.now() / 1000);
          const deletion = batch.map((m) => ({ object: "reminderMarker", id: m.id, user: m.user, stamp }));
          sentIds = batch.map((m) => m.id);
          sentReminder = current !== undefined && pending.length <= BATCH_SIZE;
          if (current && sentReminder) deletion.push({ object: "reminder", id, user: current.user, stamp });
          return { deletion };
        });
        const remaining = new Set(state.reminderMarkers.map((m) => m.id));
        if (sentIds.some((markerId) => remaining.has(markerId)) || (sentReminder && state.reminders.some((r) => r.id === id))) {
          throw new Error("ZenMoney kept a different version of a deleted object. Sync and inspect before retrying.");
        }
        removed += sentIds.length;
      }
      return toolText(`Reminder deleted: ${id}. Deleted ${removed} future planned markers. No changes were sent for processed markers or created transactions.`);
    } catch (error) {
      return toolError(`Failed to delete reminder ${id}: ${error instanceof Error ? error.message : String(error)}\n${removed} confirmed marker deletions; deletion may be incomplete. Run sync_data and inspect the series before retrying.`);
    }
  });
}
