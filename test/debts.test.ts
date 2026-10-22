import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { DiffResponse, Transaction } from "../src/api.js";
import { ZenState } from "../src/state.js";
import { CHECKING, DEBT_ACCOUNT, EURO_CARD, makeDiffResponse, makeTransaction } from "./fixtures.js";
import { connectPair, createMcpPair, createMockApi, getTextContent } from "./helpers.js";

const DATE = "2026-03-20";
const args = { direction: "lend", account: "Euro Card", amount: 100, counterparty: "Alice", date: DATE };
const empty = (overrides: Partial<DiffResponse> = {}) => makeDiffResponse({
  serverTimestamp: 1700000001, instrument: [], company: [], user: [], account: [],
  tag: [], merchant: [], transaction: [], deletion: [], ...overrides,
});
const debt = (overrides: Partial<Transaction> & { id: string }) => makeTransaction({
  outcomeAccount: EURO_CARD.id, incomeAccount: DEBT_ACCOUNT.id,
  outcome: 100, income: 100, incomeInstrument: 2, outcomeInstrument: 2,
  payee: "Alice", ...overrides,
});

let api: ReturnType<typeof createMockApi>;
let state: ZenState;
let pair: Awaited<ReturnType<typeof createMcpPair>>;
const call = (name: string, params: Record<string, unknown>) => pair.client.callTool({ name, arguments: params });
const sent = () => vi.mocked(api.diff).mock.calls.at(-1)![0].transaction![0];

async function behindSync(name: string, params: Record<string, unknown>, response: DiffResponse) {
  let answer!: (response: DiffResponse) => void;
  vi.mocked(api.diff).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  const syncing = state.sync();
  const write = vi.spyOn(state, "write");
  const pending = call(name, params);
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  answer(response);
  await syncing;
  return pending;
}

beforeEach(async () => {
  api = createMockApi({ account: [CHECKING, EURO_CARD, DEBT_ACCOUNT], transaction: [debt({ id: "loan" })] });
  state = new ZenState(api);
  await state.sync();
  vi.mocked(api.diff).mockClear().mockResolvedValue(empty());
  pair = await createMcpPair(api, state);
  await connectPair(pair);
});
afterEach(async () => {
  await pair.client.close();
  await pair.server.close();
});

describe("add_debt", () => {
  it.each([
    ["lend", EURO_CARD.id, DEBT_ACCOUNT.id],
    ["borrow", DEBT_ACCOUNT.id, EURO_CARD.id],
    ["repay_received", DEBT_ACCOUNT.id, EURO_CARD.id],
    ["repay_sent", EURO_CARD.id, DEBT_ACCOUNT.id],
  ])("books %s with equal amounts in the ordinary account currency", async (direction, from, to) => {
    const result = await call("add_debt", { ...args, direction, comment: "test loan" });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({
      outcomeAccount: from, incomeAccount: to, outcome: 100, income: 100,
      outcomeInstrument: 2, incomeInstrument: 2, payee: "Alice", merchant: null,
      date: DATE, comment: "test loan", deleted: false,
      opIncome: null, opIncomeInstrument: null, opOutcome: null, opOutcomeInstrument: null,
    });
    expect(getTextContent(result)).toContain("100 EUR");
  });

  it.each([["cOrNeR cAfE", "merchant-cafe"], ["Corner", null]])("links only an exact merchant title: %s", async (counterparty, merchant) => {
    const result = await call("add_debt", { ...args, counterparty });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ payee: counterparty, merchant });
  });

  it.each([undefined, "", "   "])("requires a nonblank counterparty: %s", async (counterparty) => {
    const result = await call("add_debt", { ...args, counterparty });
    expect(result.isError).toBe(true);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it.each([
    [{ amount: 0 }], [{ amount: -1 }], [{ direction: "give" }], [{ date: "2026-02-30" }],
  ])("rejects invalid input %j", async (invalid) => {
    expect((await call("add_debt", { ...args, ...invalid })).isError).toBe(true);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("requires a system debt account", async () => {
    state.accounts = state.accounts.filter((a) => a.type !== "debt");
    const result = await call("add_debt", args);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("No debt account");
    expect(api.diff).not.toHaveBeenCalled();
  });

  it.each(["Debts", "Old Card", "Card", "Missing"])("rejects a debt, archived, ambiguous or missing ordinary account: %s", async (account) => {
    state.accounts.push({ ...EURO_CARD, id: "old", title: "Old Card", archive: true });
    state.accounts.push({ ...CHECKING, id: "other-card", title: "Other Card" });
    const result = await call("add_debt", { ...args, account });
    expect(result.isError).toBe(true);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("uses the main currency when the ordinary account has no instrument", async () => {
    state.accounts = state.accounts.map((a) => a.id === EURO_CARD.id ? { ...a, instrument: null } : a);
    expect((await call("add_debt", args)).isError).toBeFalsy();
    expect(sent()).toMatchObject({ incomeInstrument: 1, outcomeInstrument: 1 });
  });

  it("confirms the version kept by the server", async () => {
    vi.mocked(api.diff).mockImplementationOnce(async (req) => empty({
      transaction: [{ ...req.transaction![0], income: 70, outcome: 70, payee: "Bob" }],
    }));
    const result = await call("add_debt", args);
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("70 EUR");
    expect(getTextContent(result)).toContain("Bob");
    expect(getTextContent(result)).toContain("server kept a different version");
  });

  it("has the same write annotations as add_expense", async () => {
    const { tools } = await pair.client.listTools();
    expect(tools.find((t) => t.name === "add_debt")!.annotations)
      .toEqual(tools.find((t) => t.name === "add_expense")!.annotations);
    expect(tools.find((t) => t.name === "list_debts")!.annotations?.readOnlyHint).toBe(true);
    const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["add_debt", "list_debts"]));
  });
});

describe("ordinary transfer and account guards", () => {
  it.each([
    [{ from_account: "Euro Card", to_account: "Debts" }],
    [{ from_account: "Debts", to_account: "Euro Card" }],
  ])("rejects add_transfer with a debt side: %j", async (accounts) => {
    const result = await call("add_transfer", { ...accounts, amount: 100, income_amount: 100, date: DATE });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("add_debt");
    expect(api.diff).not.toHaveBeenCalled();
  });

  it.each([
    ["expense", { account: "Debts" }],
    ["expense", { from_account: "Debts", income_amount: 100 }],
    ["expense", { to_account: "Debts", income_amount: 100 }],
    ["loan", { account: "Checking" }],
    ["loan", { from_account: "Checking", outcome_amount: 100 }],
    ["loan", { to_account: "Checking", income_amount: 100 }],
  ])("rejects account changes that involve debt: %s %j", async (id, changes) => {
    state.upsertTransaction(makeTransaction({ id: "expense", outcome: 100 }));
    const result = await call("update_transaction", { id, ...changes });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("add_debt");
    expect(api.diff).not.toHaveBeenCalled();
  });
});

describe("checks at the write's turn", () => {
  it.each([
    ["ordinary account deleted", empty({ deletion: [{ object: "account", id: EURO_CARD.id, stamp: 1, user: 1 }] })],
    ["debt account deleted", empty({ deletion: [{ object: "account", id: DEBT_ACCOUNT.id, stamp: 1, user: 1 }] })],
    ["ordinary currency changed", empty({ account: [{ ...EURO_CARD, instrument: 1 }] })],
    ["ordinary account archived", empty({ account: [{ ...EURO_CARD, archive: true }] })],
    ["debt account archived", empty({ account: [{ ...DEBT_ACCOUNT, archive: true }] })],
    ["ordinary account became debt", empty({ account: [{ ...EURO_CARD, type: "debt" }] })],
    ["debt account became ordinary", empty({ account: [{ ...DEBT_ACCOUNT, type: "checking" }] })],
  ])("refuses add_debt after %s", async (_, response) => {
    const result = await behindSync("add_debt", args, response);
    expect(result.isError).toBe(true);
    expect(api.diff).toHaveBeenCalledTimes(1);
    expect(state.transactions).toHaveLength(1);
  });

  it.each([
    ["ordinary currency changed", empty({ account: [{ ...EURO_CARD, instrument: 1 }] })],
    ["ordinary account deleted", empty({ deletion: [{ object: "account", id: EURO_CARD.id, stamp: 1, user: 1 }] })],
    ["debt account deleted", empty({ deletion: [{ object: "account", id: DEBT_ACCOUNT.id, stamp: 1, user: 1 }] })],
    ["ordinary account became debt", empty({ account: [{ ...EURO_CARD, type: "debt" }] })],
    ["debt account became ordinary", empty({ account: [{ ...DEBT_ACCOUNT, type: "checking" }] })],
  ])("refuses a debt amount edit after %s", async (_, response) => {
    const result = await behindSync("update_transaction", { id: "loan", amount: 80 }, response);
    expect(result.isError).toBe(true);
    expect(api.diff).toHaveBeenCalledTimes(1);
    expect(state.findTransaction("loan")!.outcome).toBe(100);
  });

  it("matches the merchant again after a sync ahead of add_debt", async () => {
    const result = await behindSync("add_debt", { ...args, counterparty: "Corner Cafe" }, empty({
      deletion: [{ object: "merchant", id: "merchant-cafe", stamp: 1, user: 1 }],
    }));
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({ payee: "Corner Cafe", merchant: null });
  });

  it.each([
    ["add_transfer", { from_account: "Checking", to_account: "Euro Card", amount: 100, income_amount: 90, date: DATE }],
    ["update_transaction", { id: "expense", account: "Euro Card", amount: 100 }],
  ])("refuses %s if a selected ordinary account becomes debt", async (tool, params) => {
    state.upsertTransaction(makeTransaction({ id: "expense", outcome: 100 }));
    const result = await behindSync(tool, params, empty({ account: [{ ...EURO_CARD, type: "debt" }] }));
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("add_debt");
    expect(api.diff).toHaveBeenCalledTimes(1);
  });
});

describe("update existing debt", () => {
  it("edits metadata without changing historical amounts or currencies", async () => {
    state.upsertTransaction(debt({ id: "loan", incomeInstrument: 1, income: 90 }));
    const result = await call("update_transaction", {
      id: "loan", category: "Food", date: "2026-03-21", comment: "new", payee: "Corner Cafe",
    });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({
      tag: ["tag-food"], date: "2026-03-21", comment: "new", payee: "Corner Cafe", merchant: "merchant-cafe",
      income: 90, outcome: 100, incomeInstrument: 1, outcomeInstrument: 2,
    });
  });

  it.each([
    [{ amount: 80 }], [{ outcome_amount: 80 }], [{ income_amount: 80 }],
    [{ income_amount: 80, outcome_amount: 80 }],
  ])("normalizes both amounts and currencies: %j", async (amounts) => {
    state.upsertTransaction(debt({ id: "loan", incomeInstrument: 1, income: 90, opIncome: 90, opIncomeInstrument: 1 }));
    const result = await call("update_transaction", { id: "loan", ...amounts });
    expect(result.isError).toBeFalsy();
    expect(sent()).toMatchObject({
      income: 80, outcome: 80, incomeInstrument: 2, outcomeInstrument: 2,
      opIncome: null, opIncomeInstrument: null, opOutcome: null, opOutcomeInstrument: null,
    });
  });

  it("normalizes a debt whose ordinary account is the income side", async () => {
    state.upsertTransaction(debt({ id: "loan", outcomeAccount: DEBT_ACCOUNT.id, incomeAccount: EURO_CARD.id, outcomeInstrument: 1 }));
    expect((await call("update_transaction", { id: "loan", amount: 75 })).isError).toBeFalsy();
    expect(sent()).toMatchObject({ income: 75, outcome: 75, incomeInstrument: 2, outcomeInstrument: 2 });
  });

  it.each([
    [{ income_amount: 70, outcome_amount: 80 }], [{ outcome_amount: 0 }], [{ income_amount: 0 }],
  ])("rejects unequal or zero debt amounts: %j", async (amounts) => {
    const result = await call("update_transaction", { id: "loan", ...amounts });
    expect(result.isError).toBe(true);
    expect(api.diff).not.toHaveBeenCalled();
  });
});

describe("list_debts", () => {
  beforeEach(() => {
    state.transactions = [
      debt({ id: "alice-lend" }),
      debt({ id: "alice-return", outcomeAccount: DEBT_ACCOUNT.id, incomeAccount: EURO_CARD.id, income: 25, outcome: 25 }),
      debt({ id: "alice-usd", outcomeAccount: CHECKING.id, incomeInstrument: 1, outcomeInstrument: 1, income: 20, outcome: 20 }),
      debt({ id: "bob", outcomeAccount: DEBT_ACCOUNT.id, incomeAccount: CHECKING.id, incomeInstrument: 1, outcomeInstrument: 1, income: 30, outcome: 30, payee: "Bob" }),
      debt({ id: "merchant", merchant: "merchant-cafe", payee: "Ignored alias", income: 40, outcome: 40 }),
      debt({ id: "unknown", merchant: "missing", payee: null, income: 5, outcome: 5 }),
      debt({ id: "fallback", merchant: "missing", payee: "Fallback", income: 6, outcome: 6 }),
      debt({ id: "settled-lend", payee: "Settled", income: 10, outcome: 10 }),
      debt({ id: "settled-return", payee: "Settled", incomeAccount: EURO_CARD.id, outcomeAccount: DEBT_ACCOUNT.id, income: 10, outcome: 10 }),
      debt({ id: "deleted", payee: "Deleted", deleted: true }),
      makeTransaction({ id: "ordinary", outcome: 100, payee: "Ordinary" }),
      debt({ id: "both-debt", outcomeAccount: DEBT_ACCOUNT.id, payee: "Both debt" }),
    ];
  });

  it("groups counterparties and currencies without conversion and excludes deleted or non-debt operations", async () => {
    const result = await call("list_debts", {});
    expect(result.isError).toBeFalsy();
    const text = getTextContent(result);
    expect(text).toContain("Alice: owes you 75 EUR");
    expect(text).toContain("Alice: owes you 20 USD");
    expect(text).toContain("Bob: you owe 30 USD");
    expect(text).toContain("Corner Cafe: owes you 40 EUR");
    expect(text).toContain("(unknown): owes you 5 EUR");
    expect(text).toContain("Fallback: owes you 6 EUR");
    for (const excluded of ["Settled:", "Deleted", "Ordinary", "Both debt", "Ignored alias"]) expect(text).not.toContain(excluded);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("filters resolved counterparty titles by case-insensitive substring", async () => {
    const text = getTextContent(await call("list_debts", { counterparty: "aLi" }));
    expect(text).toContain("Alice: owes you 75 EUR");
    expect(text).toContain("Alice: owes you 20 USD");
    expect(text).not.toContain("Bob:");
    expect(text).not.toContain("Corner Cafe:");
  });

  it("includes zero balances only on request", async () => {
    const text = getTextContent(await call("list_debts", { include_settled: true }));
    expect(text).toContain("Settled: settled (0 EUR)");
  });

  it("hides a settled balance despite floating-point residue", async () => {
    state.transactions = [debt({ id: "a", income: 0.1, outcome: 0.1 }), debt({ id: "b", income: 0.2, outcome: 0.2 }),
      debt({ id: "c", incomeAccount: EURO_CARD.id, outcomeAccount: DEBT_ACCOUNT.id, income: 0.3, outcome: 0.3 })];
    expect(getTextContent(await call("list_debts", {}))).toContain("No debt balances");
  });

  it("preserves small debts after large repayments and amounts in scientific notation", async () => {
    state.transactions = [debt({ id: "a", income: 1e15, outcome: 1e15 }),
      debt({ id: "b", outcomeAccount: DEBT_ACCOUNT.id, incomeAccount: EURO_CARD.id, income: 1e15, outcome: 1e15 }),
      debt({ id: "c", income: 1, outcome: 1 }), debt({ id: "tiny", payee: "Tiny", income: 1e-9, outcome: 1e-9 })];
    const text = getTextContent(await call("list_debts", {}));
    expect(text).toContain("Alice: owes you 1 EUR");
    expect(text).toContain("Tiny: owes you 0.000000001 EUR");
  });

  it("reports an empty result when no debts match", async () => {
    expect(getTextContent(await call("list_debts", { counterparty: "Missing" }))).toContain("No debt balances");
  });

  it("keeps historical debt balances when the ordinary account is missing or changes currency", async () => {
    state.transactions = [debt({ id: "historical" }), debt({ id: "historical-usd", outcomeAccount: CHECKING.id,
      outcomeInstrument: 1, incomeInstrument: 1, outcome: 20, income: 20 })];
    state.accounts = state.accounts.filter((a) => a.id !== EURO_CARD.id)
      .map((a) => a.id === CHECKING.id ? { ...a, instrument: 3 } : a);
    const text = getTextContent(await call("list_debts", {}));
    expect(text).toContain("Alice: owes you 100 EUR");
    expect(text).toContain("Alice: owes you 20 USD");
  });

  it("combines case variants and hides settled currencies independently", async () => {
    state.transactions = [debt({ id: "a", income: 100, outcome: 100 }), debt({ id: "b", payee: "aLiCe",
      outcomeAccount: DEBT_ACCOUNT.id, incomeAccount: EURO_CARD.id, income: 100, outcome: 100 }),
    debt({ id: "c", outcomeAccount: CHECKING.id, incomeInstrument: 1, outcomeInstrument: 1, income: 20, outcome: 20 })];
    const text = getTextContent(await call("list_debts", {}));
    expect(text).toContain("Alice: owes you 20 USD");
    expect(text).not.toContain("EUR");
    expect(text).not.toContain("aLiCe");
  });
});

describe("debt formatting in list_transactions", () => {
  it.each([
    [EURO_CARD.id, DEBT_ACCOUNT.id, "out"], [DEBT_ACCOUNT.id, EURO_CARD.id, "in"],
  ])("shows a debt with its counterparty for %s -> %s", async (outcomeAccount, incomeAccount, direction) => {
    state.transactions = [debt({ id: "loan", outcomeAccount, incomeAccount, merchant: "merchant-cafe", payee: "Alias" })];
    const text = getTextContent(await call("list_transactions", { start_date: DATE, end_date: DATE }));
    expect(text).toContain("debt");
    expect(text).toContain(`100 EUR ${direction}`);
    expect(text).toContain("Corner Cafe");
    expect(text).not.toContain("transfer");
    expect(text).not.toContain("→ Debts");
  });
});
