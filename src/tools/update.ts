import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Account, Transaction } from "../api.js";
import type { ZenState } from "../state.js";
import { isoDate } from "../lib/dates.js";
import { checkStillValid, resolveAccountStrict, resolveMerchantId, resolveTagsStrict } from "../lib/resolve.js";
import {
  describeChanges,
  formatTransactionLine,
  serverVersionWarning,
} from "../lib/format.js";
import { toolError, toolText } from "../lib/result.js";

export function registerUpdateTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "update_transaction",
    {
      title: "Update Transaction",
      description: "Change an existing transaction: its category, amount, date, payee, comment or account. Pass a single id or a list of ids from list_transactions. A change of account currency requires a new amount for each nonzero side whose currency changes, and clears that side's original amount/currency. A single-account transaction cannot have both income and outcome: to convert an expense to income, pass outcome_amount: 0 and income_amount (reverse for income to expense).",
      inputSchema: {
        id: z
          .union([z.string(), z.array(z.string())])
          .describe("Transaction UUID, or a list of UUIDs to update together"),
        category: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            "New category name or UUID (or several). Pass an empty string or an empty array to remove the category."
          ),
        amount: z
          .number()
          .positive()
          .optional()
          .describe(
            "New amount for an expense or income. For transfers use outcome_amount/income_amount instead."
          ),
        outcome_amount: z
          .number()
          .nonnegative()
          .optional()
          .describe("New amount debited from the source account"),
        income_amount: z
          .number()
          .nonnegative()
          .optional()
          .describe("New amount credited to the destination account"),
        date: isoDate
          .optional()
          .describe("New transaction date in YYYY-MM-DD format"),
        payee: z
          .string()
          .optional()
          .describe(
            "New payee. Pass an empty string to clear it. The linked merchant is re-matched to the new payee."
          ),
        comment: z
          .string()
          .optional()
          .describe("New comment. Pass an empty string to clear it."),
        account: z
          .string()
          .optional()
          .describe(
            "Move an expense or income to another account (name or UUID). If its currency changes, also pass amount or the active side's outcome_amount/income_amount."
          ),
        from_account: z
          .string()
          .optional()
          .describe("New source account (name or UUID). If its currency changes, also pass outcome_amount."),
        to_account: z
          .string()
          .optional()
          .describe("New destination account (name or UUID). If its currency changes, also pass income_amount."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      id,
      category,
      amount,
      outcome_amount,
      income_amount,
      date,
      payee,
      comment,
      account,
      from_account,
      to_account,
    }) => {

      const ids = Array.from(
        new Set((Array.isArray(id) ? id : [id]).map((v) => v.trim()))
      ).filter((v) => v !== "");
      if (ids.length === 0) {
        return toolError("No transaction id given.");
      }

      const touchesNothing =
        category === undefined &&
        amount === undefined &&
        outcome_amount === undefined &&
        income_amount === undefined &&
        date === undefined &&
        payee === undefined &&
        comment === undefined &&
        account === undefined &&
        from_account === undefined &&
        to_account === undefined;
      if (touchesNothing) {
        return toolError(
          "Nothing to update. Pass at least one of: category, amount, outcome_amount, income_amount, date, payee, comment, account, from_account, to_account."
        );
      }

      if (
        account !== undefined &&
        (from_account !== undefined || to_account !== undefined)
      ) {
        return toolError(
          "Use either 'account' (for a regular transaction) or 'from_account'/'to_account' (for a transfer), not both."
        );
      }

      if (
        amount !== undefined &&
        (outcome_amount !== undefined || income_amount !== undefined)
      ) {
        return toolError(
          "Use either 'amount' or 'outcome_amount'/'income_amount', not both."
        );
      }

      const user = state.getUser();
      if (!user) {
        return toolError("User not found. Run sync_data first.");
      }

      let tagIds: string[] | null | undefined;
      if (category !== undefined) {
        const match = resolveTagsStrict(state, category);
        if ("error" in match) return toolError(match.error);
        tagIds = match.tagIds;
      }

      let bothAccount: Account | undefined;
      if (account !== undefined) {
        const match = resolveAccountStrict(state, account);
        if ("error" in match) return toolError(match.error);
        bothAccount = match.account;
      }

      let sourceAccount: Account | undefined;
      if (from_account !== undefined) {
        const match = resolveAccountStrict(state, from_account, "Source account");
        if ("error" in match) return toolError(match.error);
        sourceAccount = match.account;
      }

      let targetAccount: Account | undefined;
      if (to_account !== undefined) {
        const match = resolveAccountStrict(state, to_account, "Destination account");
        if ("error" in match) return toolError(match.error);
        targetAccount = match.account;
      }

      // Reads the transactions from state, so it runs once to validate and
      // again at this write's turn in the queue: an exchange queued before
      // it may have changed or deleted them in the meantime.
      const buildUpdates = ():
        | { originals: Transaction[]; updates: Transaction[] }
        | string => {
        const originals: Transaction[] = [];
        const missing: string[] = [];
        for (const txId of ids) {
          const tx = state.findTransaction(txId);
          if (tx) originals.push(tx);
          else missing.push(txId);
        }
        if (missing.length > 0) {
          return `Transaction${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}. Use list_transactions to find ids, or run sync_data if the transaction was added elsewhere.`;
        }

        const now = Math.floor(Date.now() / 1000);
        const updates: Transaction[] = [];

        for (const tx of originals) {
          const next: Transaction = { ...tx, changed: now };
          const wasTransfer = tx.incomeAccount !== tx.outcomeAccount;

          if (tagIds !== undefined) next.tag = tagIds;
          if (date !== undefined) next.date = date;
          if (comment !== undefined) next.comment = comment === "" ? null : comment;
          if (payee !== undefined) {
            next.payee = payee === "" ? null : payee;
            next.merchant = resolveMerchantId(state, next.payee);
          }

          if (bothAccount) {
            if (wasTransfer) {
              return `Transaction ${tx.id} is a transfer — use from_account/to_account instead of account.`;
            }
            const instrument = bothAccount.instrument ?? user.currency ?? 1;
            next.incomeAccount = bothAccount.id;
            next.outcomeAccount = bothAccount.id;
            next.incomeInstrument = instrument;
            next.outcomeInstrument = instrument;
          }
          if (sourceAccount) {
            next.outcomeAccount = sourceAccount.id;
            next.outcomeInstrument = sourceAccount.instrument ?? user.currency ?? 1;
          }
          if (targetAccount) {
            next.incomeAccount = targetAccount.id;
            next.incomeInstrument = targetAccount.instrument ?? user.currency ?? 1;
          }
          if (wasTransfer && next.incomeAccount === next.outcomeAccount) {
            return `Transaction ${tx.id} is a transfer — from_account and to_account cannot be the same account.`;
          }

          if (amount !== undefined) {
            if (next.incomeAccount !== next.outcomeAccount) {
              return `Transaction ${tx.id} is a transfer — use outcome_amount and/or income_amount instead of amount.`;
            }
            if (tx.outcome > 0 && tx.income === 0) {
              next.outcome = amount;
            } else if (tx.income > 0 && tx.outcome === 0) {
              next.income = amount;
            } else {
              return `Cannot tell whether ${amount} is an expense or an income for transaction ${tx.id}. Pass outcome_amount or income_amount instead.`;
            }
          }
          if (outcome_amount !== undefined) next.outcome = outcome_amount;
          if (income_amount !== undefined) next.income = income_amount;

          if (next.incomeAccount === next.outcomeAccount && next.income > 0 && next.outcome > 0) {
            const hint = tx.outcome > 0 && tx.income === 0
              ? "This is an expense; to make it an income, pass outcome_amount: 0 together with income_amount."
              : tx.income > 0 && tx.outcome === 0
                ? "This is an income; to make it an expense, pass income_amount: 0 together with outcome_amount."
                : "Set income_amount: 0 for an expense, or outcome_amount: 0 for an income.";
            return `Transaction ${tx.id} cannot have both income and outcome on the same account. ${hint} For a transfer, use different from_account/to_account.`;
          }

          if (next.outcomeInstrument !== tx.outcomeInstrument) {
            if (next.outcome > 0 && amount === undefined && outcome_amount === undefined) {
              return `Transaction ${tx.id} changes outcome currency. Pass outcome_amount in the new account currency (or amount for an expense). The old amount cannot be reused across currencies.`;
            }
            next.opOutcome = null;
            next.opOutcomeInstrument = null;
          }
          if (next.incomeInstrument !== tx.incomeInstrument) {
            if (next.income > 0 && amount === undefined && income_amount === undefined) {
              return `Transaction ${tx.id} changes income currency. Pass income_amount in the new account currency (or amount for an income). The old amount cannot be reused across currencies.`;
            }
            next.opIncome = null;
            next.opIncomeInstrument = null;
          }

          if (
            next.incomeAccount !== next.outcomeAccount &&
            (next.income <= 0 || next.outcome <= 0)
          ) {
            return `Transaction ${tx.id} would be a transfer between two accounts with a zero amount on one side. Pass both outcome_amount and income_amount.`;
          }

          updates.push(next);
        }

        return { originals, updates };
      };

      const checked = buildUpdates();
      if (typeof checked === "string") return toolError(checked);
      let { originals, updates } = checked;
      // Amounts are in the currencies the transactions had when the call was
      // checked; a sync ahead in the queue may have moved them to others.
      const amountGiven =
        amount !== undefined || outcome_amount !== undefined || income_amount !== undefined;
      const currencies = new Map(
        updates.map((u) => [u.id, `${u.incomeInstrument}/${u.outcomeInstrument}`])
      );

      try {
        await state.write(
          () => {
            checkStillValid(
              state,
              [bothAccount, sourceAccount, targetAccount]
                .filter((a): a is Account => a !== undefined)
                .map((a) => ({ account: a, instrument: a.instrument ?? user.currency ?? 1 })),
              tagIds
            );
            const fresh = buildUpdates();
            if (typeof fresh === "string") throw new Error(fresh);
            if (amountGiven) {
              for (const u of fresh.updates) {
                if (currencies.get(u.id) !== `${u.incomeInstrument}/${u.outcomeInstrument}`) {
                  throw new Error(
                    `Transaction ${u.id} changed its currency in ZenMoney meanwhile. Nothing was saved; check the amount and try again.`
                  );
                }
              }
            }
            ({ originals, updates } = fresh);
            return { transaction: updates };
          },
          () => {
            for (const next of updates) state.upsertTransaction(next);
          }
        );

        const blocks = updates.map((next, i) => {
          const held = state.findTransaction(next.id) ?? next;
          const changes = describeChanges(state, originals[i], held);
          const detail =
            changes.length > 0
              ? changes.map((c) => `    ${c}`).join("\n")
              : "    (no field actually changed)";
          return `- ${formatTransactionLine(state, held)}\n${detail}${serverVersionWarning(state, next, "\n    ")}`;
        });

        return toolText(
          `${updates.length === 1 ? "Transaction updated" : `${updates.length} transactions updated`}:\n\n${blocks.join("\n")}`
        );
      } catch (error) {
        return toolError(
          `Failed to update transaction${updates.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}
