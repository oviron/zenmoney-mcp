import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { isoDate } from "../lib/dates.js";
import { resolveAccountStrict, resolveTagStrict } from "../lib/resolve.js";
import { serverVersionWarning } from "../lib/format.js";
import { toolError, toolText } from "../lib/result.js";

export function registerCreateTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "add_expense",
    {
      title: "Add Expense",
      description: "Add an expense transaction to ZenMoney. Requires account name/id, amount, and date. Optionally accepts category, payee, and comment.",
      inputSchema: {
        account: z
          .string()
          .describe("Account name or UUID to deduct from"),
        amount: z.number().positive().describe("Expense amount (positive number)"),
        date: isoDate.describe("Transaction date in YYYY-MM-DD format"),
        category: z
          .string()
          .optional()
          .describe("Category name or UUID"),
        payee: z.string().optional().describe("Payee/merchant name"),
        comment: z.string().optional().describe("Transaction comment"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account, amount, date, category, payee, comment }) => {

      const accMatch = resolveAccountStrict(state, account);
      if ("error" in accMatch) return toolError(accMatch.error);
      const acc = accMatch.account;

      const instrumentId = acc.instrument ?? state.getUser()?.currency ?? 1;
      const user = state.getUser();
      if (!user) {
        return toolError("User not found. Run sync_data first.");
      }

      let tagIds: string[] | null = null;
      if (category) {
        const match = resolveTagStrict(state, category);
        if ("error" in match) return toolError(match.error);
        tagIds = [match.tag.id];
      }
      const now = Math.floor(Date.now() / 1000);

      const transaction = {
        id: randomUUID(),
        changed: now,
        created: now,
        user: user.id,
        deleted: false,
        hold: null,
        viewed: false,
        incomeInstrument: instrumentId,
        incomeAccount: acc.id,
        income: 0,
        incomeBankID: null as string | null,
        outcomeInstrument: instrumentId,
        outcomeAccount: acc.id,
        outcome: amount,
        outcomeBankID: null as string | null,
        opIncome: null as number | null,
        opIncomeInstrument: null as number | null,
        opOutcome: null as number | null,
        opOutcomeInstrument: null as number | null,
        tag: tagIds,
        merchant: null as string | null,
        payee: payee ?? null,
        originalPayee: null,
        comment: comment ?? null,
        date,
        mcc: null,
        latitude: null,
        longitude: null,
        reminderMarker: null,
        qrCode: null,
      };

      try {
        await state.write({ transaction: [transaction] }, () =>
          state.upsertTransaction(transaction)
        );

        const instr = state.getInstrument(instrumentId);
        const currency = instr?.shortTitle ?? "";
        const catName = tagIds
          ? tagIds
              .map((id) => state.tags.find((t) => t.id === id)?.title ?? id)
              .join(", ")
          : "uncategorized";

        return toolText(
          `Expense added:\n- Amount: ${amount} ${currency}\n- Account: ${acc.title}\n- Date: ${date}\n- Category: ${catName}${payee ? `\n- Payee: ${payee}` : ""}${comment ? `\n- Comment: ${comment}` : ""}\n- ID: ${transaction.id}${serverVersionWarning(state, transaction)}`
        );
      } catch (error) {
        return toolError(`Failed to add expense: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.registerTool(
    "add_income",
    {
      title: "Add Income",
      description: "Add an income transaction to ZenMoney.",
      inputSchema: {
        account: z.string().describe("Account name or UUID to credit"),
        amount: z.number().positive().describe("Income amount (positive number)"),
        date: isoDate.describe("Transaction date in YYYY-MM-DD format"),
        category: z.string().optional().describe("Category name or UUID"),
        payee: z.string().optional().describe("Payer name"),
        comment: z.string().optional().describe("Transaction comment"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account, amount, date, category, payee, comment }) => {

      const accMatch = resolveAccountStrict(state, account);
      if ("error" in accMatch) return toolError(accMatch.error);
      const acc = accMatch.account;

      const instrumentId = acc.instrument ?? state.getUser()?.currency ?? 1;
      const user = state.getUser();
      if (!user) {
        return toolError("User not found. Run sync_data first.");
      }

      let tagIds: string[] | null = null;
      if (category) {
        const match = resolveTagStrict(state, category);
        if ("error" in match) return toolError(match.error);
        tagIds = [match.tag.id];
      }
      const now = Math.floor(Date.now() / 1000);

      const transaction = {
        id: randomUUID(),
        changed: now,
        created: now,
        user: user.id,
        deleted: false,
        hold: null,
        viewed: false,
        incomeInstrument: instrumentId,
        incomeAccount: acc.id,
        income: amount,
        incomeBankID: null as string | null,
        outcomeInstrument: instrumentId,
        outcomeAccount: acc.id,
        outcome: 0,
        outcomeBankID: null as string | null,
        opIncome: null as number | null,
        opIncomeInstrument: null as number | null,
        opOutcome: null as number | null,
        opOutcomeInstrument: null as number | null,
        tag: tagIds,
        merchant: null as string | null,
        payee: payee ?? null,
        originalPayee: null,
        comment: comment ?? null,
        date,
        mcc: null,
        latitude: null,
        longitude: null,
        reminderMarker: null,
        qrCode: null,
      };

      try {
        await state.write({ transaction: [transaction] }, () =>
          state.upsertTransaction(transaction)
        );

        const instr = state.getInstrument(instrumentId);
        const currency = instr?.shortTitle ?? "";

        return toolText(
          `Income added:\n- Amount: ${amount} ${currency}\n- Account: ${acc.title}\n- Date: ${date}\n- ID: ${transaction.id}${serverVersionWarning(state, transaction)}`
        );
      } catch (error) {
        return toolError(`Failed to add income: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.registerTool(
    "add_transfer",
    {
      title: "Add Transfer",
      description: "Transfer money between two accounts in ZenMoney. For cross-currency transfers, specify both outcome_amount (source) and income_amount (destination). For same-currency transfers, just use outcome_amount (or amount as alias).",
      inputSchema: {
        from_account: z.string().describe("Source account name or UUID"),
        to_account: z.string().describe("Destination account name or UUID"),
        amount: z.number().positive().optional().describe("Transfer amount (alias for outcome_amount, for same-currency transfers)"),
        outcome_amount: z.number().positive().optional().describe("Amount debited from source account (in source account currency)"),
        income_amount: z.number().positive().optional().describe("Amount credited to destination account (in destination account currency). Required for cross-currency transfers."),
        date: isoDate.describe("Transaction date in YYYY-MM-DD format"),
        comment: z.string().optional().describe("Transfer comment"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ from_account, to_account, amount, outcome_amount, income_amount, date, comment }) => {

      const fromMatch = resolveAccountStrict(state, from_account, "Source account");
      if ("error" in fromMatch) return toolError(fromMatch.error);
      const fromAcc = fromMatch.account;

      const toMatch = resolveAccountStrict(state, to_account, "Destination account");
      if ("error" in toMatch) return toolError(toMatch.error);
      const toAcc = toMatch.account;

      if (fromAcc.id === toAcc.id) {
        return toolError(
          `Source and destination are the same account (${fromAcc.title}). A transfer needs two different accounts.`
        );
      }

      const user = state.getUser();
      if (!user) {
        return toolError("User not found. Run sync_data first.");
      }

      const resolvedOutcome = outcome_amount ?? amount;
      if (!resolvedOutcome) {
        return toolError("Either 'amount' or 'outcome_amount' must be provided.");
      }

      const outcomeInstrument =
        fromAcc.instrument ?? user.currency ?? 1;
      const incomeInstrument =
        toAcc.instrument ?? user.currency ?? 1;
      const isCrossCurrency = outcomeInstrument !== incomeInstrument;

      if (isCrossCurrency && !income_amount) {
        const fromInstr = state.getInstrument(outcomeInstrument);
        const toInstr = state.getInstrument(incomeInstrument);
        return toolError(
          `Cross-currency transfer: source account is ${fromInstr?.shortTitle ?? "?"} and destination is ${toInstr?.shortTitle ?? "?"}. Please provide income_amount (the amount in ${toInstr?.shortTitle ?? "destination currency"}).`
        );
      }

      const resolvedIncome = income_amount ?? resolvedOutcome;
      const now = Math.floor(Date.now() / 1000);

      const transaction = {
        id: randomUUID(),
        changed: now,
        created: now,
        user: user.id,
        deleted: false,
        hold: null,
        viewed: false,
        incomeInstrument,
        incomeAccount: toAcc.id,
        income: resolvedIncome,
        incomeBankID: null as string | null,
        outcomeInstrument,
        outcomeAccount: fromAcc.id,
        outcome: resolvedOutcome,
        outcomeBankID: null as string | null,
        opIncome: null as number | null,
        opIncomeInstrument: null as number | null,
        opOutcome: null as number | null,
        opOutcomeInstrument: null as number | null,
        tag: null as string[] | null,
        merchant: null as string | null,
        payee: null as string | null,
        originalPayee: null,
        comment: comment ?? null,
        date,
        mcc: null,
        latitude: null,
        longitude: null,
        reminderMarker: null,
        qrCode: null,
      };

      try {
        await state.write({ transaction: [transaction] }, () =>
          state.upsertTransaction(transaction)
        );

        const fromInstr = state.getInstrument(outcomeInstrument);
        const toInstr = state.getInstrument(incomeInstrument);
        const amountLine =
          isCrossCurrency || resolvedIncome !== resolvedOutcome
            ? `- From amount: ${resolvedOutcome} ${fromInstr?.shortTitle ?? ""}\n- To amount: ${resolvedIncome} ${toInstr?.shortTitle ?? ""}`
            : `- Amount: ${resolvedOutcome} ${fromInstr?.shortTitle ?? ""}`;

        return toolText(
          `Transfer added:\n- From: ${fromAcc.title}\n- To: ${toAcc.title}\n${amountLine}\n- Date: ${date}\n- ID: ${transaction.id}${serverVersionWarning(state, transaction)}`
        );
      } catch (error) {
        return toolError(`Failed to add transfer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
