import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { isoDate, localDate } from "../lib/dates.js";
import { resolveAccountStrict, resolveTagStrict } from "../lib/resolve.js";
import { formatTransactionLine, formatProvenance } from "../lib/format.js";
import { notSyncedError, toolError, toolText } from "../lib/result.js";

export function registerListTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "list_transactions",
    {
      title: "List Transactions",
      description: "List transactions. By default returns the last 30 days; pass start_date/end_date for an arbitrary period (e.g. Jan 1–31). Sync must be done first.",
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
          .describe("Filter by category name or UUID"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .default(50)
          .describe("Max number of transactions to return (default 50)"),
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
    async ({ days, start_date, end_date, account, category, limit, show_provenance, show_deleted }) => {
      if (!state.isSynced) {
        return notSyncedError();
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
      if (account) {
        const match = resolveAccountStrict(state, account);
        let accId: string;
        if ("account" in match) accId = match.account.id;
        else if (pool.some((t) => t.incomeAccount === account || t.outcomeAccount === account))
          accId = account;
        else return toolError(match.error);
        filtered = filtered.filter(
          (t) => t.incomeAccount === accId || t.outcomeAccount === accId
        );
      }

      if (category) {
        const match = resolveTagStrict(state, category);
        let tagId: string;
        if ("tag" in match) tagId = match.tag.id;
        else if (pool.some((t) => t.tag?.includes(category))) tagId = category;
        else return toolError(match.error);
        filtered = filtered.filter(
          (t) => t.tag && t.tag.includes(tagId)
        );
      }

      // Newest first; within a day, the most recently created first, so the
      // order is stable across calls and a cut by limit is predictable.
      filtered.sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          b.created - a.created ||
          a.id.localeCompare(b.id)
      );
      const total = filtered.length;
      filtered = filtered.slice(0, limit);

      const lines = filtered.map((t) =>
        show_provenance
          ? `${formatTransactionLine(state, t)}\n    ${formatProvenance(t)}`
          : formatTransactionLine(state, t)
      );
      const count =
        total > lines.length
          ? `${lines.length} of ${total}, raise limit to see the rest`
          : `${lines.length}`;

      return toolText(
        lines.length > 0
          ? `Transactions (${count}):\n\n${lines.join("\n")}`
          : "No transactions found in the given period."
      );
    }
  );
}
