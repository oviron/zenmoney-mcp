import { describe, it, expect, vi } from "vitest";
import { ZenState } from "../src/state.js";
import type { DiffResponse, ZenMoneyAPI } from "../src/api.js";
import { CHECKING, makeDiffResponse, makeTransaction } from "./fixtures.js";
import { createMcpPair, connectPair, getTextContent } from "./helpers.js";

const EXPENSE = makeTransaction({ id: "tx-expense", outcome: 50, date: "2026-03-20" });

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

async function setup() {
  const api = {
    diff: vi.fn().mockResolvedValueOnce(makeDiffResponse({ transaction: [EXPENSE] })),
    suggest: vi.fn().mockResolvedValue([]),
  } as unknown as ZenMoneyAPI;
  const state = new ZenState(api);
  await state.sync();
  const pair = await createMcpPair(api, state);
  await connectPair(pair);
  const call = (name: string, args: Record<string, unknown>) =>
    pair.client.callTool({ name, arguments: args });
  return { api, state, call };
}

/**
 * Start a sync whose answer arrives only when `answer` is called, so that a
 * tool call made meanwhile queues its write behind it.
 */
function holdSync(api: ZenMoneyAPI, state: ZenState) {
  let answer!: (resp: DiffResponse) => void;
  vi.mocked(api.diff).mockImplementationOnce(
    () => new Promise((resolve) => (answer = resolve))
  );
  const done = state.sync();
  return { answer: (resp: DiffResponse) => answer(resp), done };
}

describe("checks at the write's turn in the queue", () => {
  it.each([
    [
      "deleted",
      empty(1700000001, { deletion: [{ id: "acc-checking", object: "account", stamp: 1, user: 1 }] }),
      "Account Checking was deleted in ZenMoney meanwhile",
    ],
    [
      "moved to another currency",
      empty(1700000001, { account: [{ ...CHECKING, instrument: 2 }] }),
      "Account Checking changed its currency in ZenMoney meanwhile",
    ],
  ])("refuses an expense on an account %s by a sync ahead of it", async (_, resp, message) => {
    const { api, state, call } = await setup();
    const sync = holdSync(api, state);
    const pending = call("add_expense", { account: "Checking", amount: 5, date: "2026-03-20" });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    sync.answer(resp);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(getTextContent(result)).toContain("Nothing was saved");
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it("refuses an expense whose category was deleted meanwhile", async () => {
    const { api, state, call } = await setup();
    const sync = holdSync(api, state);
    const pending = call("add_expense", {
      account: "Checking",
      amount: 5,
      date: "2026-03-20",
      category: "Food",
    });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    sync.answer(empty(1700000001, { deletion: [{ id: "tag-food", object: "tag", stamp: 1, user: 1 }] }));
    const result = await pending;
    expect(getTextContent(result)).toContain("Category tag-food was deleted in ZenMoney meanwhile");
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it("refuses to move a transaction to an account deleted meanwhile", async () => {
    const { api, state, call } = await setup();
    const sync = holdSync(api, state);
    const pending = call("update_transaction", { id: "tx-expense", account: "Savings" });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    sync.answer(empty(1700000001, { deletion: [{ id: "acc-savings", object: "account", stamp: 1, user: 1 }] }));
    const result = await pending;
    expect(getTextContent(result)).toContain("Account Savings was deleted in ZenMoney meanwhile");
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ amount: 5 }],
    [{ outcome_amount: 5 }],
    [{ outcome_amount: 0, income_amount: 5 }],
  ])("refuses new amounts %o when the transaction changed currency meanwhile", async (args) => {
    const { api, state, call } = await setup();
    const sync = holdSync(api, state);
    const pending = call("update_transaction", { id: "tx-expense", ...args });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    sync.answer(
      empty(1700000001, {
        account: [{ ...CHECKING, instrument: 2 }],
        transaction: [{ ...EXPENSE, incomeInstrument: 2, outcomeInstrument: 2, changed: EXPENSE.changed + 1 }],
      })
    );
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("Transaction tx-expense changed its currency in ZenMoney meanwhile");
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it("lets an update without amounts through after a currency change", async () => {
    const { api, state, call } = await setup();
    const sync = holdSync(api, state);
    vi.mocked(api.diff).mockResolvedValueOnce(empty(1700000002));
    const pending = call("update_transaction", { id: "tx-expense", comment: "lunch" });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    sync.answer(
      empty(1700000001, {
        account: [{ ...CHECKING, instrument: 2 }],
        transaction: [{ ...EXPENSE, incomeInstrument: 2, outcomeInstrument: 2, changed: EXPENSE.changed + 1 }],
      })
    );
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[2][0].transaction![0]).toMatchObject({ outcomeInstrument: 2, comment: "lunch" });
  });

  it("refuses a transfer when its destination changed currency meanwhile", async () => {
    const { api, state, call } = await setup();
    const sync = holdSync(api, state);
    const pending = call("add_transfer", {
      from_account: "Checking",
      to_account: "Savings",
      amount: 10,
      date: "2026-03-20",
    });
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    const { SAVINGS } = await import("./fixtures.js");
    sync.answer(empty(1700000001, { account: [{ ...SAVINGS, instrument: 2 }] }));
    const result = await pending;
    expect(getTextContent(result)).toContain("Account Savings changed its currency");
    expect(api.diff).toHaveBeenCalledTimes(2);
  });
});

describe("confirmations", () => {
  it("show what the server kept for a new expense", async () => {
    const { api, call } = await setup();
    vi.mocked(api.diff).mockImplementationOnce(async (req) => {
      const sent = req.transaction![0];
      return empty(1700000001, { transaction: [{ ...sent, outcome: 7, changed: sent.changed + 1 }] });
    });
    const result = await call("add_expense", { account: "Checking", amount: 5, date: "2026-03-20" });
    const text = getTextContent(result);
    expect(text).toContain("- Amount: 7 USD");
    expect(text).toContain("Warning: the server kept a different version (outcome: 5 USD → 7 USD)");
  });

  it("report a transaction the server kept instead of deleting", async () => {
    const { api, call } = await setup();
    const newer = { ...EXPENSE, outcome: 60, changed: 9_999_999_999 };
    vi.mocked(api.diff).mockResolvedValueOnce(empty(1700000001, { transaction: [newer] }));
    const result = await call("delete_transaction", { id: "tx-expense", confirm: true });
    expect(result.isError).toBe(true);
    const text = getTextContent(result);
    expect(text).toContain("ZenMoney kept this transaction");
    expect(text).toContain("60");
    expect(text).not.toContain("Transaction deleted");
  });

  it("name a merchant the update re-matched", async () => {
    const { api, call } = await setup();
    vi.mocked(api.diff).mockResolvedValueOnce(empty(1700000001));
    const result = await call("update_transaction", { id: "tx-expense", payee: "Corner Cafe" });
    expect(getTextContent(result)).toContain("merchant: none → Corner Cafe");
  });
});
