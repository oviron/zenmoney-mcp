import { describe, it, expect, vi } from "vitest";
import { ZenState } from "../src/state.js";
import { TOTAL_BUDGET_TAG, type Budget, type DiffResponse, type ReminderMarker, type ZenMoneyAPI } from "../src/api.js";
import { CHECKING, EURO_CARD, makeDiffResponse, makeTransaction } from "./fixtures.js";
import { createMcpPair, connectPair, getTextContent } from "./helpers.js";
import { marker } from "./reminder-fixtures.js";

function budget(overrides: Partial<Budget>): Budget {
  return {
    changed: 1000,
    user: 1,
    tag: "tag-food",
    date: "2026-03-01",
    income: 0,
    incomeLock: false,
    outcome: 0,
    outcomeLock: false,
    ...overrides,
  };
}

const TRANSACTIONS = [
  makeTransaction({ id: "t1", outcome: 30, tag: ["tag-food"], date: "2026-03-02" }),
  makeTransaction({ id: "t2", outcome: 25, tag: ["tag-restaurants"], date: "2026-03-10" }),
  // 50 EUR at a rate of 0.92 against USD is 46 USD
  makeTransaction({
    id: "t3",
    outcome: 50,
    outcomeInstrument: 2,
    incomeInstrument: 2,
    outcomeAccount: "acc-euro",
    incomeAccount: "acc-euro",
    tag: ["tag-restaurants"],
    date: "2026-03-11",
  }),
  makeTransaction({ id: "t4", income: 1000, tag: ["tag-salary"], date: "2026-03-05" }),
  makeTransaction({ id: "t5", outcome: 7, date: "2026-03-06" }),
  // Another month, a transfer: not counted
  makeTransaction({ id: "t6", outcome: 99, tag: ["tag-food"], date: "2026-02-28" }),
  makeTransaction({ id: "t7", outcome: 10, income: 10, incomeAccount: "acc-savings", tag: ["tag-food"], date: "2026-03-03" }),
];

const BUDGETS = [
  budget({ tag: "tag-food", outcome: 200, outcomeLock: true }),
  budget({ tag: "tag-restaurants", outcome: 60, outcomeLock: true }),
  budget({ tag: "tag-salary", income: 1200, incomeLock: true }),
  budget({ tag: TOTAL_BUDGET_TAG, outcome: 500, outcomeLock: true }),
  budget({ tag: "tag-food", date: "2026-02-01", outcome: 1, outcomeLock: true }),
];

function empty(serverTimestamp: number, overrides: Partial<DiffResponse> = {}) {
  return makeDiffResponse({
    serverTimestamp,
    instrument: [],
    company: [],
    user: [],
    account: [],
    tag: [],
    merchant: [],
    ...overrides,
  });
}

async function setup(budgets = BUDGETS, reminderMarker: ReminderMarker[] = []) {
  const api = {
    diff: vi.fn().mockResolvedValueOnce(
      makeDiffResponse({ account: [CHECKING, EURO_CARD, { ...CHECKING, id: "acc-savings", title: "Savings" }], transaction: TRANSACTIONS, budget: budgets, reminderMarker })
    ),
    suggest: vi.fn().mockResolvedValue([]),
  } as unknown as ZenMoneyAPI;
  const state = new ZenState(api);
  await state.sync();
  vi.mocked(api.diff).mockResolvedValue(empty(1700000001));
  const pair = await createMcpPair(api, state);
  await connectPair(pair);
  const call = (name: string, args: Record<string, unknown>) =>
    pair.client.callTool({ name, arguments: args });
  return { api, state, call };
}

describe("budget sync", () => {
  it("asks for budgets on a full sync and stores them by month and category", async () => {
    const { api, state } = await setup();
    expect(vi.mocked(api.diff).mock.calls[0][0].forceFetch).toContain("budget");
    expect(state.getBudgets()).toHaveLength(5);
    expect(state.findBudget("2026-03-01", "tag-food")?.outcome).toBe(200);
  });

  it("replaces a budget the next sync brings", async () => {
    const { api, state } = await setup();
    vi.mocked(api.diff).mockResolvedValueOnce(
      empty(1700000002, { budget: [budget({ tag: "tag-food", outcome: 250, changed: 2000 })] })
    );
    await state.sync();
    expect(state.findBudget("2026-03-01", "tag-food")?.outcome).toBe(250);
    expect(state.getBudgets()).toHaveLength(5);
  });
});

describe("get_budget", () => {
  it("compares plans with facts, subcategories and other currencies included", async () => {
    const { call } = await setup();
    const text = getTextContent(await call("get_budget", { month: "2026-03" }));
    expect(text).toContain("Budget for 2026-03 | USD");
    expect(text).toContain("- All categories: plan 500.00 USD | spent 108.00 USD | left 392.00 USD");
    expect(text).toContain("- Food: plan 200.00 USD | spent 101.00 USD | left 99.00 USD | subcategory plans 60.00 USD");
    expect(text).toContain("- Food / Restaurants: plan 60.00 USD | spent 71.00 USD | over by 11.00 USD");
    expect(text).toContain("Income:\n- Salary: plan 1200.00 USD | received 1000.00 USD | still expected 200.00 USD");
    expect(text).toContain("This month, in the budget: spent 108.00 USD, received 1000.00 USD");
    expect(text.indexOf("All categories")).toBeLessThan(text.indexOf("- Food"));
  });

  it("narrows to a category and its subcategories", async () => {
    const { call } = await setup();
    const text = getTextContent(await call("get_budget", { month: "2026-03", category: "Restaurants" }));
    expect(text).toContain("Food / Restaurants");
    expect(text).not.toContain("- Food:");
    expect(text).not.toContain("All categories");
    expect(text).toContain("Restaurants this month: spent 71.00 USD");
  });

  it("says when a month has no budget", async () => {
    const { call } = await setup();
    const text = getTextContent(await call("get_budget", { month: "2026-04" }));
    expect(text).toContain("No budget set for 2026-04.");
  });

  it("refuses to answer when an account of a transaction is missing", async () => {
    const { state, call } = await setup();
    state.accounts = state.accounts.filter((a) => a.id !== "acc-euro");
    const result = await call("get_budget", { month: "2026-03" });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("account acc-euro of transaction t3 is missing");
  });

  describe("planned operations", () => {
    const planned = (id: string, overrides: Partial<ReminderMarker> = {}) =>
      marker({ id, date: "2026-03-20", outcome: 40, tag: ["tag-food"], ...overrides });

    it("adds the month's planned operations to a plan that is not fixed", async () => {
      const { call } = await setup(
        [budget({ tag: "tag-food", outcome: 100 }), budget({ tag: "tag-restaurants", outcome: 60, outcomeLock: true })],
        [
          planned("m1"),
          // 50 EUR at a rate of 0.92 against USD is 46 USD
          planned("m2", { outcome: 50, outcomeInstrument: 2, incomeInstrument: 2, outcomeAccount: "acc-euro", incomeAccount: "acc-euro" }),
          planned("m3", { tag: ["tag-restaurants"], outcome: 15 }),
        ]
      );
      const text = getTextContent(await call("get_budget", { month: "2026-03" }));
      expect(text).toContain("- Food: plan 186.00 USD (100.00 USD set + 86.00 USD planned operations) | spent 101.00 USD | left 85.00 USD");
      // A fixed plan is the amount itself
      expect(text).toContain("- Food / Restaurants: plan 60.00 USD | spent 71.00 USD");
    });

    it("shows a plan made only of planned operations", async () => {
      const { call } = await setup(
        [budget({ tag: "tag-food", outcome: 0 })],
        [planned("m1"), planned("m2", { tag: ["tag-salary"], outcome: 0, income: 900 }), planned("m3", { tag: null, outcome: 5 })]
      );
      const text = getTextContent(await call("get_budget", { month: "2026-03" }));
      expect(text).toContain("- All categories: plan 45.00 USD (45.00 USD planned operations) | spent 108.00 USD");
      expect(text).toContain("- Food: plan 40.00 USD (40.00 USD planned operations) | spent 101.00 USD");
      expect(text).toContain("- Uncategorized: plan 5.00 USD (5.00 USD planned operations) | spent 7.00 USD");
      expect(text).toContain("Income:\n- All categories: plan 900.00 USD (900.00 USD planned operations)");
      expect(text).toContain("- Salary: plan 900.00 USD (900.00 USD planned operations) | received 1000.00 USD");
    });

    it("leaves out what a budget does not count", async () => {
      const { state, call } = await setup(
        [budget({ tag: "tag-food", outcome: 100 })],
        [
          planned("other-month", { date: "2026-04-01" }),
          planned("processed", { state: "processed" }),
          planned("transfer", { incomeAccount: "acc-savings", income: 40 }),
          planned("zerro", { outcomeAccount: "acc-zerro", incomeAccount: "acc-zerro" }),
        ]
      );
      state.accounts.push({ ...state.accounts[0], id: "acc-zerro", title: "🤖 [Zerro Data]" });
      const text = getTextContent(await call("get_budget", { month: "2026-03" }));
      expect(text).toContain("- Food: plan 100.00 USD | spent 101.00 USD");
      expect(text).not.toContain("planned operations");
    });

    it("refuses to answer when an account of a planned operation is missing", async () => {
      const { call } = await setup(BUDGETS, [planned("m1", { outcomeAccount: "acc-gone", incomeAccount: "acc-gone" })]);
      const result = await call("get_budget", { month: "2026-03" });
      expect(result.isError).toBe(true);
      expect(getTextContent(result)).toContain("account acc-gone of planned operation m1 is missing");
    });
  });

  it("leaves categories excluded from the budget out of the month's total", async () => {
    const { state, call } = await setup(BUDGETS, [marker({ id: "m1", date: "2026-03-20", outcome: 40, tag: ["tag-food"] })]);
    state.tags = state.tags.map((t) =>
      t.id === "tag-food" ? { ...t, budgetOutcome: false } : t.id === "tag-salary" ? { ...t, budgetIncome: false } : t);
    const text = getTextContent(await call("get_budget", { month: "2026-03" }));
    // Restaurants keeps its own flag; the planned 40 is in Food
    expect(text).toContain("- All categories: plan 500.00 USD | spent 78.00 USD | left 422.00 USD");
    expect(text).toContain("- Food: plan 200.00 USD | spent 101.00 USD");
    expect(text).toContain("- Salary: plan 1200.00 USD | received 1000.00 USD");
    expect(text).toContain("This month, in the budget: spent 78.00 USD, received 0.00 USD");
  });

  it("leaves planned operations of excluded categories out of an unlocked total plan", async () => {
    const { state, call } = await setup(
      [budget({ tag: TOTAL_BUDGET_TAG, outcome: 100, income: 0 })],
      [
        marker({ id: "food", date: "2026-03-20", outcome: 40, tag: ["tag-food"] }),
        marker({ id: "cafe", date: "2026-03-21", outcome: 15, tag: ["tag-restaurants"] }),
        marker({ id: "pay", date: "2026-03-25", outcome: 0, income: 900, tag: ["tag-salary"] }),
        marker({ id: "bonus", date: "2026-03-26", outcome: 0, income: 50, tag: null }),
      ]
    );
    state.tags = state.tags.map((t) =>
      t.id === "tag-food" ? { ...t, budgetOutcome: false } : t.id === "tag-salary" ? { ...t, budgetIncome: false } : t);
    const text = getTextContent(await call("get_budget", { month: "2026-03" }));
    expect(text).toContain("- All categories: plan 115.00 USD (100.00 USD set + 15.00 USD planned operations) | spent 78.00 USD");
    expect(text).toContain("Income:\n- All categories: plan 50.00 USD (50.00 USD planned operations) | received 0.00 USD");
  });

  it("rejects a malformed month", async () => {
    const { call } = await setup();
    const result = await call("get_budget", { month: "2026-13" });
    expect(result.isError).toBe(true);
  });
});

describe("set_budget", () => {
  it("writes a locked plan and keeps the other side", async () => {
    const { api, state, call } = await setup();
    const result = await call("set_budget", { month: "2026-03", category: "Food", income: 50 });
    expect(result.isError).toBeFalsy();
    const sent = vi.mocked(api.diff).mock.calls[1][0].budget![0];
    expect(sent).toMatchObject({ tag: "tag-food", date: "2026-03-01", outcome: 200, outcomeLock: true, income: 50, incomeLock: true, user: 1 });
    expect(state.findBudget("2026-03-01", "tag-food")?.income).toBe(50);
    expect(getTextContent(result)).toBe("Budget for Food, 2026-03:\n- Expenses: 200.00 USD\n- Income: 50.00 USD (was none)");
  });

  it("creates a total budget for a new month", async () => {
    const { api, call } = await setup();
    await call("set_budget", { month: "2026-05", total: true, outcome: 900 });
    expect(vi.mocked(api.diff).mock.calls[1][0].budget![0]).toMatchObject({
      tag: TOTAL_BUDGET_TAG,
      date: "2026-05-01",
      outcome: 900,
      outcomeLock: true,
      income: 0,
      incomeLock: false,
    });
  });

  it("removes a plan with 0", async () => {
    const { api, call } = await setup();
    const result = await call("set_budget", { month: "2026-03", category: "Restaurants", outcome: 0 });
    expect(vi.mocked(api.diff).mock.calls[1][0].budget![0]).toMatchObject({ outcome: 0, outcomeLock: false });
    expect(getTextContent(result)).toContain("- Expenses: none (was 60.00 USD)");
  });

  it.each([
    [{ month: "2026-03", outcome: 5 }, "Pass either category or total: true."],
    [{ month: "2026-03", category: "Food", total: true, outcome: 5 }, "Pass either category or total: true."],
    [{ month: "2026-03", category: "Food" }, "Pass outcome, income or both."],
  ])("refuses %o", async (args, message) => {
    const { api, call } = await setup();
    const result = await call("set_budget", args);
    expect(getTextContent(result)).toBe(message);
    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it("refuses a category deleted by a sync ahead of it", async () => {
    const { api, state, call } = await setup();
    let answer!: (resp: DiffResponse) => void;
    vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const sync = state.sync();
    const pending = call("set_budget", { month: "2026-03", category: "Food", outcome: 5 });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    answer(empty(1700000002, { deletion: [{ id: "tag-food", object: "tag", stamp: 1, user: 1 }] }));
    await sync;
    expect(getTextContent(await pending)).toContain("Category tag-food was deleted in ZenMoney meanwhile");
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it("says a retry is safe when the outcome is unknown", async () => {
    const { api, call } = await setup();
    const { ZenMoneyError } = await import("../src/api.js");
    vi.mocked(api.diff).mockRejectedValueOnce(new ZenMoneyError("timed out", true));
    const text = getTextContent(await call("set_budget", { month: "2026-03", category: "Food", outcome: 5 }));
    expect(text).toContain("Affected id: budget 2026-03-01 tag-food");
    expect(text).toContain("setting it again is safe");
  });

  it("catches up before the next write after an unknown outcome", async () => {
    const { api, state, call } = await setup();
    const { ZenMoneyError } = await import("../src/api.js");
    vi.mocked(api.diff).mockRejectedValueOnce(new ZenMoneyError("timed out", true));
    const first = call("set_budget", { month: "2026-03", category: "Food", outcome: 500 });
    // Queued behind the lost write, before anyone could sync
    const second = call("set_budget", { month: "2026-03", category: "Food", income: 50 });
    // The lost write did land
    vi.mocked(api.diff).mockResolvedValueOnce(
      empty(1700000002, { budget: [budget({ tag: "tag-food", outcome: 500, outcomeLock: true, changed: 3000 })] })
    );
    expect((await first).isError).toBe(true);
    expect((await second).isError).toBeFalsy();
    const calls = vi.mocked(api.diff).mock.calls;
    expect(calls[2][0].budget).toBeUndefined();
    expect(calls[3][0].budget![0]).toMatchObject({ outcome: 500, income: 50 });
    expect(state.age).toBeLessThan(1000);
  });

  it("refuses when the main currency changed meanwhile", async () => {
    const { api, state, call } = await setup();
    const { USER } = await import("./fixtures.js");
    let answer!: (resp: DiffResponse) => void;
    vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    const sync = state.sync();
    const pending = call("set_budget", { month: "2026-03", category: "Food", outcome: 5 });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    answer(empty(1700000002, { user: [{ ...USER, currency: 2 }] }));
    await sync;
    expect(getTextContent(await pending)).toContain("Your main currency changed in ZenMoney meanwhile");
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it("warns when the server kept a different lock", async () => {
    const { api, call } = await setup();
    vi.mocked(api.diff).mockImplementationOnce(async (req) =>
      empty(1700000002, { budget: [{ ...req.budget![0], outcomeLock: false, changed: 9_999_999_999 }] })
    );
    const text = getTextContent(await call("set_budget", { month: "2026-03", category: "Food", outcome: 200 }));
    expect(text).toContain("Warning: the server kept a different version");
  });

  it("keeps the other side a write queued ahead set", async () => {
    const { api, call } = await setup();
    await Promise.all([
      call("set_budget", { month: "2026-06", category: "Food", outcome: 10 }),
      call("set_budget", { month: "2026-06", category: "Food", income: 20 }),
    ]);
    expect(vi.mocked(api.diff).mock.calls[2][0].budget![0]).toMatchObject({ outcome: 10, income: 20 });
  });
});
