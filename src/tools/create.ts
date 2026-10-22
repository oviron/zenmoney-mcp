import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { isoDate } from "../lib/dates.js";
import { alreadyExists, checkNewId, creationId, findExisting, retryDescription, TransactionExists } from "../lib/creation.js";
import { checkStillValid, resolveAccountStrict, resolveMerchantId, resolveTagsStrict } from "../lib/resolve.js";
import { accountTitle, currencyOf, serverVersionWarning, tagTitles } from "../lib/format.js";
import { toolError, toolText } from "../lib/result.js";

function resolveOriginal(
  state: ZenState,
  accountInstrument: number,
  amount: number | undefined,
  currency: string | undefined
): { amount: number | null; instrument: number | null } | { error: string } {
  if (amount === undefined && currency === undefined) return { amount: null, instrument: null };
  if (amount === undefined || currency === undefined) {
    return { error: "Provide original_amount and original_currency together." };
  }
  const matches = state.instruments.filter((i) => i.shortTitle.toLowerCase() === currency.trim().toLowerCase());
  if (matches.length === 0) return { error: `Original currency code "${currency}" not found. Use an exact shortTitle such as USD.` };
  if (matches.length > 1) return { error: `Original currency code "${currency}" is ambiguous: ${matches.map((i) => `${i.shortTitle} (${i.id})`).join(", ")}.` };
  if (matches[0].id === accountInstrument) {
    return { error: "Original currency is the same as the account currency. Omit original_amount and original_currency; amount is already in that currency." };
  }
  return { amount, instrument: matches[0].id };
}

function originalAmountLine(state: ZenState, amount: number | null, instrument: number | null): string {
  return amount !== null && instrument !== null
    ? `\n- Original amount: ${amount} ${currencyOf(state, instrument)}`
    : "";
}

export function registerCreateTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "add_expense",
    {
      title: "Add Expense",
      description: "Add an expense to ZenMoney. amount is in the account currency. category accepts one or several names/UUIDs. For a foreign-currency purchase, pass original_amount and original_currency together (exact currency code, different from the account currency). payee links a known merchant on an exact case-insensitive name match." + retryDescription,
      inputSchema: {
        id: creationId,
        account: z
          .string()
          .describe("Account name or UUID to deduct from"),
        amount: z.number().positive().describe("Expense amount in the account currency (positive number)"),
        original_amount: z.number().positive().optional().describe("Original purchase amount in original_currency; requires original_currency"),
        original_currency: z.string().optional().describe("Exact currency code from instrument shortTitle, e.g. USD (case-insensitive); requires original_amount and must differ from account currency"),
        date: isoDate.describe("Transaction date in YYYY-MM-DD format"),
        category: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Category name or UUID, or an array of names/UUIDs; empty string/array means uncategorized"),
        payee: z.string().optional().describe("Payee/merchant name; exact case-insensitive name match links a known merchant"),
        comment: z.string().optional().describe("Transaction comment"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, account, amount, original_amount, original_currency, date, category, payee, comment }) => {
      const existing = findExisting(state, id);
      if (existing) return alreadyExists(state, existing);

      const accMatch = resolveAccountStrict(state, account);
      if ("error" in accMatch) return toolError(accMatch.error);
      const acc = accMatch.account;

      const instrumentId = acc.instrument ?? state.getUser()?.currency ?? 1;
      const user = state.getUser();
      if (!user) {
        return toolError("User not found. Run sync_data first.");
      }

      let tagIds: string[] | null = null;
      if (category !== undefined) {
        const match = resolveTagsStrict(state, category);
        if ("error" in match) return toolError(match.error);
        tagIds = match.tagIds;
      }
      const original = resolveOriginal(state, instrumentId, original_amount, original_currency);
      if ("error" in original) return toolError(original.error);
      const now = Math.floor(Date.now() / 1000);

      const transaction = {
        id: id ?? randomUUID(),
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
        opOutcome: original.amount,
        opOutcomeInstrument: original.instrument,
        tag: tagIds,
        merchant: resolveMerchantId(state, payee),
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
        await state.write(
          () => {
            checkNewId(state, transaction.id);
            checkStillValid(state, [{ account: acc, instrument: instrumentId }], tagIds);
            transaction.merchant = resolveMerchantId(state, payee);
            return { transaction: [transaction] };
          },
          () => state.upsertTransaction(transaction)
        );

        // What the server kept, which a warning below compares with what we sent
        const saved = state.findTransaction(transaction.id) ?? transaction;
        return toolText(
          `Expense added:\n- Amount: ${saved.outcome} ${currencyOf(state, saved.outcomeInstrument)}${originalAmountLine(state, saved.opOutcome, saved.opOutcomeInstrument)}\n- Account: ${accountTitle(state, saved.outcomeAccount)}\n- Date: ${saved.date}\n- Category: ${saved.tag?.length ? tagTitles(state, saved.tag) : "uncategorized"}${saved.payee ? `\n- Payee: ${saved.payee}` : ""}${saved.comment ? `\n- Comment: ${saved.comment}` : ""}\n- ID: ${transaction.id}${serverVersionWarning(state, transaction)}`
        );
      } catch (error) {
        if (error instanceof TransactionExists) return alreadyExists(state, error.transaction);
        return toolError(`Failed to add expense: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.registerTool(
    "add_income",
    {
      title: "Add Income",
      description: "Add income to ZenMoney. amount is in the account currency. category accepts one or several names/UUIDs. For foreign-currency income, pass original_amount and original_currency together (exact currency code, different from the account currency). payee links a known merchant on an exact case-insensitive name match." + retryDescription,
      inputSchema: {
        id: creationId,
        account: z.string().describe("Account name or UUID to credit"),
        amount: z.number().positive().describe("Income amount in the account currency (positive number)"),
        original_amount: z.number().positive().optional().describe("Original income amount in original_currency; requires original_currency"),
        original_currency: z.string().optional().describe("Exact currency code from instrument shortTitle, e.g. USD (case-insensitive); requires original_amount and must differ from account currency"),
        date: isoDate.describe("Transaction date in YYYY-MM-DD format"),
        category: z.union([z.string(), z.array(z.string())]).optional().describe("Category name or UUID, or an array of names/UUIDs; empty string/array means uncategorized"),
        payee: z.string().optional().describe("Payer name; exact case-insensitive name match links a known merchant"),
        comment: z.string().optional().describe("Transaction comment"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, account, amount, original_amount, original_currency, date, category, payee, comment }) => {
      const existing = findExisting(state, id);
      if (existing) return alreadyExists(state, existing);

      const accMatch = resolveAccountStrict(state, account);
      if ("error" in accMatch) return toolError(accMatch.error);
      const acc = accMatch.account;

      const instrumentId = acc.instrument ?? state.getUser()?.currency ?? 1;
      const user = state.getUser();
      if (!user) {
        return toolError("User not found. Run sync_data first.");
      }

      let tagIds: string[] | null = null;
      if (category !== undefined) {
        const match = resolveTagsStrict(state, category);
        if ("error" in match) return toolError(match.error);
        tagIds = match.tagIds;
      }
      const original = resolveOriginal(state, instrumentId, original_amount, original_currency);
      if ("error" in original) return toolError(original.error);
      const now = Math.floor(Date.now() / 1000);

      const transaction = {
        id: id ?? randomUUID(),
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
        opIncome: original.amount,
        opIncomeInstrument: original.instrument,
        opOutcome: null as number | null,
        opOutcomeInstrument: null as number | null,
        tag: tagIds,
        merchant: resolveMerchantId(state, payee),
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
        await state.write(
          () => {
            checkNewId(state, transaction.id);
            checkStillValid(state, [{ account: acc, instrument: instrumentId }], tagIds);
            transaction.merchant = resolveMerchantId(state, payee);
            return { transaction: [transaction] };
          },
          () => state.upsertTransaction(transaction)
        );

        const saved = state.findTransaction(transaction.id) ?? transaction;
        return toolText(
          `Income added:\n- Amount: ${saved.income} ${currencyOf(state, saved.incomeInstrument)}${originalAmountLine(state, saved.opIncome, saved.opIncomeInstrument)}\n- Account: ${accountTitle(state, saved.incomeAccount)}\n- Date: ${saved.date}\n- Category: ${saved.tag?.length ? tagTitles(state, saved.tag) : "uncategorized"}${saved.payee ? `\n- Payee: ${saved.payee}` : ""}${saved.comment ? `\n- Comment: ${saved.comment}` : ""}\n- ID: ${transaction.id}${serverVersionWarning(state, transaction)}`
        );
      } catch (error) {
        if (error instanceof TransactionExists) return alreadyExists(state, error.transaction);
        return toolError(`Failed to add income: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.registerTool(
    "add_transfer",
    {
      title: "Add Transfer",
      description: "Transfer money between two ordinary accounts in ZenMoney. For debt accounts use add_debt. For cross-currency transfers, specify both outcome_amount (source) and income_amount (destination). For same-currency transfers, just use outcome_amount (or amount as alias). If amount and outcome_amount are both given, they must be equal." + retryDescription,
      inputSchema: {
        id: creationId,
        from_account: z.string().describe("Source account name or UUID"),
        to_account: z.string().describe("Destination account name or UUID"),
        amount: z.number().positive().optional().describe("Alias for outcome_amount; must equal outcome_amount if both are given"),
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
    async ({ id, from_account, to_account, amount, outcome_amount, income_amount, date, comment }) => {
      const existing = findExisting(state, id);
      if (existing) return alreadyExists(state, existing);

      if (amount !== undefined && outcome_amount !== undefined && amount !== outcome_amount) {
        return toolError("Conflicting 'amount' and 'outcome_amount': they must be equal when both are provided. Use either amount or outcome_amount.");
      }

      const fromMatch = resolveAccountStrict(state, from_account, "Source account");
      if ("error" in fromMatch) return toolError(fromMatch.error);
      const fromAcc = fromMatch.account;

      const toMatch = resolveAccountStrict(state, to_account, "Destination account");
      if ("error" in toMatch) return toolError(toMatch.error);
      const toAcc = toMatch.account;

      if (fromAcc.type === "debt" || toAcc.type === "debt") {
        return toolError("Debt accounts cannot be used in add_transfer. Use add_debt with a counterparty instead.");
      }

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
        id: id ?? randomUUID(),
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
        await state.write(
          () => {
            checkNewId(state, transaction.id);
            checkStillValid(
              state,
              [
                { account: fromAcc, instrument: outcomeInstrument },
                { account: toAcc, instrument: incomeInstrument },
              ],
              null
            );
            if (state.accounts.some((a) => (a.id === fromAcc.id || a.id === toAcc.id) && a.type === "debt")) {
              throw new Error("An account is now a debt account. Use add_debt with a counterparty instead.");
            }
            return { transaction: [transaction] };
          },
          () => state.upsertTransaction(transaction)
        );

        const saved = state.findTransaction(transaction.id) ?? transaction;
        const from = `${saved.outcome} ${currencyOf(state, saved.outcomeInstrument)}`;
        const to = `${saved.income} ${currencyOf(state, saved.incomeInstrument)}`;
        const amountLine =
          from !== to
            ? `- From amount: ${from}\n- To amount: ${to}`
            : `- Amount: ${from}`;

        return toolText(
          `Transfer added:\n- From: ${accountTitle(state, saved.outcomeAccount)}\n- To: ${accountTitle(state, saved.incomeAccount)}\n${amountLine}\n- Date: ${saved.date}\n- ID: ${transaction.id}${serverVersionWarning(state, transaction)}`
        );
      } catch (error) {
        if (error instanceof TransactionExists) return alreadyExists(state, error.transaction);
        return toolError(`Failed to add transfer: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
