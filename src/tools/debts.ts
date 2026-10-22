import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transaction } from "../api.js";
import type { ZenState } from "../state.js";
import { alreadyExists, checkNewId, creationId, findExisting, retryDescription, TransactionExists } from "../lib/creation.js";
import { isoDate } from "../lib/dates.js";
import { debtAccounts, debtCounterparty } from "../lib/debts.js";
import { currencyOf, formatTransactionLine, serverVersionWarning } from "../lib/format.js";
import { checkStillValid, resolveAccountStrict, resolveMerchantId } from "../lib/resolve.js";
import { toolError, toolText } from "../lib/result.js";

type Balance = { units: bigint; scale: number };

const debtSchema = z.object({
  counterparty: z.string(), amount: z.number().nonnegative(),
  currency: z.string().nullable().describe("Original currency shortTitle, or null when unknown"),
  instrumentId: z.string().optional().describe("Fallback instrument id shown when its currency is unknown"),
  direction: z.enum(["owedToYou", "youOwe", "settled"]).describe("Who owes the absolute amount"),
});

function addAmount(balance: Balance, amount: number): void {
  const [decimal, exponent = "0"] = amount.toString().split("e");
  const [whole, fraction = ""] = decimal.split(".");
  const scale = fraction.length - Number(exponent);
  const nextScale = Math.max(balance.scale, scale);
  balance.units = balance.units * 10n ** BigInt(nextScale - balance.scale)
    + BigInt(whole + fraction) * 10n ** BigInt(nextScale - scale);
  balance.scale = nextScale;
}

function balanceAmount({ units, scale }: Balance): string {
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return digits.slice(0, -scale) + (fraction ? `.${fraction}` : "");
}

export function registerDebtTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "add_debt",
    {
      title: "Add Debt",
      description: "Record money lent, borrowed or repaid between an ordinary account and the system debt account. Both amounts use the ordinary account currency. counterparty is required; reuse the same name for a loan and its repayments. An exact case-insensitive name match links a known merchant." + retryDescription,
      inputSchema: {
        id: creationId,
        direction: z.enum(["lend", "borrow", "repay_received", "repay_sent"])
          .describe("lend = you lent money; borrow = you borrowed; repay_received = someone paid you back; repay_sent = you paid someone back"),
        account: z.string().describe("Ordinary, non-archived account name or UUID; the debt account is selected automatically"),
        amount: z.number().positive().describe("Positive amount in the ordinary account currency"),
        counterparty: z.string().trim().min(1).describe("Who the debt is with; saved as payee"),
        date: isoDate.describe("Transaction date in YYYY-MM-DD format"),
        comment: z.string().optional().describe("Transaction comment"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ id, direction, account, amount, counterparty, date, comment }) => {
      const existing = findExisting(state, id);
      if (existing) return alreadyExists(state, existing);

      const match = resolveAccountStrict(state, account);
      if ("error" in match) return toolError(match.error);
      const acc = match.account;
      if (acc.type === "debt" || acc.archive) {
        return toolError(`Account "${acc.title}" must be an ordinary, non-archived account. add_debt selects the debt account automatically.`);
      }
      const debtAcc = state.accounts.find((a) => a.type === "debt");
      if (!debtAcc) {
        return toolError("No debt account found. Record a debt in the ZenMoney app, then run sync_data and try again.");
      }
      if (debtAcc.archive) return toolError("The debt account is archived. Unarchive it in ZenMoney before adding a debt.");
      const user = state.getUser();
      if (!user) return toolError("User not found. Run sync_data first.");

      const instrument = acc.instrument ?? user.currency ?? 1;
      const debtInstrument = debtAcc.instrument ?? user.currency ?? 1;
      const outgoing = direction === "lend" || direction === "repay_sent";
      const now = Math.floor(Date.now() / 1000);
      const transaction: Transaction = {
        id: id ?? randomUUID(), changed: now, created: now, user: user.id,
        deleted: false, hold: null, viewed: false,
        incomeInstrument: instrument, incomeAccount: outgoing ? debtAcc.id : acc.id, income: amount, incomeBankID: null,
        outcomeInstrument: instrument, outcomeAccount: outgoing ? acc.id : debtAcc.id, outcome: amount, outcomeBankID: null,
        opIncome: null, opIncomeInstrument: null, opOutcome: null, opOutcomeInstrument: null,
        tag: null, merchant: resolveMerchantId(state, counterparty), payee: counterparty, originalPayee: null,
        comment: comment ?? null, date, mcc: null, latitude: null, longitude: null, reminderMarker: null, qrCode: null,
      };

      try {
        await state.write(
          () => {
            checkNewId(state, transaction.id);
            checkStillValid(state, [
              { account: acc, instrument },
              { account: debtAcc, instrument: debtInstrument },
            ], null);
            const current = state.accounts.find((a) => a.id === acc.id)!;
            const currentDebt = state.accounts.find((a) => a.id === debtAcc.id)!;
            if (current.type === "debt" || currentDebt.type !== "debt" || current.archive || currentDebt.archive) {
              throw new Error("Account type or archive status changed in ZenMoney meanwhile. Nothing was saved; check the accounts and try again.");
            }
            transaction.merchant = resolveMerchantId(state, counterparty);
            return { transaction: [transaction] };
          },
          () => state.upsertTransaction(transaction)
        );
        const saved = state.findTransaction(transaction.id) ?? transaction;
        return toolText(`Debt added (${direction}):\n${formatTransactionLine(state, saved)}${serverVersionWarning(state, transaction)}`);
      } catch (error) {
        if (error instanceof TransactionExists) return alreadyExists(state, error.transaction);
        return toolError(`Failed to add debt: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.registerTool(
    "list_debts",
    {
      title: "List Debts",
      description: "Show who owes you and whom you owe, grouped by counterparty and original currency without conversion. Includes only non-deleted transactions with exactly one debt account. Counterparty is the merchant title, then payee, then (unknown).",
      inputSchema: {
        counterparty: z.string().optional().describe("Filter counterparty titles by case-insensitive substring"),
        include_settled: z.boolean().optional().default(false).describe("Include zero balances (settled debts)"),
      },
      outputSchema: { debts: z.array(debtSchema) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ counterparty, include_settled }) => {
      const groups = new Map<string, { title: string; currencies: Map<number, Balance> }>();
      const filter = counterparty?.trim().toLowerCase();
      for (const tx of state.transactions) {
        if (tx.deleted) continue;
        const sides = debtAccounts(state, tx);
        if (!sides) continue;
        const title = debtCounterparty(state, tx);
        if (filter && !title.toLowerCase().includes(filter)) continue;
        const key = title.toLowerCase();
        let group = groups.get(key);
        if (!group) {
          group = { title, currencies: new Map() };
          groups.set(key, group);
        }
        const instrument = sides.outgoing ? tx.outcomeInstrument : tx.incomeInstrument;
        const amount = sides.outgoing ? tx.outcome : -tx.income;
        const balance = group.currencies.get(instrument) ?? { units: 0n, scale: 0 };
        addAmount(balance, amount);
        group.currencies.set(instrument, balance);
      }

      const lines: string[] = [];
      const debts: z.infer<typeof debtSchema>[] = [];
      for (const group of [...groups.values()].sort((a, b) => a.title.localeCompare(b.title))) {
        for (const [instrument, balance] of [...group.currencies].sort(([a], [b]) => a - b)) {
          if (balance.units === 0n && !include_settled) continue;
          const code = currencyOf(state, instrument);
          const currency = code || `instrument ${instrument}`;
          const value = balanceAmount(balance);
          debts.push({
            counterparty: group.title, amount: Number(value), currency: code || null,
            ...(!code ? { instrumentId: String(instrument) } : {}),
            direction: balance.units > 0n ? "owedToYou" : balance.units < 0n ? "youOwe" : "settled",
          });
          const status = balance.units > 0n ? `owes you ${value} ${currency}`
            : balance.units < 0n ? `you owe ${value} ${currency}` : `settled (0 ${currency})`;
          lines.push(`- ${group.title}: ${status}`);
        }
      }
      return { ...toolText(lines.length ? `Debt balances (original currencies; no conversion):\n${lines.join("\n")}` : "No debt balances match the filters."), structuredContent: { debts } };
    }
  );
}
