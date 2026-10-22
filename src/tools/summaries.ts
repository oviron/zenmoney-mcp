import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Instrument, Tag } from "../api.js";
import type { ZenState } from "../state.js";
import { isoDate, localDate } from "../lib/dates.js";
import { resolveAccountStrict, resolveTagStrict } from "../lib/resolve.js";
import { toolError, toolText } from "../lib/result.js";

type Group = {
  title: string;
  amount: number;
  count: number;
  currencies: Map<Instrument, number>;
};

type Summary = {
  groups: Map<string, Group>;
  amount: number;
  count: number;
};

const summarySchema = z.object({
  type: z.enum(["expenses", "income"]),
  groups: z.array(z.object({
    title: z.string(), amount: z.number(), count: z.number().int().nonnegative(),
    share: z.number().describe("Percentage of the section total, rounded as in the text"),
    originalAmounts: z.array(z.object({ amount: z.number(), currency: z.string() }))
      .optional().describe("Original currency totals, present only for groups with currency conversion"),
  })),
  total: z.number(), count: z.number().int().nonnegative(),
});

export function registerSummaryTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "summarize_transactions",
    {
      title: "Summarize Transactions",
      description: 'Summarize expenses or income by category, payee, account or month in your main currency at current rates. Answers "How much did I spend on food in September?"',
      inputSchema: {
        days: z.number().int().nonnegative().optional().default(30)
          .describe("Days to look back from today. Ignored if start_date or end_date is set."),
        start_date: isoDate.optional()
          .describe("Inclusive start, YYYY-MM-DD. Unbounded if only end_date is set."),
        end_date: isoDate.optional()
          .describe("Inclusive end, YYYY-MM-DD. Defaults to today."),
        group_by: z.enum(["category", "payee", "account", "month"]).optional().default("category")
          .describe("Group by category (first tag only), payee, account or calendar month."),
        roll_up: z.boolean().optional().default(true)
          .describe("Roll subcategories up to their root category when grouping by category."),
        type: z.enum(["expense", "income", "both"]).optional().default("expense")
          .describe("Expenses, income, or separate totals for both with net income minus expenses."),
        account: z.string().optional().describe("Filter by account name or UUID."),
        category: z.string().optional().describe("Filter by category name or UUID, including all subcategories."),
      },
      outputSchema: {
        startDate: isoDate, endDate: isoDate,
        currency: z.string().describe("Main currency shortTitle; amounts use current exchange rates"),
        sections: z.array(summarySchema),
        net: z.number().optional().describe("Income minus expenses, present when both sections are displayed"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ days, start_date, end_date, group_by, roll_up, type, account, category }) => {
      let lowerBound: string;
      let upperBound: string;
      if (start_date || end_date) {
        lowerBound = start_date ?? "0000-01-01";
        upperBound = end_date ?? localDate(new Date());
        if (start_date && end_date && start_date > end_date) {
          return toolError(`start_date (${start_date}) must be on or before end_date (${end_date}).`);
        }
      } else {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        lowerBound = localDate(cutoff);
        upperBound = localDate(new Date());
      }

      let accountId: string | undefined;
      if (account) {
        const match = resolveAccountStrict(state, account);
        if ("error" in match) return toolError(match.error);
        accountId = match.account.id;
      }
      let categoryId: string | undefined;
      if (category) {
        const match = resolveTagStrict(state, category);
        if ("error" in match) return toolError(match.error);
        categoryId = match.tag.id;
      }

      const user = state.getUser();
      const base = user && state.getInstrument(user.currency);
      if (!base) return toolError("Cannot summarize: the user's main currency is missing. Run sync_data first.");
      if (!Number.isFinite(base.rate) || base.rate <= 0) {
        return toolError(`Cannot summarize: invalid exchange rate for ${base.shortTitle}.`);
      }

      const accounts = new Map(state.accounts.map((a) => [a.id, a]));
      const tags = new Map(state.tags.map((tag) => [tag.id, tag]));
      const merchants = new Map(state.merchants.map((m) => [m.id, m.title]));
      const expenses: Summary = { groups: new Map(), amount: 0, count: 0 };
      const income: Summary = { groups: new Map(), amount: 0, count: 0 };

      for (const tx of state.transactions) {
        if (tx.deleted || tx.date < lowerBound || tx.date > upperBound) continue;
        if (tx.incomeAccount !== tx.outcomeAccount) continue;
        const direction = tx.outcome > 0 && tx.income === 0 ? "expense"
          : tx.income > 0 && tx.outcome === 0 ? "income" : undefined;
        if (!direction || (type !== "both" && type !== direction)) continue;
        if (accountId && tx.outcomeAccount !== accountId) continue;
        if (categoryId && !tx.tag?.some((id) => categoryPath(id, tags).includes(categoryId))) continue;

        const txAccount = accounts.get(tx.outcomeAccount);
        if (!txAccount) return toolError(`Cannot summarize: account ${tx.outcomeAccount} is missing. Run sync_data first.`);
        if (txAccount.type === "debt" || txAccount.inBalance === false) continue;

        const amount = direction === "expense" ? tx.outcome : tx.income;
        const source = state.getInstrument(direction === "expense" ? tx.outcomeInstrument : tx.incomeInstrument);
        if (!source) return toolError(`Cannot summarize: currency for transaction ${tx.id} is missing. Run sync_data first.`);
        if (!Number.isFinite(source.rate) || source.rate <= 0) {
          return toolError(`Cannot summarize: invalid exchange rate for ${source.shortTitle}.`);
        }
        const converted = source.id === base.id ? amount : amount * (source.rate / base.rate);
        if (!Number.isFinite(converted)) return toolError(`Cannot summarize: invalid amount for transaction ${tx.id}.`);

        let key: string;
        let title: string;
        switch (group_by) {
          case "category": {
            const first = tx.tag?.[0];
            const id = first && (roll_up ? categoryPath(first, tags).at(-1)! : first);
            key = id ?? "";
            title = id ? tags.get(id)?.title ?? id : "Uncategorized";
            break;
          }
          case "payee":
            // The merchant stands in for an empty payee, as in list_transactions
            key = tx.payee?.trim() || merchants.get(tx.merchant ?? "") || "";
            title = key || "Unknown payee";
            break;
          case "account":
            key = txAccount.id;
            title = txAccount.title;
            break;
          case "month":
            key = title = tx.date.slice(0, 7);
            break;
        }

        const summary = direction === "expense" ? expenses : income;
        let group = summary.groups.get(key);
        if (!group) {
          group = { title, amount: 0, count: 0, currencies: new Map() };
          summary.groups.set(key, group);
        }
        group.amount += converted;
        group.count++;
        group.currencies.set(source, (group.currencies.get(source) ?? 0) + amount);
        summary.amount += converted;
        summary.count++;
      }

      const header = `Transaction summary | ${lowerBound} to ${upperBound} | ${base.shortTitle} (current exchange rates)`;
      const structuredContent: { startDate: string; endDate: string; currency: string; sections: z.infer<typeof summarySchema>[]; net?: number } = {
        startDate: lowerBound, endDate: upperBound, currency: base.shortTitle, sections: [],
      };
      if (expenses.count + income.count === 0) {
        return { ...toolText(`${header}\n\nNo transactions found in the given period matching these filters.`), structuredContent };
      }
      const sections: string[] = [header];
      const append = (label: "expenses" | "income", summary: Summary) => {
        const section = formatSummary(label, summary, base);
        sections.push(section.text);
        structuredContent.sections.push(section.data);
      };
      if (type !== "income") append("expenses", expenses);
      if (type !== "expense") append("income", income);
      if (type === "both") {
        structuredContent.net = Number((income.amount - expenses.amount).toFixed(2));
        sections.push(`Net: ${(income.amount - expenses.amount).toFixed(2)} ${base.shortTitle}`);
      }
      return { ...toolText(sections.join("\n\n")), structuredContent };
    }
  );
}

function categoryPath(id: string, tags: Map<string, Tag>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current)) {
    path.push(current);
    seen.add(current);
    const parent: string | null = tags.get(current)?.parent ?? null;
    current = parent && tags.has(parent) ? parent : null;
  }
  return path;
}

function formatSummary(label: "expenses" | "income", summary: Summary, base: Instrument) {
  const groups: z.infer<typeof summarySchema>["groups"] = [];
  const lines = [...summary.groups.values()]
    .sort((a, b) => b.amount - a.amount || a.title.localeCompare(b.title))
    .map((group) => {
      const originals = [...group.currencies];
      const sourceAmounts = originals.some(([instrument]) => instrument.id !== base.id)
        ? ` | original: ${originals.map(([instrument, amount]) => `${amount.toFixed(2)} ${instrument.shortTitle}`).join(", ")}`
        : "";
      const share = summary.amount === 0 ? 0 : group.amount / summary.amount * 100;
      groups.push({
        title: group.title, amount: Number(group.amount.toFixed(2)), count: group.count, share: Number(share.toFixed(2)),
        ...(sourceAmounts ? { originalAmounts: originals.map(([instrument, amount]) => ({ amount: Number(amount.toFixed(2)), currency: instrument.shortTitle })) } : {}),
      });
      return `- ${group.title}: ${group.amount.toFixed(2)} ${base.shortTitle} | ${share.toFixed(2)}% | ${transactionCount(group.count)}${sourceAmounts}`;
    });
  lines.push(`Total ${label}: ${summary.amount.toFixed(2)} ${base.shortTitle} | ${transactionCount(summary.count)}`);
  return {
    text: `${label === "expenses" ? "Expenses" : "Income"}:\n${lines.join("\n")}`,
    data: { type: label, groups, total: Number(summary.amount.toFixed(2)), count: summary.count },
  };
}

function transactionCount(count: number): string {
  return `${count} transaction${count === 1 ? "" : "s"}`;
}
