import type { Transaction } from "../api.js";
import type { ZenState } from "../state.js";

export function debtAccounts(state: ZenState, transaction: Transaction) {
  const from = state.accounts.find((a) => a.id === transaction.outcomeAccount);
  const to = state.accounts.find((a) => a.id === transaction.incomeAccount);
  if (to?.type === "debt" && from?.type !== "debt") return { debt: to, account: from, outgoing: true };
  if (from?.type === "debt" && to?.type !== "debt") return { debt: from, account: to, outgoing: false };
  return undefined;
}

export function debtCounterparty(state: ZenState, transaction: Transaction): string {
  return state.merchants.find((m) => m.id === transaction.merchant)?.title.trim()
    || transaction.payee?.trim() || "(unknown)";
}
