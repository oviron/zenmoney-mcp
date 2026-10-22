import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOTAL_BUDGET_TAG, type Budget, type Instrument, type Tag } from "../api.js";
import type { ZenState } from "../state.js";
import { localDate } from "../lib/dates.js";
import { checkStillValid, resolveTagStrict } from "../lib/resolve.js";
import { toolError, toolText } from "../lib/result.js";

const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be in YYYY-MM format");

type Fact = { outcome: number; income: number };

export function registerBudgetTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "get_budget",
    {
      title: "Get Budget",
      description: "Show a month's budget against what was actually spent and received, in your main currency at current rates. A category's fact includes its subcategories; transfers, debts and accounts outside the balance are left out. Answers \"How much is left for food this month?\"",
      inputSchema: {
        month: month.optional().describe("Month as YYYY-MM. Defaults to the current month."),
        category: z.string().optional().describe("Only this category (name or UUID) and its subcategories."),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ month: wanted, category }) => {
      const monthKey = wanted ?? localDate(new Date()).slice(0, 7);
      const date = `${monthKey}-01`;

      let categoryId: string | undefined;
      if (category) {
        const match = resolveTagStrict(state, category);
        if ("error" in match) return toolError(match.error);
        categoryId = match.tag.id;
      }

      const base = mainCurrency(state);
      if (typeof base === "string") return toolError(base);

      const tags = new Map(state.tags.map((t) => [t.id, t]));
      const facts = new Map<string, Fact>();
      const add = (key: string, side: keyof Fact, amount: number) => {
        const fact = facts.get(key) ?? { outcome: 0, income: 0 };
        fact[side] += amount;
        facts.set(key, fact);
      };
      for (const tx of state.transactions) {
        if (tx.deleted || !tx.date.startsWith(monthKey)) continue;
        if (tx.incomeAccount !== tx.outcomeAccount) continue;
        const side: keyof Fact | undefined = tx.outcome > 0 && tx.income === 0 ? "outcome"
          : tx.income > 0 && tx.outcome === 0 ? "income" : undefined;
        if (!side) continue;
        const account = state.accounts.find((a) => a.id === tx.outcomeAccount);
        if (!account || account.type === "debt" || account.inBalance === false) continue;
        const instrument = state.getInstrument(side === "outcome" ? tx.outcomeInstrument : tx.incomeInstrument);
        if (!instrument || !(instrument.rate > 0)) {
          return toolError(`Cannot compute the budget: currency of transaction ${tx.id} is missing or has no rate.`);
        }
        const amount = (side === "outcome" ? tx.outcome : tx.income) * (instrument.rate / base.rate);
        add(TOTAL_BUDGET_TAG, side, amount);
        // ZenMoney books an operation under its first category
        const first = tx.tag?.[0];
        if (!first) add("", side, amount);
        else for (const id of categoryPath(first, tags)) add(id, side, amount);
      }

      const rows = state
        .getBudgets()
        .filter((b) => b.date === date && (b.outcome !== 0 || b.income !== 0))
        .filter((b) => !categoryId || (b.tag !== null && b.tag !== TOTAL_BUDGET_TAG && categoryPath(b.tag, tags).includes(categoryId)));
      const label = (b: Budget) =>
        b.tag === TOTAL_BUDGET_TAG ? "All categories"
          : b.tag === null ? "Uncategorized"
            : categoryPath(b.tag, tags).reverse().map((id) => tags.get(id)?.title ?? id).join(" / ");
      const order = (b: Budget) => (b.tag === TOTAL_BUDGET_TAG ? "" : `~${label(b)}`);
      rows.sort((a, b) => order(a).localeCompare(order(b)));

      const money = (n: number) => `${n.toFixed(2)} ${base.shortTitle}`;
      const section = (side: keyof Fact, title: string, verb: string) => {
        const lines = rows
          .filter((b) => b[side] !== 0)
          .map((b) => {
            const plan = b[side];
            const fact = facts.get(b.tag ?? "")?.[side] ?? 0;
            const rest = plan - fact;
            const status = side === "outcome"
              ? rest >= 0 ? `left ${money(rest)}` : `over by ${money(-rest)}`
              : rest > 0 ? `still expected ${money(rest)}` : `above plan by ${money(-rest)}`;
            // ZenMoney stores a parent's plan apart from its children's;
            // name theirs instead of guessing how the app adds them up
            const children = b.tag && b.tag !== TOTAL_BUDGET_TAG
              ? rows.filter((c) => c.tag && c.tag !== b.tag && tags.get(c.tag)?.parent === b.tag)
                .reduce((sum, c) => sum + c[side], 0)
              : 0;
            const childNote = children !== 0 ? ` | subcategory plans ${money(children)}` : "";
            return `- ${label(b)}: plan ${money(plan)} | ${verb} ${money(fact)} | ${status}${childNote}`;
          });
        return lines.length > 0 ? `${title}:\n${lines.join("\n")}` : undefined;
      };

      const header = `Budget for ${monthKey} | ${base.shortTitle} (current exchange rates)`;
      const total = facts.get(TOTAL_BUDGET_TAG) ?? { outcome: 0, income: 0 };
      const scope = categoryId ? facts.get(categoryId) ?? { outcome: 0, income: 0 } : total;
      const totals = `${categoryId ? `${tags.get(categoryId)!.title} this month` : "This month"}: spent ${money(scope.outcome)}, received ${money(scope.income)}`;
      const sections = [section("outcome", "Expenses", "spent"), section("income", "Income", "received")]
        .filter((s): s is string => s !== undefined);
      if (sections.length === 0) {
        return toolText(`${header}\n\nNo budget set for ${monthKey}${categoryId ? " in this category" : ""}.\n${totals}`);
      }
      return toolText([header, ...sections, totals].join("\n\n"));
    }
  );

  server.registerTool(
    "set_budget",
    {
      title: "Set Budget",
      description: "Set a month's planned expenses and/or income for a category, or for all categories with total: true, in your main currency. Pass 0 to remove that plan. The other side of an existing budget is kept.",
      inputSchema: {
        month: month.describe("Month as YYYY-MM"),
        category: z.string().optional().describe("Category name or UUID. Omit when total is true."),
        total: z.boolean().optional().describe("Set the budget for all categories together instead of one category."),
        outcome: z.number().nonnegative().optional().describe("Planned expenses; 0 removes the plan"),
        income: z.number().nonnegative().optional().describe("Planned income; 0 removes the plan"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ month: monthKey, category, total, outcome, income }) => {
      if ((category === undefined) === (total !== true)) {
        return toolError("Pass either category or total: true.");
      }
      if (outcome === undefined && income === undefined) {
        return toolError("Pass outcome, income or both.");
      }

      let tag = TOTAL_BUDGET_TAG;
      let title = "All categories";
      if (category !== undefined) {
        const match = resolveTagStrict(state, category);
        if ("error" in match) return toolError(match.error);
        tag = match.tag.id;
        title = match.tag.title;
      }
      const user = state.getUser();
      if (!user) return toolError("User not found. Run sync_data first.");
      const base = mainCurrency(state);
      if (typeof base === "string") return toolError(base);

      const date = `${monthKey}-01`;
      let before: Budget | undefined;
      let sent!: Budget;
      try {
        await state.write(
          () => {
            if (tag !== TOTAL_BUDGET_TAG) checkStillValid(state, [], [tag]);
            // Read at the write's turn, so the side not passed keeps the
            // value a write queued ahead left
            before = state.findBudget(date, tag);
            sent = {
              ...(before ?? { income: 0, incomeLock: false, outcome: 0, outcomeLock: false }),
              user: user.id,
              tag,
              date,
              changed: Math.floor(Date.now() / 1000),
            };
            // A locked plan is the amount itself, as zerro writes it;
            // removing one clears the amount and the lock
            if (outcome !== undefined) Object.assign(sent, { outcome, outcomeLock: outcome > 0 });
            if (income !== undefined) Object.assign(sent, { income, incomeLock: income > 0 });
            return { budget: [sent] };
          },
          () => state.upsertBudget(sent)
        );
      } catch (error) {
        return toolError(`Failed to set the budget: ${error instanceof Error ? error.message : String(error)}`);
      }

      const saved = state.findBudget(date, tag) ?? sent;
      const money = (n: number) => `${n.toFixed(2)} ${base.shortTitle}`;
      const line = (side: "outcome" | "income", name: string) => {
        const was = before?.[side] ?? 0;
        return `- ${name}: ${saved[side] === 0 ? "none" : money(saved[side])}${was !== saved[side] ? ` (was ${was === 0 ? "none" : money(was)})` : ""}`;
      };
      const kept = saved.outcome !== sent.outcome || saved.income !== sent.income
        ? "\n\nWarning: the server kept a different version (changed elsewhere meanwhile)."
        : "";
      return toolText(`Budget for ${title}, ${monthKey}:\n${line("outcome", "Expenses")}\n${line("income", "Income")}${kept}`);
    }
  );
}

function mainCurrency(state: ZenState): Instrument | string {
  const user = state.getUser();
  const base = user && state.getInstrument(user.currency);
  if (!base) return "The user's main currency is missing. Run sync_data first.";
  if (!(base.rate > 0)) return `Invalid exchange rate for ${base.shortTitle}.`;
  return base;
}

/** The category and its ancestors, nearest first. */
function categoryPath(id: string, tags: Map<string, Tag>): string[] {
  const path: string[] = [];
  let current: string | null = id;
  while (current && !path.includes(current)) {
    path.push(current);
    const parent: string | null = tags.get(current)?.parent ?? null;
    current = parent && tags.has(parent) ? parent : null;
  }
  return path;
}
