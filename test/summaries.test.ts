import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiffResponse, Transaction } from "../src/api.js";
import { ZenState } from "../src/state.js";
import {
  CHECKING, EURO_CARD, FOOD, MERCHANT_CAFE, RESTAURANTS, SALARY, SAVINGS, USD, EUR, RUB, USER,
  makeTransaction,
} from "./fixtures.js";
import { connectPair, createMcpPair, createMockApi, getTextContent } from "./helpers.js";

let client: Client;
let server: McpServer;
let state: ZenState;

const PERIOD = { start_date: "2026-03-01", end_date: "2026-03-31" };
const GROCERIES = { ...FOOD, id: "tag-groceries", title: "Groceries", parent: FOOD.id };
const PRODUCE = { ...FOOD, id: "tag-produce", title: "Produce", parent: GROCERIES.id };

function expense(id: string, outcome: number, overrides: Partial<Transaction> = {}) {
  return makeTransaction({ id, outcome, tag: [FOOD.id], ...overrides });
}

async function setup(diff: Partial<DiffResponse> = {}, synced = true) {
  const api = createMockApi(diff);
  state = new ZenState(api);
  if (synced) await state.sync();
  const pair = await createMcpPair(api, state);
  ({ client, server } = pair);
  await connectPair(pair);
}

function summarize(args: Record<string, unknown> = PERIOD) {
  return client.callTool({ name: "summarize_transactions", arguments: args });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 2, 31, 23, 30));
});

afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.useRealTimers();
});

describe("summarize_transactions", () => {
  it("registers a titled read-only tool", async () => {
    await setup();
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "summarize_transactions")).toMatchObject({
      title: "Summarize Transactions",
      annotations: { readOnlyHint: true, openWorldHint: true },
    });
  });

  it("syncs first when nothing is loaded yet", async () => {
    await setup({}, false);
    const result = await summarize();
    expect(result.isError).toBeFalsy();
    expect(state.isSynced).toBe(true);
  });

  it("groups an empty payee under its merchant", async () => {
    await setup({ transaction: [
      expense("a", 30, { payee: null, merchant: MERCHANT_CAFE.id }),
      expense("b", 20, { payee: "Corner Cafe" }),
    ] });
    const text = getTextContent(await summarize({ ...PERIOD, group_by: "payee" }));
    expect(text).toContain("- Corner Cafe: 50.00");
    expect(text).not.toContain("Unknown payee");
  });

  it("defaults to expenses by the first category, sorted by amount", async () => {
    await setup({ transaction: [
      expense("food-1", 30, { tag: [FOOD.id, SALARY.id] }),
      expense("food-2", 30),
      expense("none", 40, { tag: null }),
      expense("income", 0, { income: 1000, tag: [SALARY.id] }),
    ] });
    const text = getTextContent(await summarize());
    expect(text).toContain("2026-03-01 to 2026-03-31 | USD");
    expect(text).toContain("Food: 60.00 USD | 60.00% | 2 transactions");
    expect(text).toContain("Uncategorized: 40.00 USD | 40.00% | 1 transaction");
    expect(text.indexOf("Food:")).toBeLessThan(text.indexOf("Uncategorized:"));
    expect(text).not.toContain("Salary");
    expect(text.trim()).toMatch(/Total expenses: 100\.00 USD \| 3 transactions$/);
  });

  it("rolls every level of subcategories up to the root by default", async () => {
    await setup({ tag: [FOOD, GROCERIES, PRODUCE], transaction: [
      expense("parent", 10),
      expense("child", 20, { tag: [GROCERIES.id] }),
      expense("grandchild", 30, { tag: [PRODUCE.id] }),
    ] });
    const text = getTextContent(await summarize());
    expect(text).toContain("Food: 60.00 USD | 100.00% | 3 transactions");
    expect(text).not.toContain("Groceries:");
    expect(text).not.toContain("Produce:");
  });

  it("keeps subcategories separate when roll_up is false", async () => {
    await setup({ transaction: [
      expense("parent", 10),
      expense("child", 30, { tag: [RESTAURANTS.id] }),
    ] });
    const text = getTextContent(await summarize({ ...PERIOD, roll_up: false }));
    expect(text).toContain("Restaurants: 30.00 USD | 75.00% | 1 transaction");
    expect(text).toContain("Food: 10.00 USD | 25.00% | 1 transaction");
  });

  it.each([
    ["payee", "Cafe", "Unknown payee"],
    ["account", "Checking", "Savings"],
    ["month", "2026-03", "2026-02"],
  ])("groups by %s", async (group_by, first, second) => {
    await setup({ transaction: [
      expense("a", 30, { payee: "Cafe" }),
      expense("b", 30, { payee: "Cafe" }),
      expense("c", 40, {
        date: "2026-02-20", incomeAccount: SAVINGS.id, outcomeAccount: SAVINGS.id,
      }),
    ] });
    const text = getTextContent(await summarize({ start_date: "2026-02-01", end_date: "2026-03-31", group_by }));
    expect(text).toContain(`${first}: 60.00 USD | 60.00% | 2 transactions`);
    expect(text).toContain(`${second}: 40.00 USD | 40.00% | 1 transaction`);
    expect(text.indexOf(`${first}:`)).toBeLessThan(text.indexOf(`${second}:`));
  });

  it("summarizes only income when requested", async () => {
    await setup({ transaction: [
      expense("spending", 70),
      expense("salary", 0, { income: 200, tag: [SALARY.id] }),
    ] });
    const text = getTextContent(await summarize({ ...PERIOD, type: "income" }));
    expect(text).toContain("Salary: 200.00 USD | 100.00% | 1 transaction");
    expect(text.trim()).toMatch(/Total income: 200\.00 USD \| 1 transaction$/);
    expect(text).not.toContain("Food:");
  });

  it("shows expense and income shares separately and ends with income minus expenses", async () => {
    await setup({ transaction: [
      expense("food", 60),
      expense("other", 40, { tag: [] }),
      expense("salary", 0, { income: 300, tag: [SALARY.id] }),
    ] });
    const text = getTextContent(await summarize({ ...PERIOD, type: "both" }));
    expect(text).toContain("Food: 60.00 USD | 60.00% | 1 transaction");
    expect(text).toContain("Salary: 300.00 USD | 100.00% | 1 transaction");
    expect(text).toContain("Total expenses: 100.00 USD | 2 transactions");
    expect(text).toContain("Total income: 300.00 USD | 1 transaction");
    expect(text.trim()).toMatch(/Net: 200\.00 USD$/);
  });

  it("includes a zero income total and a negative net for an expense-only period", async () => {
    await setup({ transaction: [expense("food", 20)] });
    const text = getTextContent(await summarize({ ...PERIOD, type: "both" }));
    expect(text).toContain("Total income: 0.00 USD | 0 transactions");
    expect(text.trim()).toMatch(/Net: -20\.00 USD$/);
    expect(text).not.toMatch(/NaN|Infinity/);
  });

  it("converts using both rates and retains every source currency in a mixed group", async () => {
    const rubAccount = { ...CHECKING, id: "acc-rub", instrument: RUB.id };
    await setup({
      user: [{ ...USER, currency: EUR.id }],
      instrument: [{ ...USD, rate: 90 }, { ...EUR, rate: 100 }, { ...RUB, rate: 1 }],
      account: [CHECKING, EURO_CARD, rubAccount],
      transaction: [
        expense("dollars", 90),
        expense("euros", 10, {
          incomeAccount: EURO_CARD.id, outcomeAccount: EURO_CARD.id,
          incomeInstrument: EUR.id, outcomeInstrument: EUR.id,
        }),
        expense("rubles", 1000, {
          incomeAccount: rubAccount.id, outcomeAccount: rubAccount.id,
          incomeInstrument: RUB.id, outcomeInstrument: RUB.id,
        }),
      ],
    });
    const text = getTextContent(await summarize());
    expect(text).toContain("2026-03-01 to 2026-03-31 | EUR");
    expect(text).toContain("Food: 101.00 EUR | 100.00% | 3 transactions");
    expect(text).toContain("90.00 USD");
    expect(text).toContain("10.00 EUR");
    expect(text).toContain("1000.00 RUB");
    expect(text).toContain("Total expenses: 101.00 EUR");
  });

  it("sorts and calculates shares after conversion, including for income", async () => {
    await setup({ instrument: [{ ...USD, rate: 90 }, { ...EUR, rate: 180 }], transaction: [
      expense("usd", 0, { income: 100, tag: [SALARY.id] }),
      expense("eur", 0, {
        income: 60, incomeAccount: EURO_CARD.id, outcomeAccount: EURO_CARD.id,
        incomeInstrument: EUR.id, outcomeInstrument: EUR.id,
      }),
    ] });
    const text = getTextContent(await summarize({ ...PERIOD, type: "income" }));
    expect(text).toContain("Food: 120.00 USD | 54.55% | 1 transaction");
    expect(text).toContain("Salary: 100.00 USD | 45.45% | 1 transaction");
    expect(text.indexOf("Food:")).toBeLessThan(text.indexOf("Salary:"));
  });

  it("rounds after summing rather than rounding each converted transaction", async () => {
    await setup({ instrument: [{ ...USD, rate: 3 }, { ...EUR, rate: 1 }], transaction: [
      expense("a", 1, { incomeAccount: EURO_CARD.id, outcomeAccount: EURO_CARD.id, outcomeInstrument: EUR.id }),
      expense("b", 1, { incomeAccount: EURO_CARD.id, outcomeAccount: EURO_CARD.id, outcomeInstrument: EUR.id }),
      expense("c", 1, { incomeAccount: EURO_CARD.id, outcomeAccount: EURO_CARD.id, outcomeInstrument: EUR.id }),
    ] });
    const text = getTextContent(await summarize());
    expect(text).toContain("Food: 1.00 USD | 100.00% | 3 transactions");
    expect(text).toContain("3.00 EUR");
  });

  it("excludes transfers, debts, accounts outside the balance, deleted and zero transactions", async () => {
    const debt = { ...CHECKING, id: "acc-debt", type: "debt" };
    const excluded = { ...SAVINGS, inBalance: false };
    await setup({ account: [CHECKING, debt, excluded], transaction: [
      expense("real", 10),
      expense("transfer", 100, { income: 100, incomeAccount: SAVINGS.id }),
      expense("zero-transfer", 200, { incomeAccount: SAVINGS.id }),
      expense("debt-expense", 300, { incomeAccount: debt.id, outcomeAccount: debt.id }),
      expense("debt-income", 0, { income: 300, incomeAccount: debt.id, outcomeAccount: debt.id }),
      expense("outside", 400, { incomeAccount: excluded.id, outcomeAccount: excluded.id }),
      expense("outside-income", 0, { income: 400, incomeAccount: excluded.id, outcomeAccount: excluded.id }),
      expense("deleted", 500, { deleted: true }),
      expense("zero", 0),
    ] });
    const text = getTextContent(await summarize({ ...PERIOD, type: "both" }));
    expect(text).toContain("Total expenses: 10.00 USD | 1 transaction");
    expect(text).toContain("Total income: 0.00 USD | 0 transactions");
    expect(text.trim()).toMatch(/Net: -10\.00 USD$/);
  });

  it("counts archived accounts that are in balance and does not require inBalance to be true", async () => {
    await setup({ account: [
      { ...CHECKING, archive: true },
      { ...SAVINGS, inBalance: undefined as unknown as boolean },
    ], transaction: [
      expense("archived", 10),
      expense("legacy", 20, { incomeAccount: SAVINGS.id, outcomeAccount: SAVINGS.id }),
    ] });
    expect(getTextContent(await summarize())).toContain("Total expenses: 30.00 USD | 2 transactions");
  });

  it.each(["Checking", CHECKING.id])("filters an account by %s", async (account) => {
    await setup({ transaction: [
      expense("checking", 10),
      expense("savings", 20, { incomeAccount: SAVINGS.id, outcomeAccount: SAVINGS.id }),
    ] });
    expect(getTextContent(await summarize({ ...PERIOD, account })))
      .toContain("Total expenses: 10.00 USD | 1 transaction");
  });

  it.each(["Food", FOOD.id])("filters a category by %s including all descendants and secondary tags", async (category) => {
    await setup({ tag: [FOOD, GROCERIES, PRODUCE, SALARY], transaction: [
      expense("parent", 10),
      expense("child", 20, { tag: [GROCERIES.id] }),
      expense("grandchild", 30, { tag: [PRODUCE.id] }),
      expense("secondary", 40, { tag: [SALARY.id, PRODUCE.id] }),
      expense("unrelated", 500, { tag: [SALARY.id] }),
    ] });
    const text = getTextContent(await summarize({ ...PERIOD, category, roll_up: false }));
    expect(text).toContain("Total expenses: 100.00 USD | 4 transactions");
    expect(text).toContain("Salary: 40.00 USD");
  });

  it("combines account and category filters", async () => {
    await setup({ transaction: [
      expense("match", 10, { tag: [RESTAURANTS.id] }),
      expense("account-only", 20, { tag: [SALARY.id] }),
      expense("category-only", 30, { incomeAccount: SAVINGS.id, outcomeAccount: SAVINGS.id }),
    ] });
    expect(getTextContent(await summarize({ ...PERIOD, account: "Checking", category: "Food" })))
      .toContain("Total expenses: 10.00 USD | 1 transaction");
  });

  it.each([
    [{ account: "Missing" }, 'Account "Missing" not found'],
    [{ category: "Missing" }, 'Category "Missing" not found'],
    [{ account: "Card" }, 'Account "Card" is ambiguous'],
    [{ category: "a" }, 'Category "a" is ambiguous'],
  ])("rejects unknown or ambiguous filters %j", async (filter, message) => {
    await setup({ account: [CHECKING, EURO_CARD, { ...SAVINGS, title: "Other Card" }] });
    const result = await summarize({ ...PERIOD, ...filter });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
  });

  it("includes both date boundaries and lets explicit dates override days", async () => {
    await setup({ transaction: [
      expense("before", 1000, { date: "2026-02-28" }),
      expense("start", 10, { date: PERIOD.start_date }),
      expense("end", 20, { date: PERIOD.end_date }),
      expense("after", 2000, { date: "2026-04-01" }),
    ] });
    expect(getTextContent(await summarize({ ...PERIOD, days: 0 })))
      .toContain("Total expenses: 30.00 USD | 2 transactions");
  });

  it.each([
    [{}, "2026-03-01 to 2026-03-31", "30.00"],
    [{ days: 0 }, "2026-03-31 to 2026-03-31", "20.00"],
    [{ start_date: "2026-03-31" }, "2026-03-31 to 2026-03-31", "20.00"],
    [{ end_date: "2026-03-01" }, "0000-01-01 to 2026-03-01", "110.00"],
  ])("matches list_transactions date defaults for %j", async (args, period, total) => {
    await setup({ transaction: [
      expense("old", 100, { date: "2026-02-28" }),
      expense("start", 10, { date: "2026-03-01" }),
      expense("today", 20, { date: "2026-03-31" }),
      expense("future", 1000, { date: "2026-04-01" }),
    ] });
    const text = getTextContent(await summarize(args));
    expect(text).toContain(`${period} | USD`);
    expect(text).toContain(`Total expenses: ${total} USD`);
  });

  it.each([
    { start_date: "2026-03-31", end_date: "2026-03-01" },
    { start_date: "2026-02-30" },
    { end_date: "2026-3-01" },
    { days: -1 },
    { days: 1.5 },
    { group_by: "invalid" },
    { type: "invalid" },
  ])("rejects invalid arguments %j", async (args) => {
    await setup();
    expect((await summarize(args)).isError).toBe(true);
  });

  it.each(["expense", "income", "both"])("explains an empty period for %s", async (type) => {
    await setup({ transaction: [expense("outside", 100, { date: "2026-02-28" })] });
    const result = await summarize({ ...PERIOD, type });
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("No transactions found in the given period");
    expect(getTextContent(result)).toContain("2026-03-01 to 2026-03-31 | USD");
  });

  it.each([0, -1, NaN, Infinity])("rejects an unusable exchange rate %s", async (rate) => {
    await setup({ instrument: [{ ...USD, rate }, EUR], transaction: [expense("a", 10)] });
    const result = await summarize();
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("rate");
  });

  it("rejects a missing source currency instead of silently omitting a transaction", async () => {
    await setup({ instrument: [USD], transaction: [expense("a", 10, { outcomeInstrument: EUR.id })] });
    const result = await summarize();
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("currency");
  });

  it("rejects a missing user instead of assuming a base currency", async () => {
    await setup({ user: [], transaction: [expense("a", 10)] });
    const result = await summarize();
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("currency");
  });
});
