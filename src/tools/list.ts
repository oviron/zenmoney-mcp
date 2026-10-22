import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { isoDate, localDate } from "../lib/dates.js";
import { resolveAccountStrict, resolveTagStrict } from "../lib/resolve.js";
import { formatTransactionLine, formatProvenance, transactionType } from "../lib/format.js";
import { notSyncedError, toolError, toolText } from "../lib/result.js";

export const MAX_TRANSACTION_OUTPUT_LENGTH = 50_000;

export function registerListTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "list_transactions",
    {
      title: "List Transactions",
      description: "List transactions, newest first, with optional account, category (including descendants by default), text, type, amount, uncategorized and hold filters combined with AND. Defaults to the last 30 days; start_date/end_date select an arbitrary period. Pages use limit/offset and a 50,000-character text cap; truncated responses give the next offset. Sync must be done first.",
      inputSchema: {
        days: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .default(30)
          .describe("Number of days to look back from today (default 30). Ignored if start_date or end_date is provided."),
        start_date: isoDate
          .optional()
          .describe("Start of date range (inclusive), YYYY-MM-DD. If omitted while end_date is set, defaults to unbounded."),
        end_date: isoDate
          .optional()
          .describe("End of date range (inclusive), YYYY-MM-DD. If omitted while start_date is set, defaults to today."),
        account: z
          .string()
          .optional()
          .describe("Filter by account name or UUID"),
        category: z
          .string()
          .optional()
          .describe("Filter by category name or UUID, including its subcategories unless include_subcategories is false"),
        include_subcategories: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include all descendants of the category filter (default true)"),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring in payee, comment or merchant name"),
        type: z
          .enum(["expense", "income", "transfer"])
          .optional()
          .describe("Filter by the displayed transaction type; different accounts always mean transfer"),
        min_amount: z
          .number()
          .nonnegative()
          .optional()
          .describe("Inclusive minimum absolute account-currency amount, not the original purchase amount. Transfers use the outgoing side, or the incoming side when filtering by the destination account; other operations use the larger absolute side."),
        max_amount: z
          .number()
          .nonnegative()
          .optional()
          .describe("Inclusive maximum absolute amount, using the same account-currency side as min_amount"),
        uncategorized: z
          .boolean()
          .optional()
          .describe("If true, only transactions with no categories, excluding transfers; false leaves categories unrestricted"),
        hold: z
          .boolean()
          .optional()
          .describe("Filter by hold status: true for pending authorizations, false for false/null holds"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .default(50)
          .describe("Max number of transactions to return (default 50); the text size cap may return fewer"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .default(0)
          .describe("Number of matching transactions to skip after sorting (default 0); use the next offset from a truncated response"),
        show_provenance: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Add a line under each transaction with when it was created and the bank import ids (bankID). Useful to tell a bank import that came in twice from two real operations."
          ),
        show_deleted: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            "Also list transactions deleted on the server, marked [DELETED]. Useful when a balance does not add up or to check whether a duplicate was already removed."
          ),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({
      days, start_date, end_date, account, category, include_subcategories,
      query, type, min_amount, max_amount, uncategorized, hold,
      limit, offset, show_provenance, show_deleted,
    }) => {
      if (!state.isSynced) {
        return notSyncedError();
      }
      if (min_amount !== undefined && max_amount !== undefined && min_amount > max_amount) {
        return toolError("min_amount must be less than or equal to max_amount.");
      }

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

      const pool = show_deleted
        ? [...state.transactions, ...state.getDeletedTransactions()]
        : state.transactions;

      let filtered = pool.filter(
        (t) => t.date >= lowerBound && t.date <= upperBound
      );

      // A deleted transaction can point at an account or category that is
      // gone too, so an id that only the listed transactions still carry
      // is accepted as a filter
      let accountId: string | undefined;
      if (account) {
        const match = resolveAccountStrict(state, account);
        if ("account" in match) accountId = match.account.id;
        else if (pool.some((t) => t.incomeAccount === account || t.outcomeAccount === account))
          accountId = account;
        else return toolError(match.error);
        filtered = filtered.filter(
          (t) => t.incomeAccount === accountId || t.outcomeAccount === accountId
        );
      }

      if (category) {
        const match = resolveTagStrict(state, category);
        let tagId: string;
        if ("tag" in match) tagId = match.tag.id;
        else if (pool.some((t) => t.tag?.includes(category))) tagId = category;
        else return toolError(match.error);
        const tagIds = new Set([tagId]);
        if (include_subcategories) {
          const children = new Map<string, string[]>();
          for (const tag of state.tags) {
            if (tag.parent) {
              const siblings = children.get(tag.parent) ?? [];
              siblings.push(tag.id);
              children.set(tag.parent, siblings);
            }
          }
          for (const id of tagIds) {
            for (const child of children.get(id) ?? []) tagIds.add(child);
          }
        }
        filtered = filtered.filter(
          (t) => t.tag?.some((id) => tagIds.has(id))
        );
      }

      if (query) {
        const needle = query.toLowerCase();
        const merchants = new Map(state.merchants.map((m) => [m.id, m.title]));
        filtered = filtered.filter((t) =>
          [t.payee, t.comment, t.merchant ? merchants.get(t.merchant) : null]
            .some((value) => value?.toLowerCase().includes(needle))
        );
      }
      if (type) filtered = filtered.filter((t) => transactionType(t) === type);
      if (min_amount !== undefined || max_amount !== undefined) {
        filtered = filtered.filter((t) => {
          const amount = transactionType(t) === "transfer"
            ? Math.abs(accountId === t.incomeAccount ? t.income : t.outcome)
            : Math.max(Math.abs(t.outcome), Math.abs(t.income));
          return (min_amount === undefined || amount >= min_amount) &&
            (max_amount === undefined || amount <= max_amount);
        });
      }
      if (uncategorized) {
        filtered = filtered.filter((t) => !t.tag?.length && transactionType(t) !== "transfer");
      }
      if (hold !== undefined) filtered = filtered.filter((t) => Boolean(t.hold) === hold);

      // Newest first; within a day, the most recently created first, so the
      // order is stable across calls and a cut by limit is predictable.
      filtered.sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.created - a.created ||
          a.id.localeCompare(b.id)
      );
      const total = filtered.length;
      if (total === 0) return toolText("No transactions found in the given period.");

      function header(count: number) {
        const nextOffset = offset + count;
        const hasMore = nextOffset < total;
        const progress = offset > 0 || hasMore
          ? `${count} of ${total}, offset: ${offset}${hasMore ? `, next offset: ${nextOffset}` : ""}`
          : `${count}`;
        return `Transactions (${progress}):\n\n`;
      }

      const lines: string[] = [];
      let textLength = 0;
      for (const t of filtered.slice(offset, offset + limit)) {
        const line = show_provenance
          ? `${formatTransactionLine(state, t)}\n    ${formatProvenance(t)}`
          : formatTransactionLine(state, t);
        const nextLength = textLength + (lines.length ? 1 : 0) + line.length;
        if (header(lines.length + 1).length + nextLength > MAX_TRANSACTION_OUTPUT_LENGTH) {
          if (lines.length === 0) {
            return toolError(
              `Transaction ${t.id} at offset: ${offset} exceeds the ${MAX_TRANSACTION_OUTPUT_LENGTH}-character response limit and cannot be shown as a whole. To skip it, continue with offset: ${offset + 1}.`
            );
          }
          break;
        }
        lines.push(line);
        textLength = nextLength;
      }

      return toolText(
        header(lines.length) + (lines.length ? lines.join("\n") : "No more transactions.")
      );
    }
  );
}
