import { afterEach, describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiffResponse } from "../src/api.js";
import { CHECKING, FOOD, RESTAURANTS, SALARY, makeTransaction } from "./fixtures.js";
import { connectPair, createMcpPair, createSyncedState, getTextContent } from "./helpers.js";

let client: Client;
let server: McpServer;
const range = { start_date: "2026-03-01", end_date: "2026-03-31" };

async function setup(overrides: Partial<DiffResponse> = {}) {
  const { api, state } = await createSyncedState(overrides);
  const pair = await createMcpPair(api, state);
  client = pair.client;
  server = pair.server;
  await connectPair(pair);
}

afterEach(async () => {
  await client?.close();
  await server?.close();
});

async function list(args: Record<string, unknown> = {}) {
  return client.callTool({ name: "list_transactions", arguments: { ...range, ...args } });
}

function ids(text: string) {
  return [...text.matchAll(/\| id: ([^\n]+)/g)].map((match) => match[1]);
}

describe("list_transactions filters", () => {
  it("includes every descendant by default and can restrict the category to itself", async () => {
    await setup({
      tag: [FOOD, RESTAURANTS, { ...FOOD, id: "tag-cafe", title: "Cafe", parent: RESTAURANTS.id }, SALARY],
      transaction: [
        makeTransaction({ id: "tx-parent", outcome: 10, tag: [FOOD.id] }),
        makeTransaction({ id: "tx-child", outcome: 10, tag: [RESTAURANTS.id] }),
        makeTransaction({ id: "tx-grandchild", outcome: 10, tag: ["tag-cafe"] }),
        makeTransaction({ id: "tx-unrelated", outcome: 10, tag: [SALARY.id] }),
      ],
    });

    expect(ids(getTextContent(await list({ category: "Food" })))).toEqual([
      "tx-child", "tx-grandchild", "tx-parent",
    ]);
    expect(ids(getTextContent(await list({ category: FOOD.id, include_subcategories: false })))).toEqual([
      "tx-parent",
    ]);
  });

  it("does not loop on a cycle in the category parents", async () => {
    await setup({
      tag: [{ ...FOOD, parent: RESTAURANTS.id }, RESTAURANTS],
      transaction: [makeTransaction({ id: "tx-child", outcome: 10, tag: [RESTAURANTS.id] })],
    });
    expect(ids(getTextContent(await list({ category: FOOD.id })))).toEqual(["tx-child"]);
  });

  it.each([
    [{ payee: "The ALPHA Shop" }, "alpha"],
    [{ comment: "Invoice ALPHA-123" }, "aLpHa"],
    [{ payee: "Different payee", merchant: "merchant-cafe" }, "CORNER caFE"],
  ])("searches payee, comment and merchant case-insensitively: %j", async (fields, query) => {
    await setup({
      transaction: [
        makeTransaction({ id: "tx-match", outcome: 10, ...fields }),
        makeTransaction({ id: "tx-unrelated", outcome: 10, merchant: "merchant-missing" }),
      ],
    });
    expect(ids(getTextContent(await list({ query })))).toEqual(["tx-match"]);
    expect(ids(getTextContent(await list({ query: "" })))).toHaveLength(2);
  });

  it.each(["expense", "income", "transfer"])("filters by the displayed %s type", async (type) => {
    await setup({
      transaction: [
        makeTransaction({ id: "tx-expense", outcome: 10 }),
        makeTransaction({ id: "tx-income", income: 10 }),
        makeTransaction({ id: "tx-transfer", outcome: 10, incomeAccount: "acc-euro" }),
        makeTransaction({ id: "tx-other", outcome: 10, income: 5 }),
        makeTransaction({ id: "tx-zero" }),
      ],
    });
    const text = getTextContent(await list({ type }));
    expect(ids(text)).toEqual([`tx-${type}`]);
    expect(text).toContain(`| ${type.padEnd(8)} |`);
  });

  it("uses inclusive account-currency amount bounds rather than purchase amounts", async () => {
    await setup({
      transaction: [
        makeTransaction({ id: "tx-below", outcome: 24 }),
        makeTransaction({ id: "tx-min", outcome: 25, opOutcome: 2000, opOutcomeInstrument: 3 }),
        makeTransaction({ id: "tx-income", income: 40 }),
        makeTransaction({ id: "tx-max", outcome: 50 }),
        makeTransaction({ id: "tx-above", income: 51 }),
      ],
    });
    expect(ids(getTextContent(await list({ min_amount: 25, max_amount: 50 })))).toEqual([
      "tx-income", "tx-max", "tx-min",
    ]);
    expect(ids(getTextContent(await list({ min_amount: 51 })))).toEqual(["tx-above"]);
    expect(ids(getTextContent(await list({ max_amount: 24 })))).toEqual(["tx-below"]);
  });

  it("uses the outgoing transfer amount, or the incoming amount for its destination account", async () => {
    await setup({
      transaction: [makeTransaction({
        id: "tx-transfer", outcome: 100, income: 90,
        incomeAccount: "acc-euro", incomeInstrument: 2,
      })],
    });
    expect(ids(getTextContent(await list({ min_amount: 100, max_amount: 100 })))).toEqual(["tx-transfer"]);
    expect(ids(getTextContent(await list({ account: "Checking", max_amount: 90 })))).toEqual([]);
    expect(ids(getTextContent(await list({ account: "Euro Card", min_amount: 90, max_amount: 90 })))).toEqual([
      "tx-transfer",
    ]);
  });

  it("uses the larger absolute side for operations with both sides on the same account", async () => {
    await setup({ transaction: [makeTransaction({ id: "tx-other", outcome: -30, income: 20 })] });
    expect(ids(getTextContent(await list({ min_amount: 30, max_amount: 30 })))).toEqual(["tx-other"]);
    expect(ids(getTextContent(await list({ max_amount: 29 })))).toEqual([]);
  });

  it("only selects uncategorized non-transfers, with null or empty tags", async () => {
    await setup({
      transaction: [
        makeTransaction({ id: "tx-null", outcome: 10, tag: null }),
        makeTransaction({ id: "tx-empty", income: 10, tag: [] }),
        makeTransaction({ id: "tx-tagged", outcome: 10, tag: [FOOD.id] }),
        makeTransaction({ id: "tx-transfer", outcome: 10, income: 10, incomeAccount: "acc-savings" }),
      ],
    });
    expect(ids(getTextContent(await list({ uncategorized: true })))).toEqual(["tx-empty", "tx-null"]);
    expect(ids(getTextContent(await list({ uncategorized: false })))).toHaveLength(4);
    expect(ids(getTextContent(await list({ category: FOOD.id, uncategorized: true })))).toEqual([]);
  });

  it("filters holds in both directions and treats null as not held", async () => {
    await setup({
      transaction: [
        makeTransaction({ id: "tx-held", outcome: 10, hold: true }),
        makeTransaction({ id: "tx-settled", outcome: 10, hold: false }),
        makeTransaction({ id: "tx-null", outcome: 10, hold: null }),
      ],
    });
    expect(ids(getTextContent(await list({ hold: true })))).toEqual(["tx-held"]);
    expect(ids(getTextContent(await list({ hold: false })))).toEqual(["tx-null", "tx-settled"]);
    expect(ids(getTextContent(await list()))).toHaveLength(3);
  });

  it("combines filters with AND before pagination", async () => {
    const match = makeTransaction({
      id: "tx-match", outcome: 25, tag: [RESTAURANTS.id], payee: "Cafe", hold: true,
    });
    await setup({
      transaction: [
        match,
        { ...match, id: "tx-account", incomeAccount: "acc-savings", outcomeAccount: "acc-savings" },
        { ...match, id: "tx-category", tag: [SALARY.id] },
        { ...match, id: "tx-query", payee: "Shop" },
        { ...match, id: "tx-type", outcome: 0, income: 25 },
        { ...match, id: "tx-low", outcome: 24 },
        { ...match, id: "tx-high", outcome: 26 },
        { ...match, id: "tx-hold", hold: false },
        { ...match, id: "tx-date", date: "2025-01-01" },
      ],
    });
    expect(ids(getTextContent(await list({
      account: "Checking", category: "Food", query: "CAFE", type: "expense",
      min_amount: 25, max_amount: 25, hold: true, uncategorized: false, limit: 1,
    })))).toEqual(["tx-match"]);
  });

  it.each([
    { offset: -1 }, { offset: 1.5 }, { min_amount: -1 }, { max_amount: -1 },
    { min_amount: 20, max_amount: 10 }, { type: "other" },
    { include_subcategories: "true" }, { hold: "false" }, { uncategorized: "true" },
  ])("rejects invalid filter input %j", async (args) => {
    await setup();
    expect((await list(args)).isError).toBe(true);
  });
});

describe("list_transactions pagination", () => {
  it("applies offset after sorting and filtering and reports the next page", async () => {
    await setup({
      transaction: [
        makeTransaction({ id: "tx-last", outcome: 10, date: "2026-03-19" }),
        makeTransaction({ id: "tx-second", outcome: 10, created: 2000 }),
        makeTransaction({ id: "tx-first", outcome: 10, created: 3000 }),
        makeTransaction({ id: "tx-excluded", income: 10, created: 4000 }),
      ],
    });
    const first = getTextContent(await list({ type: "expense", limit: 2 }));
    expect(ids(first)).toEqual(["tx-first", "tx-second"]);
    expect(first).toContain("Transactions (2 of 3, offset: 0, next offset: 2)");

    const last = getTextContent(await list({ type: "expense", limit: 2, offset: 2 }));
    expect(ids(last)).toEqual(["tx-last"]);
    expect(last).toContain("Transactions (1 of 3, offset: 2)");
    expect(last).not.toContain("next offset");

    const pastEnd = getTextContent(await list({ type: "expense", offset: 10 }));
    expect(ids(pastEnd)).toEqual([]);
    expect(pastEnd).toContain("Transactions (0 of 3, offset: 10)");
    expect(pastEnd).not.toContain("next offset");
  });

  it.each([false, true])("limits the complete text to 50,000 characters, with provenance=%s", async (show_provenance) => {
    const comment = "complete comment ".repeat(100);
    await setup({
      transaction: Array.from({ length: 80 }, (_, i) => makeTransaction({
        id: `tx-${String(i).padStart(3, "0")}`, outcome: 10, comment,
        outcomeBankID: `bank-${i}`,
      })),
    });
    const seen: string[] = [];
    let offset = 5;
    do {
      const result = await list({ limit: 1000, offset, show_provenance });
      const text = getTextContent(result);
      const pageIds = ids(text);
      expect(result.isError).toBeFalsy();
      expect(text.length).toBeLessThanOrEqual(50_000);
      expect(pageIds.length).toBeGreaterThan(0);
      for (const line of text.split("\n").filter((line) => line.includes("| id:"))) {
        expect(line).toContain(`— "${comment}"`);
      }
      expect(text.match(/    created:/g)?.length ?? 0).toBe(show_provenance ? pageIds.length : 0);
      seen.push(...pageIds);
      offset += pageIds.length;
      if (offset < 80) {
        expect(text).toContain(`Transactions (${pageIds.length} of 80`);
        expect(text).toContain(`next offset: ${offset}`);
      } else {
        expect(text).not.toContain("next offset");
      }
    } while (offset < 80);
    expect(seen).toEqual(Array.from({ length: 75 }, (_, i) => `tx-${String(i + 5).padStart(3, "0")}`));
  });

  it("reports a single oversized transaction with an offset that lets the caller skip it", async () => {
    await setup({
      transaction: [
        makeTransaction({ id: "tx-huge", outcome: 10, comment: "x".repeat(60_000) }),
        makeTransaction({ id: "tx-next", outcome: 10 }),
      ],
    });
    const result = await list();
    const text = getTextContent(result);
    expect(result.isError).toBe(true);
    expect(text.length).toBeLessThanOrEqual(50_000);
    expect(text).toContain("tx-huge");
    expect(text).toContain("offset: 1");
    expect(ids(getTextContent(await list({ offset: 1 })))).toEqual(["tx-next"]);
  });
});

describe("fuller output", () => {
  it("shows currency for a same-currency transfer", async () => {
    await setup({ transaction: [makeTransaction({
      id: "tx-transfer", outcome: 10, income: 10, incomeAccount: "acc-savings",
    })] });
    expect(getTextContent(await list())).toContain("10 USD (Checking → Savings)");
  });

  it.each([
    [{ outcome: 950, outcomeInstrument: 3, opOutcome: 10, opOutcomeInstrument: 1 }, "-10 USD (-950 RUB)"],
    [{ income: 2000, incomeInstrument: 3, opIncome: 20, opIncomeInstrument: 2 }, "+20 EUR (+2000 RUB)"],
    [{ outcome: 15, opOutcome: 10, opOutcomeInstrument: 1 }, "-10 USD (-15 USD)"],
    [{ outcome: 10, opOutcome: 0, opOutcomeInstrument: 2 }, "-0 EUR (-10 USD)"],
  ])("shows the original amount and the account amount: %j", async (fields, expected) => {
    await setup({ transaction: [makeTransaction({ id: "tx-original", ...fields })] });
    expect(getTextContent(await list())).toContain(expected);
  });

  it("shows original amounts for both sides of transfers", async () => {
    await setup({ transaction: [makeTransaction({
      id: "tx-transfer", outcome: 12, income: 11, incomeAccount: "acc-euro", incomeInstrument: 2,
      opOutcome: 1000, opOutcomeInstrument: 3, opIncome: 1000, opIncomeInstrument: 3,
    })] });
    expect(getTextContent(await list())).toContain("1000 RUB (12 USD) → 1000 RUB (11 EUR)");
  });

  it("keeps distinct original amounts on an otherwise equal same-currency transfer", async () => {
    await setup({ transaction: [makeTransaction({
      id: "tx-transfer", outcome: 12, income: 12, incomeAccount: "acc-savings",
      opOutcome: 10, opOutcomeInstrument: 2,
    })] });
    expect(getTextContent(await list())).toContain("10 EUR (12 USD) → 12 USD (Checking → Savings)");
  });

  it("keeps both transfer currencies when the instrument names are unavailable", async () => {
    await setup({ transaction: [makeTransaction({
      id: "tx-transfer", outcome: 10, income: 10, incomeAccount: "acc-savings",
      outcomeInstrument: 98, incomeInstrument: 99,
    })] });
    expect(getTextContent(await list())).toContain("10  → 10  (Checking → Savings)");
  });

  it.each([
    { opOutcome: 10 },
    { opOutcomeInstrument: 2 },
    { opOutcome: 10, opOutcomeInstrument: 1 },
  ])("does not add an incomplete or identical original amount: %j", async (fields) => {
    await setup({ transaction: [makeTransaction({ id: "tx-simple", outcome: 10, ...fields })] });
    const text = getTextContent(await list());
    expect(text).toContain("-10 USD");
    expect(text).not.toContain("(-10");
  });

  it.each([null, "", "   "])("uses merchant when payee is empty: %j", async (payee) => {
    await setup({ transaction: [makeTransaction({ id: "tx-merchant", outcome: 10, payee, merchant: "merchant-cafe" })] });
    expect(getTextContent(await list())).toContain("Corner Cafe");
  });

  it("keeps a nonempty payee ahead of merchant and tolerates a missing merchant", async () => {
    await setup({ transaction: [
      makeTransaction({ id: "tx-payee", outcome: 10, payee: "My Shop", merchant: "merchant-cafe" }),
      makeTransaction({ id: "tx-missing", outcome: 10, merchant: "unknown-merchant" }),
    ] });
    const text = getTextContent(await list());
    expect(text).toContain("My Shop");
    expect(text).not.toContain("Corner Cafe");
    expect(text).not.toContain("undefined");
  });

  it("shows both amounts on a single-account operation", async () => {
    await setup({ transaction: [makeTransaction({ id: "tx-other", outcome: 30, income: 20 })] });
    const text = getTextContent(await list());
    expect(text).toContain("| other    |");
    expect(text).toContain("-30 USD / +20 USD");
  });

  it("distinguishes an unknown balance from a zero balance", async () => {
    await setup({ account: [
      { ...CHECKING, balance: null },
      { ...CHECKING, id: "acc-zero", title: "Zero", balance: 0 },
    ] });
    const text = getTextContent(await client.callTool({ name: "list_accounts", arguments: {} }));
    expect(text).toContain("**Checking** [checking] — unknown USD");
    expect(text).toContain("**Zero** [checking] — 0 USD");
  });

  it("confirms the income category, payee and comment", async () => {
    await setup();
    const text = getTextContent(await client.callTool({
      name: "add_income", arguments: {
        account: "Checking", amount: 100, date: "2026-03-20",
        category: "Salary", payee: "Employer", comment: "March",
      },
    }));
    expect(text).toContain("- Category: Salary");
    expect(text).toContain("- Payee: Employer");
    expect(text).toContain("- Comment: March");
  });

  it("confirms uncategorized income without inventing payee or comment", async () => {
    await setup();
    const text = getTextContent(await client.callTool({
      name: "add_income", arguments: { account: "Checking", amount: 100, date: "2026-03-20" },
    }));
    expect(text).toContain("- Category: uncategorized");
    expect(text).not.toContain("- Payee:");
    expect(text).not.toContain("- Comment:");
  });

  it("preserves orphan categories and their descendants", async () => {
    await setup({ tag: [
      FOOD,
      { ...RESTAURANTS, parent: "tag-missing" },
      { ...FOOD, id: "tag-child", title: "Child", parent: RESTAURANTS.id },
      { ...FOOD, id: "tag-grandchild", title: "Grandchild", parent: "tag-child" },
    ] });
    const text = getTextContent(await client.callTool({ name: "list_categories", arguments: {} }));
    expect(text).toContain("Categories (4)");
    expect(text).toContain("**Restaurants**");
    expect(text).toContain("parent not found: tag-missing");
    expect(text).toContain("\n  - Child — id: `tag-child`");
    expect(text).toContain("\n    - Grandchild — id: `tag-grandchild`");
  });

  it("lists each category once even when parent links form a cycle", async () => {
    await setup({ tag: [{ ...FOOD, parent: RESTAURANTS.id }, RESTAURANTS] });
    const text = getTextContent(await client.callTool({ name: "list_categories", arguments: {} }));
    expect(text.match(/id: `tag-food`/g)).toHaveLength(1);
    expect(text.match(/id: `tag-restaurants`/g)).toHaveLength(1);
  });
});
