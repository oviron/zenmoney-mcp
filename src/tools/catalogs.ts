import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Account, Tag } from "../api.js";
import { ZERRO_DATA_ACCOUNT, type ZenState } from "../state.js";
import { checkStillValid, resolveAccountStrict, resolveTagStrict } from "../lib/resolve.js";
import { toolError, toolText } from "../lib/result.js";

const title = z.string().trim().min(1).describe("Non-empty title");
const categoryFields = {
  title: title.optional(),
  parent: z.string().nullable().optional().describe("Top-level category name or UUID; null makes this a top-level category"),
  show_income: z.boolean().optional(),
  show_outcome: z.boolean().optional(),
  budget_income: z.boolean().optional(),
  budget_outcome: z.boolean().optional(),
  color: z.number().int().nullable().optional().describe("ARGB color as an integer; null clears it"),
};
const accountFields = {
  title: title.optional(),
  archive: z.boolean().optional(),
  in_balance: z.boolean().optional(),
  savings: z.boolean().optional(),
  credit_limit: z.number().nonnegative().optional().describe("Credit limit; only for ccard accounts"),
};

export function registerCatalogTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "add_category",
    {
      title: "Add Category",
      description: "Create a category, optionally under a top-level parent. Titles must be unique within the same parent, ignoring case. Icons and pictures are unset. A new expense or income category counts in the budget on that side unless budget_outcome / budget_income says otherwise.",
      inputSchema: {
        ...categoryFields,
        title,
        parent: z.string().optional().describe("Top-level category name or UUID"),
        show_income: z.boolean().optional().default(true),
        show_outcome: z.boolean().optional().default(true),
        budget_income: z.boolean().optional().describe("Count in the income budget; defaults to show_income"),
        budget_outcome: z.boolean().optional().describe("Count in the expense budget; defaults to show_outcome"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, parent, show_income, show_outcome, budget_income, budget_outcome, color }) => {
      let parentId: string | null = null;
      if (parent !== undefined) {
        const match = resolveTagStrict(state, parent);
        if ("error" in match) return toolError(match.error);
        parentId = match.tag.id;
      }
      let next!: Tag;
      const id = randomUUID();
      try {
        await state.write(() => {
          const user = state.getUser();
          if (!user) throw new Error("User not found. Run sync_data first.");
          checkParent(state, parentId);
          checkCategoryTitle(state, title, parentId);
          next = {
            id, changed: Math.floor(Date.now() / 1000), user: user.id,
            title, parent: parentId, icon: null, picture: null, color: color ?? null,
            showIncome: show_income, showOutcome: show_outcome,
            budgetIncome: budget_income ?? show_income, budgetOutcome: budget_outcome ?? show_outcome, required: false,
          };
          return { tag: [next] };
        }, () => state.upsertTag(next));
        return catalogConfirmation(state, "Category", "created", next, state.tags.find((t) => t.id === id));
      } catch (error) {
        return toolError(`Failed to add category: ${errorMessage(error)}`);
      }
    }
  );

  server.registerTool(
    "update_category",
    {
      title: "Update Category",
      description: "Change a category's title, parent, visibility, budget flags or color. Use a category name or UUID. A parent must be top-level, and a category with children cannot become a child. Pass parent: null to make a category top-level.",
      inputSchema: { category: z.string().describe("Category name or UUID"), ...categoryFields },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ category, title, parent, show_income, show_outcome, budget_income, budget_outcome, color }) => {
      const match = resolveTagStrict(state, category);
      if ("error" in match) return toolError(match.error);
      let parentId: string | null | undefined = parent === null ? null : undefined;
      if (typeof parent === "string") {
        const resolved = resolveTagStrict(state, parent);
        if ("error" in resolved) return toolError(resolved.error);
        parentId = resolved.tag.id;
      }
      const patch = defined({ title, parent: parentId, showIncome: show_income, showOutcome: show_outcome,
        budgetIncome: budget_income, budgetOutcome: budget_outcome, color });
      if (Object.keys(patch).length === 0) return toolError("Nothing to update. Pass at least one category field.");
      let next!: Tag;
      try {
        await state.write(() => {
          const current = state.tags.find((t) => t.id === match.tag.id);
          if (!current) throw new Error(`Category ${match.tag.id} not found; it was deleted in ZenMoney meanwhile. Nothing was saved.`);
          next = { ...current, ...patch };
          if (parentId !== undefined) {
            if (parentId === current.id) throw new Error("A category cannot be its own parent.");
            checkParent(state, parentId);
            if (parentId !== null && state.tags.some((t) => t.parent === current.id)) {
              throw new Error("A category with children cannot become a child category.");
            }
          }
          if (title !== undefined || parentId !== undefined) checkCategoryTitle(state, next.title, next.parent, current.id);
          if (unchanged(current, patch)) throw new NoChanges();
          next.changed = Math.floor(Date.now() / 1000);
          return { tag: [next] };
        }, () => state.upsertTag(next));
        return catalogConfirmation(state, "Category", "updated", next, state.tags.find((t) => t.id === next.id));
      } catch (error) {
        if (error instanceof NoChanges) return toolText("No changes: the category already has these values.");
        return toolError(`Failed to update category: ${errorMessage(error)}`);
      }
    }
  );

  server.registerTool(
    "add_account",
    {
      title: "Add Account",
      description: "Create a simple cash, ccard or checking account without a bank connection. Currency is an exact code such as USD (case-insensitive), defaulting to the user's currency. balance sets both the initial balance and startBalance. Does not create deposits, loans or debt accounts.",
      inputSchema: {
        title,
        type: z.enum(["cash", "ccard", "checking"]),
        currency: z.string().optional().describe("Exact instrument shortTitle, e.g. USD; defaults to the user's currency"),
        balance: z.number().optional().default(0).describe("Initial balance in the selected currency"),
        credit_limit: accountFields.credit_limit,
        in_balance: z.boolean().optional().default(true),
        savings: z.boolean().optional().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ title, type, currency, balance, credit_limit, in_balance, savings }) => {
      const id = randomUUID();
      let next!: Account;
      try {
        const instrument = accountCurrency(state, currency);
        await state.write(() => {
          const user = state.getUser();
          if (!user) throw new Error("User not found. Run sync_data first.");
          checkAccountTitle(state, title);
          if (credit_limit !== undefined && type !== "ccard") throw new Error("credit_limit is only available for ccard accounts.");
          if (accountCurrency(state, currency) !== instrument) {
            throw new Error("The account currency changed in ZenMoney meanwhile. Nothing was saved; check the balance and try again.");
          }
          const account = {
            id, changed: Math.floor(Date.now() / 1000), user: user.id, role: null,
            title, type, instrument, company: null, syncID: null,
            balance, startBalance: balance, creditLimit: credit_limit ?? 0,
            inBalance: in_balance, savings, enableCorrection: false, enableSMS: false, archive: false, private: false,
            capitalization: null, percent: null, startDate: null, endDateOffset: null,
            endDateOffsetInterval: null, payoffStep: null, payoffInterval: null,
          };
          next = account;
          return { account: [account] };
        }, () => state.upsertAccount(next));
        return catalogConfirmation(state, "Account", "created", next, state.accounts.find((a) => a.id === id));
      } catch (error) {
        return toolError(`Failed to add account: ${errorMessage(error)}`);
      }
    }
  );

  server.registerTool(
    "update_account",
    {
      title: "Update Account",
      description: "Change an account's title, archive status, inclusion in the total balance, savings flag or credit limit (ccard only). Debt accounts cannot be archived. Type, currency and balance cannot be changed here; adjust a balance with a correction transaction.",
      inputSchema: { account: z.string().describe("Account name or UUID"), ...accountFields },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ account, title, archive, in_balance, savings, credit_limit }) => {
      const match = resolveAccountStrict(state, account);
      if ("error" in match) return toolError(match.error);
      const patch = defined({ title, archive, inBalance: in_balance, savings, creditLimit: credit_limit });
      if (Object.keys(patch).length === 0) return toolError("Nothing to update. Pass at least one account field.");
      let next!: Account;
      try {
        await state.write(() => {
          const current = state.getVisibleAccounts().find((a) => a.id === match.account.id);
          if (!current) throw new Error(`Account ${match.account.id} not found; it was deleted or hidden in ZenMoney meanwhile. Nothing was saved.`);
          if (archive === true && current.type === "debt") throw new Error("Debt accounts cannot be archived.");
          if (credit_limit !== undefined && current.type !== "ccard") throw new Error("credit_limit is only available for ccard accounts.");
          if (title !== undefined) checkAccountTitle(state, title, current.id);
          if (unchanged(current, patch)) throw new NoChanges();
          next = { ...current, ...patch, changed: Math.floor(Date.now() / 1000) };
          return { account: [next] };
        }, () => state.upsertAccount(next));
        return catalogConfirmation(state, "Account", "updated", next, state.accounts.find((a) => a.id === next.id));
      } catch (error) {
        if (error instanceof NoChanges) return toolText("No changes: the account already has these values.");
        return toolError(`Failed to update account: ${errorMessage(error)}`);
      }
    }
  );
}

function checkParent(state: ZenState, id: string | null): void {
  if (id === null) return;
  checkStillValid(state, [], [id]);
  if (state.tags.find((t) => t.id === id)!.parent) {
    throw new Error("The parent must be a top-level category; ZenMoney supports only two levels.");
  }
}

function checkCategoryTitle(state: ZenState, title: string, parent: string | null, except?: string): void {
  if (state.tags.some((t) => t.id !== except && (t.parent ?? null) === parent && t.title.toLowerCase() === title.toLowerCase())) {
    throw new Error(`Category "${title}" already exists under this parent. Use a different title.`);
  }
}

function checkAccountTitle(state: ZenState, title: string, except?: string): void {
  if (title === ZERRO_DATA_ACCOUNT) throw new Error("This account title is reserved for zerro's service data.");
  if (state.getVisibleAccounts().some((a) => a.id !== except && a.title.toLowerCase() === title.toLowerCase())) {
    throw new Error(`Account "${title}" already exists. Use a different title.`);
  }
}

function accountCurrency(state: ZenState, code: string | undefined): number {
  const user = state.getUser();
  if (!user) throw new Error("User not found. Run sync_data first.");
  const matches = code === undefined
    ? state.instruments.filter((i) => i.id === user.currency)
    : state.instruments.filter((i) => i.shortTitle.toLowerCase() === code.trim().toLowerCase());
  if (matches.length === 0) throw new Error(`Currency "${code ?? user.currency}" not found. Use an exact shortTitle such as USD.`);
  if (matches.length > 1) throw new Error(`Currency code "${code}" is ambiguous: ${matches.map((i) => `${i.shortTitle} (${i.id})`).join(", ")}.`);
  return matches[0].id;
}

function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function unchanged<T extends object>(current: T, patch: Partial<T>): boolean {
  return Object.entries(patch).every(([key, value]) => current[key as keyof T] === value);
}

class NoChanges extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function catalogConfirmation(
  state: ZenState,
  label: string,
  action: string,
  sent: Tag | Account,
  held: Tag | Account | undefined
) {
  if (!held) return toolError(`Warning: the server's response deleted this ${label.toLowerCase()} (${sent.id}). Run sync_data to check it.`);
  const details = "parent" in held
    ? [
      `Parent: ${held.parent === null ? "none" : `${state.tags.find((t) => t.id === held.parent)?.title ?? "unknown"} (${held.parent})`}`,
      `Show income: ${held.showIncome}; show outcome: ${held.showOutcome}`,
      `Budget income: ${held.budgetIncome}; budget outcome: ${held.budgetOutcome}`,
      `Color: ${held.color ?? "none"}`,
    ]
    : [
      `Type: ${held.type}`,
      `Balance: ${held.balance ?? "unknown"} ${state.getInstrument(held.instrument ?? state.getUser()?.currency ?? 1)?.shortTitle ?? "unknown"}`,
      `Credit limit: ${held.creditLimit ?? "none"}`,
      `Archived: ${held.archive}; in balance: ${held.inBalance}; savings: ${held.savings ?? "unknown"}`,
    ];
  const differences = Object.entries(sent).filter(([key, value]) =>
    key !== "changed" && JSON.stringify(value) !== JSON.stringify(held[key as keyof typeof held])
  ).map(([key, value]) => `${key}: ${JSON.stringify(value)} → ${JSON.stringify(held[key as keyof typeof held])}`);
  const warning = differences.length ? `\n\nWarning: the server kept a different version (${differences.join("; ")}).` : "";
  return toolText(`${label} ${action}:\n\n- **${held.title}** — id: \`${held.id}\`\n${details.map((line) => `- ${line}`).join("\n")}${warning}`);
}
