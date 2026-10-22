import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffResponse } from "../src/api.js";
import { ZenMoneyError } from "../src/api.js";
import { ZenState } from "../src/state.js";
import { DEBT_ACCOUNT, EUR, EURO_CARD, SAVINGS, makeDiffResponse, makeTransaction } from "./fixtures.js";
import { connectPair, createMcpPair, createMockApi, getTextContent } from "./helpers.js";

const EXPENSE = makeTransaction({
  id: "expense", outcome: 100, opOutcome: 110, opOutcomeInstrument: 2,
});
const INCOME = makeTransaction({
  id: "income", income: 100, opIncome: 110, opIncomeInstrument: 2,
});
const TRANSFER = makeTransaction({
  id: "transfer", outcome: 100, income: 95, incomeAccount: SAVINGS.id,
  opOutcome: 110, opOutcomeInstrument: 3, opIncome: 105, opIncomeInstrument: 3,
});
const ID = "61e2c103-3070-413a-aea8-1e4bafef167f";
const DATE = "2026-03-20";
const empty = (overrides: Partial<DiffResponse> = {}) => makeDiffResponse({
  serverTimestamp: 1700000001, instrument: [], company: [], user: [], account: [],
  tag: [], merchant: [], transaction: [], deletion: [], ...overrides,
});

let api: ReturnType<typeof createMockApi>;
let state: ZenState;
let pair: Awaited<ReturnType<typeof createMcpPair>>;
const call = (name: string, args: Record<string, unknown>) =>
  pair.client.callTool({ name, arguments: args });
const sent = () => vi.mocked(api.diff).mock.calls.at(-1)![0].transaction![0];

beforeEach(async () => {
  api = createMockApi({ transaction: [EXPENSE, INCOME, TRANSFER] });
  state = new ZenState(api);
  await state.sync();
  state.accounts.push({ ...DEBT_ACCOUNT });
  vi.mocked(api.diff).mockClear().mockResolvedValue(empty());
  pair = await createMcpPair(api, state);
  await connectPair(pair);
});
afterEach(async () => {
  await pair.client.close();
  await pair.server.close();
});

describe("update currency semantics", () => {
  it.each([
    ["expense", { account: "Euro Card" }, "outcome_amount"],
    ["income", { account: "Euro Card" }, "income_amount"],
    ["transfer", { from_account: "Euro Card" }, "outcome_amount"],
    ["transfer", { to_account: "Euro Card" }, "income_amount"],
    ["transfer", { from_account: "Euro Card", income_amount: 90 }, "outcome_amount"],
    ["transfer", { to_account: "Euro Card", outcome_amount: 90 }, "income_amount"],
  ])("rejects %s currency change without a new amount: %j", async (id, changes, parameter) => {
    const result = await call("update_transaction", { id, ...changes });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("currency");
    expect(getTextContent(result)).toContain(parameter);
    expect(api.diff).not.toHaveBeenCalled();
    expect(state.findTransaction(id)).toEqual({ expense: EXPENSE, income: INCOME, transfer: TRANSFER }[id]);
  });

  it.each([
    ["expense", { amount: 90 }, { outcome: 90, income: 0 }],
    ["expense", { outcome_amount: 90 }, { outcome: 90, income: 0 }],
    ["income", { amount: 90 }, { income: 90, outcome: 0 }],
    ["income", { income_amount: 90 }, { income: 90, outcome: 0 }],
  ])("moves %s with an explicit amount: %j", async (id, amounts, expected) => {
    const result = await call("update_transaction", { id, account: "Euro Card", ...amounts });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({
      ...expected, incomeAccount: EURO_CARD.id, outcomeAccount: EURO_CARD.id,
      incomeInstrument: 2, outcomeInstrument: 2,
      opIncome: null, opIncomeInstrument: null, opOutcome: null, opOutcomeInstrument: null,
    });
  });

  it.each([
    [{ from_account: "Euro Card", outcome_amount: 90 }, {
      outcomeAccount: EURO_CARD.id, outcomeInstrument: 2, outcome: 90,
      opOutcome: null, opOutcomeInstrument: null, opIncome: 105, opIncomeInstrument: 3,
    }],
    [{ to_account: "Euro Card", income_amount: 85 }, {
      incomeAccount: EURO_CARD.id, incomeInstrument: 2, income: 85,
      opIncome: null, opIncomeInstrument: null, opOutcome: 110, opOutcomeInstrument: 3,
    }],
  ])("clears only the changed transfer side's original amount: %j", async (changes, expected) => {
    const result = await call("update_transaction", { id: "transfer", ...changes });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject(expected);
  });

  it("keeps the amount and original currency when moving within the same currency", async () => {
    const result = await call("update_transaction", { id: "expense", account: "Savings" });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ outcome: 100, opOutcome: 110, opOutcomeInstrument: 2 });
  });

  it("validates against the transaction version present at the write's turn", async () => {
    let answer!: (response: DiffResponse) => void;
    vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const syncing = state.sync();
    const pending = call("update_transaction", { id: "expense", account: "Savings" });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(1));
    answer(empty({ transaction: [{ ...EXPENSE, outcomeInstrument: 2, incomeInstrument: 2 }] }));
    await syncing;
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("outcome_amount");
    expect(api.diff).toHaveBeenCalledTimes(1);
  });
});

describe("single-account operations", () => {
  it.each([
    ["expense", { income_amount: 90 }, "outcome_amount: 0"],
    ["income", { outcome_amount: 90 }, "income_amount: 0"],
  ])("rejects a second nonzero side of %s", async (id, changes, hint) => {
    const result = await call("update_transaction", { id, ...changes });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(hint);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it.each([
    ["expense", { income_amount: 90, outcome_amount: 0 }],
    ["income", { outcome_amount: 90, income_amount: 0 }],
  ])("allows explicit conversion of %s to the other type", async (id, changes) => {
    const result = await call("update_transaction", { id, ...changes });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ income: changes.income_amount, outcome: changes.outcome_amount });
  });

  it("rejects a whole batch if one operation would have two nonzero sides", async () => {
    const result = await call("update_transaction", { id: ["transfer", "expense"], income_amount: 90 });
    expect(result.isError).toBe(true);
    expect(api.diff).not.toHaveBeenCalled();
    expect(state.findTransaction("transfer")).toEqual(TRANSFER);
  });
});

describe("transfer amount alias", () => {
  it("rejects conflicting amount and outcome_amount", async () => {
    const result = await call("add_transfer", {
      from_account: "Checking", to_account: "Savings", amount: 100, outcome_amount: 90, date: DATE,
    });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("amount");
    expect(getTextContent(result)).toContain("outcome_amount");
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("allows equal amount and outcome_amount", async () => {
    const result = await call("add_transfer", {
      from_account: "Checking", to_account: "Savings", amount: 100, outcome_amount: 100, date: DATE,
    });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ outcome: 100, income: 100 });
  });
});

describe.each(["add_expense", "add_income"])("%s creation semantics", (tool) => {
  const args = { account: "Checking", amount: 100, date: DATE };

  it("accepts multiple categories by name and id", async () => {
    const result = await call(tool, { ...args, category: ["Food", "tag-restaurants"] });
    expect(result.isError).toBeFalsy();
    expect(sent().tag).toEqual(["tag-food", "tag-restaurants"]);
    expect(getTextContent(result)).toContain("Food, Restaurants");
  });

  it("accepts an empty category array as uncategorized", async () => {
    const result = await call(tool, { ...args, category: [] });
    expect(result.isError).toBeFalsy();
    expect(sent().tag).toBeNull();
  });

  it.each([["Food", "Missing"], ["Food", "a"]])("rejects an unresolved category in %j", async (...category) => {
    const result = await call(tool, { ...args, category });
    expect(result.isError).toBe(true);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("stores and confirms the original foreign currency amount", async () => {
    const result = await call(tool, { ...args, original_amount: 92, original_currency: "eur" });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject(tool === "add_expense" ? {
      outcome: 100, outcomeInstrument: 1, opOutcome: 92, opOutcomeInstrument: 2,
      opIncome: null, opIncomeInstrument: null,
    } : {
      income: 100, incomeInstrument: 1, opIncome: 92, opIncomeInstrument: 2,
      opOutcome: null, opOutcomeInstrument: null,
    });
    expect(getTextContent(result)).toContain("92 EUR");
    expect(getTextContent(result)).toContain("100 USD");
  });

  it("confirms the original amount kept by the server", async () => {
    vi.mocked(api.diff).mockImplementationOnce(async (req) => {
      const transaction = req.transaction![0];
      return empty({ transaction: [{ ...transaction,
        ...(tool === "add_expense" ? { opOutcome: 93 } : { opIncome: 93 }),
      }] });
    });
    const result = await call(tool, { ...args, original_amount: 92, original_currency: "EUR" });
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("Original amount: 93 EUR");
    expect(getTextContent(result)).not.toContain("Original amount: 92 EUR");
  });

  it.each([
    [{ original_amount: 92 }, "together"],
    [{ original_currency: "EUR" }, "together"],
    [{ original_amount: 92, original_currency: "EU" }, "not found"],
    [{ original_amount: 92, original_currency: "Euro" }, "not found"],
    [{ original_amount: 92, original_currency: "USD" }, "same"],
  ])("rejects invalid original amount/currency: %j", async (original, message) => {
    const result = await call(tool, { ...args, ...original });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("rejects ambiguous currency codes", async () => {
    state.instruments.push({ ...EUR, id: 9 });
    const result = await call(tool, { ...args, original_amount: 92, original_currency: "EUR" });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("ambiguous");
    expect(api.diff).not.toHaveBeenCalled();
  });

  it.each([0, -1])("rejects non-positive original amount %s", async (original_amount) => {
    const result = await call(tool, { ...args, original_amount, original_currency: "EUR" });
    expect(result.isError).toBe(true);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it.each([
    ["cOrNeR cAfE", "merchant-cafe"],
    ["Corner", null],
    ["Unknown Shop", null],
    ["", null],
  ])("links the merchant only on exact case-insensitive payee match: %s", async (payee, merchant) => {
    const result = await call(tool, { ...args, payee });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ payee, merchant });
  });

  it("matches the merchant again at the write's turn", async () => {
    let answer!: (response: DiffResponse) => void;
    vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const syncing = state.sync();
    const pending = call(tool, { ...args, payee: "Corner Cafe" });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(1));
    answer(empty({ deletion: [{ object: "merchant", id: "merchant-cafe", stamp: 1, user: 1 }] }));
    await syncing;
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ payee: "Corner Cafe", merchant: null });
  });
});

describe.each([
  ["add_expense", { account: "Checking", amount: 100, date: DATE }],
  ["add_income", { account: "Checking", amount: 100, date: DATE }],
  ["add_transfer", { from_account: "Checking", to_account: "Savings", amount: 100, date: DATE }],
  ["add_debt", { direction: "lend", account: "Euro Card", amount: 100, counterparty: "Alice", date: DATE }],
])("%s idempotent creation", (tool, args) => {
  it("sends the supplied UUID", async () => {
    const result = await call(tool, { ...args, id: ID });
    expect(result.isError).toBeFalsy();
    expect(sent().id).toBe(ID);
    expect(getTextContent(result)).toContain(ID);
  });

  it("generates a UUID when id is omitted", async () => {
    const result = await call(tool, args);
    expect(result.isError).toBeFalsy();
    expect(sent().id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it.each(["not-a-uuid", "", "61e2c1033070413aaea81e4bafef167f"])("rejects invalid UUID %s", async (id) => {
    const result = await call(tool, { ...args, id });
    expect(result.isError).toBe(true);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("shows the cached version without overwriting it", async () => {
    state.upsertTransaction({ ...EXPENSE, id: ID, outcome: 321, comment: "saved earlier" });
    const result = await call(tool, { ...args, id: ID.toUpperCase() });
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("already exists");
    expect(getTextContent(result)).toContain("321 USD");
    expect(getTextContent(result)).toContain("saved earlier");
    expect(api.diff).not.toHaveBeenCalled();
    expect(state.findTransaction(ID)?.outcome).toBe(321);
  });

  it("shows a deleted cached transaction without recreating it", async () => {
    vi.mocked(api.diff).mockResolvedValueOnce(empty({
      transaction: [{ ...EXPENSE, id: ID, outcome: 321, deleted: true }],
    }));
    await state.sync();
    vi.mocked(api.diff).mockClear();
    const result = await call(tool, { ...args, id: ID });
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("already exists (deleted)");
    expect(getTextContent(result)).toContain("321 USD");
    expect(api.diff).not.toHaveBeenCalled();
    expect(state.findTransaction(ID)).toBeUndefined();
  });

  it("sends the same id on retry after an uncertain outcome", async () => {
    vi.mocked(api.diff).mockRejectedValueOnce(new ZenMoneyError("Lost response", true));
    const first = await call(tool, { ...args, id: ID });
    expect(first.isError).toBe(true);
    expect(getTextContent(first)).toContain("may or may not have been saved");
    const second = await call(tool, { ...args, id: ID });
    expect(second.isError).toBeFalsy();
    // The retry syncs first: the lost write may have landed
    expect(vi.mocked(api.diff).mock.calls.map(([req]) => req.transaction?.[0].id)).toEqual([ID, undefined, ID]);
    expect(state.transactions.filter((tx) => tx.id === ID)).toHaveLength(1);
  });

  it("sends only once when two calls use the same id concurrently", async () => {
    const results = await Promise.all([call(tool, { ...args, id: ID }), call(tool, { ...args, id: ID })]);
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.map(getTextContent).some((t) => t.includes("already exists"))).toBe(true);
    expect(api.diff).toHaveBeenCalledTimes(1);
    expect(state.transactions.filter((tx) => tx.id === ID)).toHaveLength(1);
  });

  it("checks id again after a sync queued ahead of the write", async () => {
    let answer!: (response: DiffResponse) => void;
    vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const syncing = state.sync();
    const pending = call(tool, { ...args, id: ID });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(1));
    answer(empty({ transaction: [{ ...EXPENSE, id: ID, outcome: 321 }] }));
    await syncing;
    const result = await pending;
    expect(getTextContent(result)).toContain("already exists");
    expect(getTextContent(result)).toContain("321 USD");
    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it("describes recovery with the same id in the tool schema", async () => {
    const { tools } = await pair.client.listTools();
    const description = tools.find((t) => t.name === tool)!.description!;
    expect(description).toContain("same id");
    expect(description).toContain("may or may not have been saved");
  });
});
