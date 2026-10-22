import { describe, it, expect, vi } from "vitest";
import { ZenMoneyError, type DiffResponse } from "../src/api.js";
import { ZERRO_DATA_ACCOUNT } from "../src/state.js";
import { CHECKING, DEBT_ACCOUNT, EURO_CARD, FOOD, RESTAURANTS, SALARY, USER, USD, makeDiffResponse } from "./fixtures.js";
import { createSyncedState, createMcpPair, connectPair, getTextContent } from "./helpers.js";

function empty(overrides: Partial<DiffResponse> = {}) {
  return makeDiffResponse({
    serverTimestamp: 1700000001,
    instrument: [], company: [], user: [], account: [], tag: [], merchant: [],
    ...overrides,
  });
}

async function setup(overrides: Partial<DiffResponse> = {}) {
  const { api, state } = await createSyncedState(overrides);
  vi.mocked(api.diff).mockReset().mockResolvedValue(empty());
  const pair = await createMcpPair(api, state, { readOnly: false });
  await connectPair(pair);
  const call = (name: string, args: Record<string, unknown>) => pair.client.callTool({ name, arguments: args });
  return { api, state, call, client: pair.client };
}

async function queued(
  ctx: Awaited<ReturnType<typeof setup>>,
  name: string,
  args: Record<string, unknown>,
  response: Partial<DiffResponse>
) {
  let answer!: (response: DiffResponse) => void;
  vi.mocked(ctx.api.diff).mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  const sync = ctx.state.sync();
  const write = ctx.state.write.bind(ctx.state);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(ctx.state, "write").mockImplementation((...args) => {
    entered();
    return write(...args);
  });
  const pending = ctx.call(name, args);
  await ready;
  answer(empty(response));
  await sync;
  return pending;
}

describe("add_category", () => {
  it("sends a complete category with defaults and caches it without an echo", async () => {
    const { api, state, call } = await setup();
    const result = await call("add_category", { title: " Travel " });
    expect(result.isError).toBeFalsy();
    const sent = vi.mocked(api.diff).mock.calls[0][0].tag![0];
    expect(sent).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), changed: expect.any(Number), user: 1,
      title: "Travel", parent: null, icon: null, picture: null, color: null,
      showIncome: true, showOutcome: true, budgetIncome: true, budgetOutcome: true, required: false,
    });
    expect(sent.changed).toBeCloseTo(Date.now() / 1000, -1);
    expect(state.tags.find((t) => t.id === sent.id)).toEqual(sent);
    expect(getTextContent(result)).toContain("Travel");
    expect(getTextContent(result)).toContain(sent.id);
  });

  it.each(["Food", "tag-food"])("resolves parent %s and sends explicit options", async (parent) => {
    const { api, call } = await setup();
    const result = await call("add_category", {
      title: "Lunch", parent, show_income: false, show_outcome: false,
      budget_income: true, budget_outcome: true, color: 4281554286,
    });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[0][0].tag![0]).toMatchObject({
      title: "Lunch", parent: FOOD.id, showIncome: false, showOutcome: false,
      budgetIncome: true, budgetOutcome: true, color: 4281554286, icon: null, picture: null,
    });
  });

  it("counts a category in the budget on the sides it shows by default", async () => {
    const { api, call } = await setup();
    expect((await call("add_category", { title: "Taxi", show_income: false })).isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[0][0].tag![0]).toMatchObject({ showIncome: false, showOutcome: true, budgetIncome: false, budgetOutcome: true });
  });

  it("allows the same title under another parent", async () => {
    const { api, call } = await setup();
    expect((await call("add_category", { title: "Restaurants", parent: "Salary" })).isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[0][0].tag![0].parent).toBe(SALARY.id);
  });

  it.each([
    [{ title: "fOoD" }, {}, "already exists"],
    [{ title: "RESTAURANTS", parent: "Food" }, {}, "already exists"],
    [{ title: "New", parent: "Restaurants" }, {}, "top-level"],
    [{ title: "New", parent: "missing" }, {}, "not found"],
    [{ title: "New", parent: "Food" }, { tag: [FOOD, { ...SALARY, title: "Food" }] }, "ambiguous"],
    [{ title: "New" }, { user: [] }, "User not found"],
  ] as const)("refuses %o", async (args, overrides, message) => {
    const { api, call } = await setup(overrides as Partial<DiffResponse>);
    const result = await call("add_category", args);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it.each([
    [{ title: "New" }, { tag: [{ ...SALARY, title: "New" }] }, "already exists"],
    [{ title: "New", parent: "Food" }, { tag: [{ ...FOOD, parent: SALARY.id }] }, "top-level"],
    [{ title: "New", parent: "Food" }, { deletion: [{ object: "tag", id: FOOD.id }] }, "deleted"],
  ])("rechecks %o in the queue", async (args, response, message) => {
    const ctx = await setup();
    const result = await queued(ctx, "add_category", args, response);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(ctx.api.diff).toHaveBeenCalledTimes(1);
  });
});

describe("update_category", () => {
  it("sends the whole latest category with the requested changes", async () => {
    const { api, state, call } = await setup();
    const result = await call("update_category", {
      category: "Restaurants", title: "Dining", parent: null, show_income: true,
      show_outcome: false, budget_income: true, budget_outcome: false, color: 42,
    });
    expect(result.isError).toBeFalsy();
    const sent = vi.mocked(api.diff).mock.calls[0][0].tag![0];
    expect(sent).toEqual({ ...RESTAURANTS, changed: expect.any(Number), title: "Dining", parent: null,
      showIncome: true, showOutcome: false, budgetIncome: true, budgetOutcome: false, color: 42 });
    expect(sent.changed).toBeCloseTo(Date.now() / 1000, -1);
    expect(state.tags.find((t) => t.id === RESTAURANTS.id)).toEqual(sent);
  });

  it("moves a leaf by UUID and clears its color", async () => {
    const { api, call } = await setup({ tag: [FOOD, { ...SALARY, color: 42 }] });
    expect((await call("update_category", { category: SALARY.id, parent: FOOD.id, color: null })).isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[0][0].tag![0]).toMatchObject({ id: SALARY.id, parent: FOOD.id, color: null });
  });

  it("allows a title held under a different parent", async () => {
    const { call } = await setup();
    expect((await call("update_category", { category: "Salary", title: "Restaurants" })).isError).toBeFalsy();
  });

  it.each([
    [{ category: "missing", title: "New" }, {}, "not found"],
    [{ category: "Food", title: "New" }, { tag: [FOOD, { ...SALARY, title: "Food" }] }, "ambiguous"],
    [{ category: "Salary" }, {}, "Nothing to update"],
    [{ category: "Salary", parent: "missing" }, {}, "not found"],
    [{ category: "Salary", parent: "Food" }, { tag: [SALARY, FOOD, { ...FOOD, id: "other" }] }, "ambiguous"],
    [{ category: "Salary", parent: "Salary" }, {}, "own parent"],
    [{ category: "Salary", parent: "Restaurants" }, {}, "top-level"],
    [{ category: "Food", parent: "Salary" }, {}, "children"],
    [{ category: "Salary", title: "FOOD" }, {}, "already exists"],
    [{ category: "Restaurants", parent: null, title: "Food" }, {}, "already exists"],
    [{ category: SALARY.id, parent: "Food" }, { tag: [FOOD, SALARY, { ...RESTAURANTS, title: "Salary" }] }, "already exists"],
  ] as const)("refuses %o", async (args, overrides, message) => {
    const { api, call } = await setup(overrides as Partial<DiffResponse>);
    const result = await call("update_category", args);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("does not write unchanged values", async () => {
    const { api, call } = await setup();
    const result = await call("update_category", { category: FOOD.id, title: "Food", parent: null, show_outcome: true, color: null });
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("No changes");
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("takes its snapshot in the queue without overwriting another edit", async () => {
    const ctx = await setup();
    const result = await queued(ctx, "update_category", { category: FOOD.id, color: 7 }, {
      tag: [{ ...FOOD, title: "Groceries", budgetOutcome: false, icon: "known-icon", changed: 1700000001 }],
    });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(ctx.api.diff).mock.calls[1][0].tag![0]).toMatchObject({ title: "Groceries", budgetOutcome: false, icon: "known-icon", color: 7 });
  });

  it.each([
    [{ category: SALARY.id, title: "New" }, { deletion: [{ object: "tag", id: SALARY.id }] }, "not found"],
    [{ category: SALARY.id, parent: FOOD.id }, { deletion: [{ object: "tag", id: FOOD.id }] }, "deleted"],
    [{ category: SALARY.id, parent: FOOD.id }, { tag: [{ ...FOOD, parent: "another-root" }] }, "top-level"],
    [{ category: SALARY.id, parent: FOOD.id }, { tag: [{ ...RESTAURANTS, parent: SALARY.id }] }, "children"],
    [{ category: SALARY.id, title: "New" }, { tag: [{ ...FOOD, title: "New" }] }, "already exists"],
  ])("rechecks %o in the queue", async (args, response, message) => {
    const ctx = await setup();
    const result = await queued(ctx, "update_category", args, response);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(ctx.api.diff).toHaveBeenCalledTimes(1);
  });

  it("skips a change already applied by an earlier exchange", async () => {
    const ctx = await setup();
    const result = await queued(ctx, "update_category", { category: FOOD.id, title: "New" }, { tag: [{ ...FOOD, title: "New" }] });
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("No changes");
    expect(ctx.api.diff).toHaveBeenCalledTimes(1);
  });

  it("does not retarget a name reused after deletion", async () => {
    const ctx = await setup();
    const result = await queued(ctx, "update_category", { category: "Salary", title: "New" }, {
      deletion: [{ object: "tag", id: SALARY.id }], tag: [{ ...SALARY, id: "replacement" }],
    });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("not found");
    expect(ctx.api.diff).toHaveBeenCalledTimes(1);
  });

  it("rechecks an initially unchanged value after waiting in the queue", async () => {
    const ctx = await setup();
    const result = await queued(ctx, "update_category", { category: FOOD.id, title: "Food" }, { tag: [{ ...FOOD, title: "Groceries" }] });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(ctx.api.diff).mock.calls[1][0].tag![0].title).toBe("Food");
  });
});

describe("add_account", () => {
  it.each(["cash", "ccard", "checking"])("sends a complete %s account with defaults", async (type) => {
    const { api, state, call } = await setup();
    const result = await call("add_account", { title: " Wallet ", type });
    expect(result.isError).toBeFalsy();
    const sent = vi.mocked(api.diff).mock.calls[0][0].account![0];
    expect(sent).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/), changed: expect.any(Number), user: 1,
      role: null, title: "Wallet", type, instrument: 1, company: null, syncID: null,
      balance: 0, startBalance: 0, creditLimit: 0, inBalance: true, savings: false,
      enableCorrection: false, enableSMS: false, archive: false, private: false,
      capitalization: null, percent: null, startDate: null, endDateOffset: null,
      endDateOffsetInterval: null, payoffStep: null, payoffInterval: null,
    });
    expect(sent.changed).toBeCloseTo(Date.now() / 1000, -1);
    expect(state.accounts.find((a) => a.id === sent.id)).toEqual(sent);
    expect(getTextContent(result)).toContain("Wallet");
    expect(getTextContent(result)).toContain(sent.id);
  });

  it("sends explicit card options and a case-insensitive currency code", async () => {
    const { api, call } = await setup();
    const result = await call("add_account", { title: "Card", type: "ccard", currency: " eur ", balance: -12.5, credit_limit: 1000, in_balance: false, savings: true });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[0][0].account![0]).toMatchObject({
      instrument: 2, balance: -12.5, startBalance: -12.5, creditLimit: 1000, inBalance: false, savings: true,
    });
  });

  it("does not treat zerro's hidden title as an ordinary duplicate", async () => {
    const { call } = await setup({ account: [{ ...CHECKING, title: ZERRO_DATA_ACCOUNT }] });
    expect((await call("add_account", { title: "Checking", type: "cash" })).isError).toBeFalsy();
  });

  it.each([
    [{ title: "cHeCkInG", type: "cash" }, {}, "already exists"],
    [{ title: "Old Account", type: "cash" }, {}, "already exists"],
    [{ title: ZERRO_DATA_ACCOUNT, type: "cash" }, {}, "reserved"],
    [{ title: "New", type: "cash", credit_limit: 0 }, {}, "ccard"],
    [{ title: "New", type: "checking", credit_limit: 10 }, {}, "ccard"],
    [{ title: "New", type: "cash", currency: "ZZZ" }, {}, "not found"],
    [{ title: "New", type: "cash", currency: "Dollar" }, {}, "not found"],
    [{ title: "New", type: "cash", currency: "USD" }, { instrument: [USD, { ...USD, id: 9 }] }, "ambiguous"],
    [{ title: "New", type: "cash" }, { user: [] }, "User not found"],
    [{ title: "New", type: "cash" }, { user: [{ ...USER, currency: 99 }] }, "not found"],
  ] as const)("refuses %o", async (args, overrides, message) => {
    const { api, call } = await setup(overrides as Partial<DiffResponse>);
    const result = await call("add_account", args);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it.each([
    [{ account: [{ ...CHECKING, title: "New" }] }, "already exists"],
    [{ user: [{ ...USER, currency: 2 }] }, "currency"],
  ])("rechecks creation in the queue", async (response, message) => {
    const ctx = await setup();
    const result = await queued(ctx, "add_account", { title: "New", type: "cash", balance: 10 }, response);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(ctx.api.diff).toHaveBeenCalledTimes(1);
  });
});

describe("update_account", () => {
  it("sends the complete account and preserves balances, currency and type", async () => {
    const { api, state, call } = await setup();
    const result = await call("update_account", { account: EURO_CARD.id, title: "New Card", archive: true, in_balance: false, savings: true, credit_limit: 500 });
    expect(result.isError).toBeFalsy();
    const sent = vi.mocked(api.diff).mock.calls[0][0].account![0];
    expect(sent).toEqual({ ...EURO_CARD, changed: expect.any(Number), title: "New Card", archive: true, inBalance: false, savings: true, creditLimit: 500 });
    expect(sent.changed).toBeCloseTo(Date.now() / 1000, -1);
    expect(state.accounts.find((a) => a.id === EURO_CARD.id)).toEqual(sent);
  });

  it("accepts zero credit limit", async () => {
    const { api, call } = await setup();
    expect((await call("update_account", { account: "Euro Card", credit_limit: 0 })).isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[0][0].account![0].creditLimit).toBe(0);
  });

  it("allows debt metadata edits and unarchiving", async () => {
    const { api, call } = await setup({ account: [{ ...DEBT_ACCOUNT, archive: true }] });
    expect((await call("update_account", { account: DEBT_ACCOUNT.id, title: "IOUs", archive: false })).isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[0][0].account![0]).toMatchObject({ type: "debt", title: "IOUs", archive: false });
  });

  it.each([
    [{ account: "missing", title: "New" }, {}, "not found"],
    [{ account: "Checking", title: "New" }, { account: [CHECKING, { ...CHECKING, id: "other" }] }, "ambiguous"],
    [{ account: "Checking" }, {}, "Nothing to update"],
    [{ account: "Checking", title: "EURO CARD" }, {}, "already exists"],
    [{ account: "Checking", title: "Old Account" }, {}, "already exists"],
    [{ account: "Checking", title: ZERRO_DATA_ACCOUNT }, {}, "reserved"],
    [{ account: "Checking", credit_limit: 0 }, {}, "ccard"],
    [{ account: DEBT_ACCOUNT.id, archive: true }, { account: [DEBT_ACCOUNT] }, "Debt"],
    [{ account: "acc-zerro", title: "New" }, { account: [{ ...CHECKING, id: "acc-zerro", title: ZERRO_DATA_ACCOUNT }] }, "not found"],
  ] as const)("refuses %o", async (args, overrides, message) => {
    const { api, call } = await setup(overrides as Partial<DiffResponse>);
    const result = await call("update_account", args);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("does not write unchanged values", async () => {
    const { api, call } = await setup();
    const result = await call("update_account", { account: CHECKING.id, title: "Checking", archive: false, in_balance: true, savings: false });
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("No changes");
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("ignores unsupported balance, type and currency inputs", async () => {
    const { api, call } = await setup();
    expect((await call("update_account", { account: CHECKING.id, title: "New", balance: 1, type: "debt", currency: "EUR" })).isError).toBeFalsy();
    expect(vi.mocked(api.diff).mock.calls[0][0].account![0]).toMatchObject({ balance: 5000, startBalance: 0, type: "checking", instrument: 1 });
  });

  it("takes the latest snapshot including fields unknown to the local type", async () => {
    const ctx = await setup();
    const result = await queued(ctx, "update_account", { account: CHECKING.id, title: "New" }, {
      account: [{ ...CHECKING, balance: 123, instrument: 2, savings: true, role: 2 } as typeof CHECKING],
    });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(ctx.api.diff).mock.calls[1][0].account![0]).toMatchObject({ title: "New", balance: 123, instrument: 2, savings: true, role: 2 });
  });

  it.each([
    [{ account: CHECKING.id, title: "New" }, { deletion: [{ object: "account", id: CHECKING.id }] }, "not found"],
    [{ account: CHECKING.id, title: "New" }, { account: [{ ...EURO_CARD, title: "New" }] }, "already exists"],
    [{ account: CHECKING.id, archive: true }, { account: [{ ...CHECKING, type: "debt" }] }, "Debt"],
    [{ account: EURO_CARD.id, credit_limit: 10 }, { account: [{ ...EURO_CARD, type: "checking" }] }, "ccard"],
    [{ account: CHECKING.id, archive: true }, { account: [{ ...CHECKING, title: ZERRO_DATA_ACCOUNT }] }, "not found"],
  ])("rechecks %o in the queue", async (args, response, message) => {
    const ctx = await setup();
    const result = await queued(ctx, "update_account", args, response);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(ctx.api.diff).toHaveBeenCalledTimes(1);
  });

  it("skips an edit already applied by an earlier exchange", async () => {
    const ctx = await setup();
    const result = await queued(ctx, "update_account", { account: CHECKING.id, title: "New" }, { account: [{ ...CHECKING, title: "New" }] });
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).toContain("No changes");
    expect(ctx.api.diff).toHaveBeenCalledTimes(1);
  });

  it("does not retarget a name reused after deletion", async () => {
    const ctx = await setup();
    const result = await queued(ctx, "update_account", { account: "Checking", title: "New" }, {
      deletion: [{ object: "account", id: CHECKING.id }], account: [{ ...CHECKING, id: "replacement" }],
    });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("not found");
    expect(ctx.api.diff).toHaveBeenCalledTimes(1);
  });

  it("rechecks an initially unchanged value after waiting in the queue", async () => {
    const ctx = await setup();
    const result = await queued(ctx, "update_account", { account: CHECKING.id, title: "Checking" }, { account: [{ ...CHECKING, title: "Wallet" }] });
    expect(result.isError).toBeFalsy();
    expect(vi.mocked(ctx.api.diff).mock.calls[1][0].account![0].title).toBe("Checking");
  });
});

describe("catalog schemas and annotations", () => {
  it.each([
    ["add_category", {}], ["add_category", { title: "   " }],
    ["add_category", { title: "New", color: 1.5 }],
    ["update_category", { category: FOOD.id, title: " " }],
    ["update_category", { category: FOOD.id, color: 1.5 }],
    ["add_account", { title: " ", type: "cash" }],
    ["add_account", { type: "cash" }], ["add_account", { title: "New" }],
    ...["deposit", "loan", "debt", "emoney", "saving"].map((type) => ["add_account", { title: "New", type }]),
    ["add_account", { title: "New", type: "ccard", credit_limit: -1 }],
    ["update_account", { account: EURO_CARD.id, credit_limit: -1 }],
    ["update_account", { account: CHECKING.id, title: " " }],
  ] as [string, Record<string, unknown>][])("rejects invalid input for %s: %o", async (name, args) => {
    const { api, call } = await setup();
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("Invalid arguments");
    expect(api.diff).not.toHaveBeenCalled();
  });

  it("annotates all four tools", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    for (const name of ["add_category", "update_category", "add_account", "update_account"]) {
      const update = name.startsWith("update_");
      expect(tools.find((t) => t.name === name)?.annotations).toMatchObject({
        readOnlyHint: false, destructiveHint: update, idempotentHint: update, openWorldHint: true,
      });
    }
  });
});

describe("catalog confirmations and uncertain writes", () => {
  it.each([
    ["add_category", { title: "New" }, "tag", "Category", "list_categories"],
    ["update_category", { category: FOOD.id, title: "New" }, "tag", "Category", "list_categories"],
    ["add_account", { title: "New", type: "cash" }, "account", "Account", "list_accounts"],
    ["update_account", { account: CHECKING.id, title: "New" }, "account", "Account", "list_accounts"],
  ] as const)("shows what the server kept for %s", async (name, args, field, label, list) => {
    const { api, state, call } = await setup();
    vi.mocked(api.diff).mockImplementationOnce(async (req) => empty({
      [field]: [{ ...req[field]![0], title: "Server title", changed: 9999999999 }],
    }));
    const result = await call(name, args);
    expect(result.isError).toBeFalsy();
    const text = getTextContent(result);
    expect(text).toContain(label);
    expect(text).toContain("Server title");
    expect(text).toContain("Warning: the server kept a different version");
    const id = vi.mocked(api.diff).mock.calls[0][0][field]![0].id;
    expect((field === "tag" ? state.tags : state.accounts).find((e) => e.id === id)?.title).toBe("Server title");

    vi.mocked(api.diff).mockRejectedValueOnce(new ZenMoneyError("timeout", true));
    const uncertain = await call(name, { ...args, title: "Another" });
    expect(uncertain.isError).toBe(true);
    expect(getTextContent(uncertain)).toContain("may or may not have been saved");
    expect(getTextContent(uncertain)).toContain("sync_data");
    expect(getTextContent(uncertain)).toContain(list);
    expect(getTextContent(uncertain)).not.toContain("list_transactions");
    const uncertainId = vi.mocked(api.diff).mock.calls[1][0][field]![0].id;
    expect(getTextContent(uncertain)).toContain(uncertainId);
    expect((field === "tag" ? state.tags : state.accounts).some((e) => e.title === "Another")).toBe(false);
  });

  it.each([
    ["add_category", { title: "New" }, "tag"],
    ["update_category", { category: FOOD.id, title: "New" }, "tag"],
    ["add_account", { title: "New", type: "cash" }, "account"],
    ["update_account", { account: CHECKING.id, title: "New" }, "account"],
  ] as const)("reports a server deletion for %s", async (name, args, field) => {
    const { api, call } = await setup();
    vi.mocked(api.diff).mockImplementationOnce(async (req) => empty({ deletion: [{ object: field, id: req[field]![0].id }] }));
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("deleted");
    expect(getTextContent(result)).not.toContain("created:");
    expect(getTextContent(result)).not.toContain("updated:");
  });

  it.each([
    ["add_category", { title: "New" }, "tag"],
    ["update_category", { category: FOOD.id, title: "New" }, "tag"],
    ["add_account", { title: "New", type: "cash" }, "account"],
    ["update_account", { account: CHECKING.id, title: "New" }, "account"],
  ] as const)("ignores a server timestamp change in %s confirmation", async (name, args, field) => {
    const { api, call } = await setup();
    vi.mocked(api.diff).mockImplementationOnce(async (req) => empty({ [field]: [{ ...req[field]![0], changed: 9999999999 }] }));
    const result = await call(name, args);
    expect(result.isError).toBeFalsy();
    expect(getTextContent(result)).not.toContain("Warning");
  });
});
