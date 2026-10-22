import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOTAL_BUDGET_TAG, type DiffResponse } from "../src/api.js";
import { ZenState } from "../src/state.js";
import { CHECKING, DEBT_ACCOUNT, FOOD, RESTAURANTS, makeDiffResponse, makeTransaction } from "./fixtures.js";
import { connectPair, createMcpPair, createMockApi, getTextContent } from "./helpers.js";
import { marker, reminder } from "./reminder-fixtures.js";

let client: Client;
let server: McpServer;
const period = { start_date: "2026-03-01", end_date: "2026-03-31" };
const names = ["list_accounts", "list_categories", "list_transactions", "summarize_transactions", "get_budget", "list_debts", "list_reminders", "list_upcoming"];

async function setup(diff: Partial<DiffResponse> = {}, readOnly = false, synced = true) {
  const api = createMockApi(diff);
  const state = new ZenState(api, { syncTtlMs: 1000 });
  if (synced) await state.sync();
  const pair = await createMcpPair(api, state, { readOnly });
  ({ client, server } = pair);
  await connectPair(pair);
  return { api, state };
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toBeDefined();
  return { data: result.structuredContent as any, text: getTextContent(result) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 2, 20, 12));
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.useRealTimers();
});

describe("structured output", () => {
  it.each([false, true])("advertises output schemas only for the eight tools, readOnly=%s", async (readOnly) => {
    await setup({}, readOnly);
    const { tools } = await client.listTools();
    expect(tools.filter((t) => t.outputSchema).map((t) => t.name).sort()).toEqual([...names].sort());
    for (const tool of tools.filter((t) => names.includes(t.name))) {
      expect(tool.outputSchema).toMatchObject({ type: "object", properties: expect.any(Object) });
    }
  });

  it("lists account ids, numeric balances, currency codes and unknown balances", async () => {
    await setup({ account: [CHECKING, { ...CHECKING, id: "unknown", title: "Unknown", balance: null, instrument: null, archive: true }] });
    const { data, text } = await call("list_accounts", { include_archived: true });
    expect(data).toEqual({ accounts: [
      { id: "acc-checking", title: "Checking", type: "checking", balance: 5000, currency: "USD", bank: null, archived: false },
      { id: "unknown", title: "Unknown", type: "checking", balance: null, currency: null, bank: null, archived: true },
    ] });
    expect(text).toContain("5000 USD");
    expect(text).toContain("unknown ??? (archived)");
    expect(text).toContain("id: `unknown`");
  });

  it("keeps the displayed category order, depth, root flags and missing parent", async () => {
    await setup({ tag: [{ ...FOOD, parent: "missing" }, RESTAURANTS] });
    const { data, text } = await call("list_categories");
    expect(data).toEqual({ categories: [
      { id: "tag-food", title: "Food", parentId: "missing", depth: 0, expense: true, income: false, missingParentId: "missing" },
      { id: "tag-restaurants", title: "Restaurants", parentId: "tag-food", depth: 1 },
    ] });
    expect(text).toContain("parent not found: missing");
    expect(text).toContain("\n  - Restaurants — id: `tag-restaurants`");
  });

  it("keeps only the selected transaction page, original amounts and requested provenance", async () => {
    await setup({ transaction: [
      makeTransaction({ id: "expense", outcome: 12, opOutcome: 10, opOutcomeInstrument: 2, tag: [FOOD.id], merchant: "merchant-cafe", hold: true, outcomeBankID: "bank-1", created: 3000 }),
      makeTransaction({ id: "transfer", outcome: 20, income: 18, incomeInstrument: 2, incomeAccount: "acc-euro", created: 2000 }),
      makeTransaction({ id: "skip", income: 30, created: 1000 }),
    ] });
    const { data, text } = await call("list_transactions", { ...period, limit: 1, show_provenance: true });
    expect(data).toEqual({ total: 3, offset: 0, truncated: true, nextOffset: 1, transactions: [{
      id: "expense", date: "2026-03-20", type: "expense", outcome: { amount: 12, currency: "USD", originalAmount: 10, originalCurrency: "EUR" },
      categories: ["Food"], payee: "Corner Cafe", hold: true, deleted: false,
      provenance: { createdAt: "1970-01-01T00:50:00Z", outcomeBankId: "bank-1" },
    }] });
    expect(text).toContain("-10 EUR (-12 USD)");
    expect(text).toContain("next offset: 1");
    expect(text).toContain("outcome bankID: bank-1");
    const last = await call("list_transactions", { ...period, offset: 1 });
    expect(last.data.transactions[0]).toMatchObject({ id: "transfer", type: "transfer", outcome: { amount: 20, currency: "USD", account: "Checking" }, income: { amount: 18, currency: "EUR", account: "Euro Card" } });
    expect(last.data.transactions[1]).toMatchObject({ id: "skip", type: "income", income: { amount: 30, currency: "USD" } });
    expect(last.data.transactions[0]).not.toHaveProperty("provenance");
    expect(last.data).toMatchObject({ total: 3, offset: 1, truncated: false });
    expect(last.data).not.toHaveProperty("nextOffset");
    expect(last.text).toContain("20 USD → 18 EUR (Checking → Euro Card)");
  });

  it("reports the actual continuation when the text size cap cuts a page", async () => {
    await setup({ transaction: Array.from({ length: 5 }, (_, i) => makeTransaction({ id: `tx-${i}`, outcome: 10, comment: "x".repeat(18_000) })) });
    const { data, text } = await call("list_transactions", { ...period, offset: 1, limit: 100 });
    expect(data.transactions.map((t: any) => t.id)).toEqual(["tx-1", "tx-2"]);
    expect(data).toMatchObject({ total: 5, offset: 1, truncated: true, nextOffset: 3 });
    expect(text).toContain("Transactions (2 of 5, offset: 1, next offset: 3)");
    expect(text).not.toContain("id: tx-3");
    const end = await call("list_transactions", { ...period, offset: 10 });
    expect(end.data).toEqual({ transactions: [], total: 5, offset: 10, truncated: false });
  });

  it("summarizes rounded amounts, shares, original currencies and net from the displayed groups", async () => {
    await setup({ transaction: [
      makeTransaction({ id: "usd", outcome: 10.004, tag: [FOOD.id] }),
      makeTransaction({ id: "eur", outcome: 10, outcomeInstrument: 2, tag: [RESTAURANTS.id] }),
      makeTransaction({ id: "income", income: 100, tag: ["tag-salary"] }),
    ] });
    const { data, text } = await call("summarize_transactions", { ...period, type: "both" });
    expect(data).toEqual({ startDate: "2026-03-01", endDate: "2026-03-31", currency: "USD", sections: [
      { type: "expenses", groups: [{ title: "Food", amount: 19.2, share: 100, count: 2, originalAmounts: [{ amount: 10, currency: "USD" }, { amount: 10, currency: "EUR" }] }], total: 19.2, count: 2 },
      { type: "income", groups: [{ title: "Salary", amount: 100, share: 100, count: 1 }], total: 100, count: 1 },
    ], net: 80.8 });
    expect(text).toContain("Food: 19.20 USD | 100.00% | 2 transactions | original: 10.00 USD, 10.00 EUR");
    expect(text).toContain("Net: 80.80 USD");
  });

  it("exposes budget set/planned/effective amounts, signed remainder and monthly totals", async () => {
    const budget = { changed: 1000, user: 1, date: "2026-03-01", tag: FOOD.id, outcome: 10, outcomeLock: false, income: 0, incomeLock: false };
    await setup({ budget: [budget, { ...budget, tag: RESTAURANTS.id, outcome: 4, outcomeLock: true }, { ...budget, tag: TOTAL_BUDGET_TAG, outcome: 50, outcomeLock: true }, { ...budget, tag: "tag-salary", outcome: 0, income: 80 }], transaction: [
      makeTransaction({ id: "food", outcome: 20, tag: [FOOD.id] }),
      makeTransaction({ id: "restaurant", outcome: 6, tag: [RESTAURANTS.id] }),
      makeTransaction({ id: "salary", income: 100, tag: ["tag-salary"] }),
    ], reminderMarker: [marker({ date: "2026-03-21", outcome: 5 }), marker({ id: "salary-marker", date: "2026-03-22", outcome: 0, income: 25, tag: ["tag-salary"] })] });
    const { data, text } = await call("get_budget", { month: "2026-03" });
    expect(data).toEqual({ month: "2026-03", currency: "USD", rows: [
      { type: "expense", title: "All categories", set: 50, planned: 0, effective: 50, actual: 26, remaining: 24 },
      { type: "expense", title: "Food", set: 10, planned: 5, effective: 15, actual: 26, remaining: -11, subcategoryPlans: 4 },
      { type: "expense", title: "Food / Restaurants", set: 4, planned: 0, effective: 4, actual: 6, remaining: -2 },
      { type: "income", title: "All categories", set: 0, planned: 25, effective: 25, actual: 100, remaining: -75 },
      { type: "income", title: "Salary", set: 80, planned: 25, effective: 105, actual: 100, remaining: 5 },
    ], totals: { title: "This month, in the budget", spent: 26, received: 100 } });
    expect(text).toContain("Food: plan 15.00 USD (10.00 USD set + 5.00 USD planned operations) | spent 26.00 USD | over by 11.00 USD | subcategory plans 4.00 USD");
    expect(text).toContain("Salary: plan 105.00 USD (80.00 USD set + 25.00 USD planned operations) | received 100.00 USD | still expected 5.00 USD");
    expect(text).toContain("Income:\n- All categories: plan 25.00 USD (25.00 USD planned operations) | received 100.00 USD | above plan by 75.00 USD");
    expect(text).toContain("spent 26.00 USD, received 100.00 USD");
    const scoped = await call("get_budget", { month: "2026-03", category: "Restaurants" });
    expect(scoped.data.rows).toHaveLength(1);
    expect(scoped.data.totals).toEqual({ title: "Restaurants this month", spent: 6, received: 0 });
  });

  it("keeps debt direction, exact decimal balance, original currency and settled rows", async () => {
    await setup({ account: [CHECKING, DEBT_ACCOUNT], transaction: [
      makeTransaction({ id: "loan1", outcome: 0.1, income: 0.1, incomeAccount: DEBT_ACCOUNT.id, payee: "Alice" }),
      makeTransaction({ id: "loan2", outcome: 0.2, income: 0.2, incomeAccount: DEBT_ACCOUNT.id, payee: "Alice" }),
      makeTransaction({ id: "borrow", outcome: 5, income: 5, outcomeAccount: DEBT_ACCOUNT.id, incomeInstrument: 2, payee: "Bob" }),
      makeTransaction({ id: "zero", incomeAccount: DEBT_ACCOUNT.id, payee: "Settled" }),
    ] });
    const { data, text } = await call("list_debts", { include_settled: true });
    expect(data).toEqual({ debts: [
      { counterparty: "Alice", amount: 0.3, currency: "USD", direction: "owedToYou" },
      { counterparty: "Bob", amount: 5, currency: "EUR", direction: "youOwe" },
      { counterparty: "Settled", amount: 0, currency: "USD", direction: "settled" },
    ] });
    expect(text).toContain("Alice: owes you 0.3 USD");
    expect(text).toContain("Bob: you owe 5 EUR");
    expect(text).toContain("Settled: settled (0 USD)");
  });

  it("lists reminder schedules with only the displayed planned dates and their truncation", async () => {
    await setup({ reminder: [reminder()], reminderMarker: Array.from({ length: 7 }, (_, i) => marker({ id: `marker-${i}`, date: `2026-03-${20 + i}` })) });
    const { data, text } = await call("list_reminders");
    expect(data).toEqual({ reminders: [{
      id: "reminder-1", type: "expense", outcome: { amount: 50, currency: "USD", account: "Checking" }, categories: ["Food"], payee: "Rent",
      schedule: { interval: "month", step: 1, points: [0], startDate: "2026-01-31", endDate: null },
      nextPlannedDates: ["2026-03-20", "2026-03-21", "2026-03-22", "2026-03-23", "2026-03-24"], truncated: true, remainingCount: 2, materializedThrough: "2026-03-26",
    }] });
    expect(text).toContain("expense 50 USD (Checking) | Food | Rent");
    expect(text).toContain("every month, from 2026-01-31");
    expect(text).toContain("(+2 more); materialized through 2026-03-26");
  });

  it("lists upcoming stored markers within the displayed inclusive range in date order", async () => {
    await setup({ reminderMarker: [
      marker({ id: "later", date: "2026-03-22", outcome: 10, income: 9, incomeInstrument: 2, incomeAccount: "acc-euro" }),
      marker({ id: "today", date: "2026-03-20", income: 100, outcome: 0 }),
      marker({ id: "outside", date: "2026-03-23" }),
    ] });
    const { data, text } = await call("list_upcoming", { days: 3 });
    expect(data).toEqual({ startDate: "2026-03-20", endDate: "2026-03-22", operations: [
      { id: "today", reminderId: "reminder-1", date: "2026-03-20", type: "income", income: { amount: 100, currency: "USD", account: "Checking" }, categories: ["Food"], payee: "Rent" },
      { id: "later", reminderId: "reminder-1", date: "2026-03-22", type: "transfer", outcome: { amount: 10, currency: "USD", account: "Checking" }, income: { amount: 9, currency: "EUR", account: "Euro Card" }, categories: ["Food"], payee: "Rent" },
    ] });
    expect(text).toContain("2026-03-20 to 2026-03-22 inclusive");
    expect(text).toContain("transfer 10 USD (Checking) -> 9 EUR (Euro Card)");
    expect(text).not.toContain("id: outside");
  });

  it.each(names)("returns an empty structured list for %s", async (name) => {
    await setup({ account: [], tag: [] });
    const { data } = await call(name, { ...period, month: "2026-03" });
    const key = ({ list_accounts: "accounts", list_categories: "categories", list_transactions: "transactions", summarize_transactions: "sections", get_budget: "rows", list_debts: "debts", list_reminders: "reminders", list_upcoming: "operations" } as Record<string, string>)[name];
    expect(data[key]).toEqual([]);
  });

  it.each(["list_transactions", "summarize_transactions", "get_budget", "list_reminders", "list_upcoming"])("keeps tool errors unstructured for %s", async (name) => {
    await setup();
    const result = await client.callTool({ name, arguments: { account: "missing", category: "missing" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const valid = await call(name, { ...period, month: "2026-03" });
    expect(valid.data).toBeDefined();
  });

  it.each(["fresh", "refreshSucceeded", "refreshFailed", "initialSync"])("preserves structured output through read-only and autosync wrappers: %s", async (mode) => {
    const { api } = await setup({}, true, mode !== "initialSync");
    if (mode === "refreshSucceeded" || mode === "refreshFailed") {
      vi.setSystemTime(new Date(2026, 2, 20, 12, 0, 2));
      if (mode === "refreshFailed") vi.mocked(api.diff).mockRejectedValueOnce(new Error("offline"));
      else vi.mocked(api.diff).mockResolvedValueOnce(makeDiffResponse({ account: [{ ...CHECKING, balance: 42, changed: 2000 }] }));
    }
    if (mode === "initialSync") {
      vi.mocked(api.diff).mockRejectedValueOnce(new Error("offline"));
      const error = await client.callTool({ name: "list_accounts", arguments: {} });
      expect(error.isError).toBe(true);
      expect(error.structuredContent).toBeUndefined();
    }
    const { data, text } = await call("list_accounts");
    const balance = mode === "refreshSucceeded" ? 42 : 5000;
    expect(data.accounts[0]).toMatchObject({ id: "acc-checking", balance, currency: "USD" });
    expect(text).toContain(`${balance} USD`);
    expect(api.diff).toHaveBeenCalledTimes(mode === "fresh" ? 1 : 2);
    expect(text.includes("Note: refreshing from ZenMoney failed")).toBe(mode === "refreshFailed");
  });
});
