import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ZenMoneyError, type DiffResponse } from "../src/api.js";
import { CHECKING, DEBT_ACCOUNT, FOOD, makeDiffResponse, makeTransaction } from "./fixtures.js";
import { connectPair, createMcpPair, createSyncedState, getTextContent } from "./helpers.js";
import { reminder, marker } from "./reminder-fixtures.js";

let client: Client;
let server: McpServer;

async function setup(overrides: Partial<DiffResponse> = {}) {
  const { api, state } = await createSyncedState(overrides);
  const pair = await createMcpPair(api, state);
  client = pair.client;
  server = pair.server;
  await connectPair(pair);
  vi.mocked(api.diff).mockResolvedValue(makeDiffResponse({ account: [], tag: [] }));
  return { api, state, call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) };
}

afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.useRealTimers();
});

const expense = { type: "expense", account: "Checking", amount: 50, start_date: "2026-01-31" };

describe("reminder review fixes", () => {
  it("refuses a debt account", async () => {
    const { api, call } = await setup({ account: [CHECKING, DEBT_ACCOUNT] });
    const result = await call("add_reminder", { type: "transfer", from_account: "Checking", to_account: "Debts", amount: 5, start_date: "2026-01-31" });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("Use add_debt");
    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it("hides zerro's settings kept in reminders on its service account", async () => {
    const zerro = { ...CHECKING, id: "acc-zerro", title: "🤖 [Zerro Data]" };
    const { call } = await setup({
      account: [CHECKING, zerro],
      reminder: [reminder(), reminder({ id: "zerro-settings", incomeAccount: "acc-zerro", outcomeAccount: "acc-zerro" })],
      reminderMarker: [marker({ id: "zerro-marker", reminder: "zerro-settings", incomeAccount: "acc-zerro", outcomeAccount: "acc-zerro", date: "2099-01-01" })],
    });
    expect(getTextContent(await call("list_reminders", { include_finished: true }))).not.toContain("zerro-settings");
    expect(getTextContent(await call("list_upcoming", { days: 36600 }))).not.toContain("zerro-marker");
  });

  it("counts markers instead of listing their ids when the outcome is unknown", async () => {
    const { api, call } = await setup();
    vi.mocked(api.diff).mockRejectedValueOnce(new ZenMoneyError("timed out", true));
    const text = getTextContent(await call("add_reminder", { ...expense, interval: "day", end_date: "2026-03-31" }));
    expect(text).toContain("60 reminder markers");
    expect(text.length).toBeLessThan(2000);
  });
});

describe("reminder tools", () => {
  it("registers read-only listings and explicit write annotations", async () => {
    await setup();
    const { tools } = await client.listTools();
    for (const name of ["list_reminders", "list_upcoming"]) {
      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
    expect(tools.find((t) => t.name === "add_reminder")?.annotations?.idempotentHint).toBe(false);
    expect(tools.find((t) => t.name === "delete_reminder")?.annotations?.destructiveHint).toBe(true);
  });

  it("adds a categorized expense with its own planned marker and caches both", async () => {
    const { api, state, call } = await setup();
    const result = await call("add_reminder", { ...expense, category: "Food", payee: "corner cafe", comment: "invoice", notify: true });
    expect(result.isError).toBeFalsy();
    const sent = vi.mocked(api.diff).mock.calls[1][0];
    expect(sent.transaction).toBeUndefined();
    expect(sent.reminder).toEqual([expect.objectContaining({
      income: 0, outcome: 50, incomeAccount: CHECKING.id, outcomeAccount: CHECKING.id,
      tag: [FOOD.id], payee: "corner cafe", merchant: "merchant-cafe", comment: "invoice",
      interval: null, step: null, points: null, startDate: "2026-01-31", endDate: "2026-01-31", notify: true,
    })]);
    expect(sent.reminderMarker).toEqual([expect.objectContaining({
      reminder: sent.reminder![0].id, date: "2026-01-31", state: "planned", outcome: 50, notify: true,
    })]);
    expect(state.reminders).toEqual(sent.reminder);
    expect(state.reminderMarkers).toEqual(sent.reminderMarker);
    expect(getTextContent(result)).toContain("1 planned");
  });

  it("adds income and both currencies of a transfer", async () => {
    const { api, call } = await setup();
    expect((await call("add_reminder", { ...expense, type: "income", category: "Salary" })).isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[1][0].reminder![0]).toMatchObject({ income: 50, outcome: 0, tag: ["tag-salary"] });
    const result = await call("add_reminder", { type: "transfer", from_account: "Checking", to_account: "Euro Card", outcome_amount: 100, income_amount: 92, start_date: "2026-01-31" });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[2][0].reminder![0]).toMatchObject({ income: 92, outcome: 100, incomeInstrument: 2, outcomeInstrument: 1 });
    expect(getTextContent(result)).toContain("100 USD");
    expect(getTextContent(result)).toContain("92 EUR");
  });

  it.each([
    { account: "missing" }, { category: "missing" }, { amount: -1 }, { start_date: "2026-02-30" },
    { interval: "month", points: [31] }, { interval: "day", step: 0 },
    { end_date: "2026-01-01" }, { step: 2 }, { interval: "day", points: [] },
    { type: "transfer", from_account: "Checking", to_account: "Checking" },
    { type: "transfer", from_account: "Checking", to_account: "Euro Card" },
    { outcome_amount: 10 }, { to_account: "Savings" },
  ])("rejects invalid input without writing: %j", async (overrides) => {
    const { api, call } = await setup();
    expect((await call("add_reminder", { ...expense, ...overrides })).isError).toBe(true);
    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it("writes every date of a long series in batches using the updated cursor", async () => {
    const { api, state, call } = await setup();
    let cursor = 1700000000;
    vi.mocked(api.diff).mockImplementation(async () => makeDiffResponse({ serverTimestamp: ++cursor, account: [], tag: [] }));
    const result = await call("add_reminder", { ...expense, start_date: "2024-01-01", interval: "day", end_date: "2026-12-31" });
    expect(result.isError).toBeFalsy();
    const writes = vi.mocked(api.diff).mock.calls.slice(1).map(([r]) => r);
    expect(writes.map((r) => r.reminderMarker?.length)).toEqual([500, 500, 96]);
    expect(writes.map((r) => r.serverTimestamp)).toEqual([1700000000, 1700000001, 1700000002]);
    expect(writes.filter((r) => r.reminder?.length)).toHaveLength(1);
    const all = writes.flatMap((r) => r.reminderMarker!);
    expect(all).toHaveLength(1096);
    expect(new Set(all.map((m) => m.date)).size).toBe(1096);
    expect(new Set(all.map((m) => m.id)).size).toBe(1096);
    expect(all.at(-1)?.date).toBe("2026-12-31");
    expect(state.reminderMarkers).toHaveLength(1096);
    expect(getTextContent(result)).toContain("1096 planned");
  });

  it("describes the one-year horizon of an open-ended series", async () => {
    const { state, call } = await setup();
    const result = await call("add_reminder", { ...expense, interval: "month" });
    expect(state.reminders[0].endDate).toBeNull();
    expect(state.reminderMarkers).toHaveLength(13);
    expect(getTextContent(result)).toContain("2027-01-31");
    expect(getTextContent(result)).toContain("not extended automatically");
  });

  it("reports a partially completed write without silently truncating the series", async () => {
    const { api, state, call } = await setup();
    vi.mocked(api.diff).mockResolvedValueOnce(makeDiffResponse()).mockRejectedValueOnce(new ZenMoneyError("timeout", true));
    const result = await call("add_reminder", { ...expense, interval: "day", end_date: "2028-01-01" });
    expect(result.isError).toBe(true);
    expect(state.reminderMarkers).toHaveLength(500);
    expect(getTextContent(result)).toContain("500 confirmed");
    expect(getTextContent(result)).toContain("may or may not have been saved");
    expect(getTextContent(result)).toContain(state.reminders[0].id);
    expect(getTextContent(result)).toContain("Do not repeat");
  });

  it("honors a reminder version returned by the server and stops materializing stale data", async () => {
    const { api, state, call } = await setup();
    vi.mocked(api.diff).mockImplementationOnce(async (r) => makeDiffResponse({ reminder: [{ ...r.reminder![0], outcome: 99 }] }));
    const result = await call("add_reminder", { ...expense, interval: "day", end_date: "2028-01-01" });
    expect(result.isError).toBe(true);
    expect(state.reminders[0].outcome).toBe(99);
    expect(api.diff).toHaveBeenCalledTimes(2);
    expect(getTextContent(result)).toContain("different version");
  });

  it("stops at a later batch if an account changes currency in the first response", async () => {
    const { api, state, call } = await setup();
    vi.mocked(api.diff).mockResolvedValueOnce(makeDiffResponse({ account: [{ ...CHECKING, instrument: 2 }] }));
    const result = await call("add_reminder", { ...expense, interval: "day", end_date: "2028-01-01" });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("Account Checking changed its currency");
    expect(getTextContent(result)).toContain("500 confirmed");
    expect(api.diff).toHaveBeenCalledTimes(2);
    expect(state.reminderMarkers).toHaveLength(500);
  });

  it("does not recreate a reminder deleted in the first batch response", async () => {
    const { api, state, call } = await setup();
    vi.mocked(api.diff).mockImplementationOnce(async (r) => makeDiffResponse({ deletion: [{ object: "reminder", id: r.reminder![0].id, stamp: 1, user: 1 }] }));
    const result = await call("add_reminder", { ...expense, interval: "day", end_date: "2028-01-01" });
    expect(result.isError).toBe(true);
    expect(api.diff).toHaveBeenCalledTimes(2);
    expect(state.reminders).toEqual([]);
  });

  it("keeps server marker versions instead of overwriting them with the submitted batch", async () => {
    const { api, state, call } = await setup();
    vi.mocked(api.diff).mockImplementationOnce(async (r) => makeDiffResponse({ reminderMarker: [{ ...r.reminderMarker![0], state: "processed" }] }));
    const result = await call("add_reminder", expense);
    expect(result.isError).toBe(true);
    expect(state.reminderMarkers[0].state).toBe("processed");
    expect(getTextContent(result)).toContain("different version");
  });

  it("lists schedules, accounts, currencies, categories, payees and future planned dates", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-20T12:00:00Z"));
    const { call } = await setup({
      reminder: [reminder(), reminder({ id: "finished", endDate: "2026-03-19" }), reminder({ id: "other", tag: null, incomeAccount: "acc-euro", outcomeAccount: "acc-euro" })],
      reminderMarker: [marker({ date: "2026-03-31" }), marker({ id: "past", date: "2026-03-01" }), marker({ id: "done", date: "2026-03-25", state: "processed" })],
    });
    const result = await call("list_reminders", { account: "Checking", category: "Food" });
    const text = getTextContent(result);
    for (const expected of ["month", "31", "Checking", "50 USD", "Food", "Rent", "2026-03-31", "reminder-1"]) expect(text).toContain(expected);
    for (const hidden of ["finished", "other", "2026-03-01", "2026-03-25"]) expect(text).not.toContain(hidden);
    expect(getTextContent(await call("list_reminders", { include_finished: true }))).toContain("finished");
    expect((await call("list_reminders", { account: "unknown" })).isError).toBe(true);
    expect((await call("list_reminders", { category: "unknown" })).isError).toBe(true);
  });

  it("lists exactly N calendar days including today, only planned markers, sorted by date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-20T12:00:00Z"));
    const { call } = await setup({ reminder: [reminder()], reminderMarker: [
      marker({ id: "later", date: "2026-03-26" }), marker({ id: "today", date: "2026-03-20" }),
      marker({ id: "past", date: "2026-03-19" }), marker({ id: "outside", date: "2026-03-27" }),
      marker({ id: "processed", date: "2026-03-21", state: "processed" }), marker({ id: "deleted", date: "2026-03-21", state: "deleted" }),
      marker({ id: "orphan", reminder: "no-series", date: "2026-03-22" }),
    ] });
    const text = getTextContent(await call("list_upcoming", { days: 7, account: "Checking", category: "Food" }));
    expect([...text.matchAll(/\| id: ([^\n]+)/g)].map((m) => m[1])).toEqual(["today", "orphan", "later"]);
    expect(text).toContain("50 USD");
    expect(text).toContain("Checking");
    expect(text).toContain("2026-03-26");
  });

  it("deletes only the series and planned markers dated today or later, with confirmation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-20T12:00:00Z"));
    const tx = makeTransaction({ id: "generated", reminderMarker: "processed", outcome: 50 });
    const { api, state, call } = await setup({ reminder: [reminder()], transaction: [tx], reminderMarker: [
      marker({ id: "today", date: "2026-03-20" }), marker({ id: "future", date: "2027-01-31" }),
      marker({ id: "processed", date: "2027-01-31", state: "processed" }), marker({ id: "past", date: "2026-03-19" }),
    ] });
    const preview = await call("delete_reminder", { id: "reminder-1" });
    expect(getTextContent(preview)).toContain("confirm=true");
    expect(api.diff).toHaveBeenCalledTimes(1);
    const result = await call("delete_reminder", { id: "reminder-1", confirm: true });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[1][0].deletion).toEqual(expect.arrayContaining([
      expect.objectContaining({ object: "reminder", id: "reminder-1" }),
      expect.objectContaining({ object: "reminderMarker", id: "today" }),
      expect.objectContaining({ object: "reminderMarker", id: "future" }),
    ]));
    expect(state.reminders).toEqual([]);
    expect(state.reminderMarkers.map((m) => m.id)).toEqual(["processed", "past"]);
    expect(state.transactions).toEqual([tx]);
    expect((await call("delete_reminder", { id: "unknown", confirm: true })).isError).toBe(true);
  });

  it.each([
    ["account", "acc-checking", "Account Checking was deleted"],
    ["tag", "tag-food", "Category tag-food was deleted"],
  ])("rechecks a deleted %s when creation reaches the write queue", async (object, id, message) => {
    const { api, state, call } = await setup();
    let answer!: (r: DiffResponse) => void;
    vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const sync = state.sync();
    const queued = vi.spyOn(state, "write");
    const pending = call("add_reminder", { ...expense, category: "Food" });
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    answer(makeDiffResponse({ deletion: [{ object, id, stamp: 1, user: 1 }] }));
    await sync;
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(api.diff).toHaveBeenCalledTimes(2);
    expect(state.reminders).toEqual([]);
  });

  it("rechecks account currency at its turn in the queue", async () => {
    const { api, state, call } = await setup();
    let answer!: (r: DiffResponse) => void;
    vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const sync = state.sync();
    const queued = vi.spyOn(state, "write");
    const pending = call("add_reminder", expense);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    answer(makeDiffResponse({ account: [{ ...CHECKING, instrument: 2 }] }));
    await sync;
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("changed its currency");
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it("retains a marker processed by a sync ahead of a queued deletion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-20T12:00:00Z"));
    const { api, state, call } = await setup({ reminder: [reminder()], reminderMarker: [marker({ date: "2026-03-31" })] });
    let answer!: (r: DiffResponse) => void;
    vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const sync = state.sync();
    const queued = vi.spyOn(state, "write");
    const pending = call("delete_reminder", { id: "reminder-1", confirm: true });
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    answer(makeDiffResponse({ reminderMarker: [marker({ date: "2026-03-31", state: "processed" })] }));
    await sync;
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[2][0].deletion).toEqual([expect.objectContaining({ object: "reminder", id: "reminder-1" })]);
    expect(state.reminderMarkers[0].state).toBe("processed");
  });

  it("deletes a large series in batches without touching its processed markers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const markers = Array.from({ length: 1001 }, (_, n) => marker({ id: `future-${n}`, date: "2026-01-31" }));
    const { api, state, call } = await setup({ reminder: [reminder()], reminderMarker: [...markers, marker({ id: "processed", state: "processed" })] });
    const result = await call("delete_reminder", { id: "reminder-1", confirm: true });
    expect(result.isError).toBeFalsy();
    const writes = vi.mocked(api.diff).mock.calls.slice(1).map(([r]) => r.deletion!);
    expect(writes.map((d) => d.filter((x) => x.object === "reminderMarker").length)).toEqual([500, 500, 1]);
    expect(writes.flat().filter((d) => d.object === "reminder")).toHaveLength(1);
    expect(state.reminderMarkers.map((m) => m.id)).toEqual(["processed"]);
    expect(state.reminders).toEqual([]);
    expect(getTextContent(result)).toContain("1001");
  });

  it("reports partial deletion when a later batch fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
    const markers = Array.from({ length: 501 }, (_, n) => marker({ id: `future-${n}`, date: "2026-01-31" }));
    const { api, state, call } = await setup({ reminder: [reminder()], reminderMarker: markers });
    vi.mocked(api.diff).mockResolvedValueOnce(makeDiffResponse()).mockRejectedValueOnce(new ZenMoneyError("timeout", true));
    const result = await call("delete_reminder", { id: "reminder-1", confirm: true });
    expect(result.isError).toBe(true);
    expect(state.reminders).toHaveLength(1);
    expect(state.reminderMarkers).toHaveLength(1);
    expect(getTextContent(result)).toContain("500 confirmed marker deletions");
    expect(getTextContent(result)).toContain("may or may not have been saved");
  });
});
