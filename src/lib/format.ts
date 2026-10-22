import type { Transaction } from "../api.js";
import type { ZenState } from "../state.js";

export function tagTitles(state: ZenState, ids: string[] | null): string {
  if (!ids || ids.length === 0) return "none";
  return ids
    .map((id) => state.tags.find((t) => t.id === id)?.title ?? id)
    .join(", ");
}

export function accountTitle(state: ZenState, id: string): string {
  return state.accounts.find((a) => a.id === id)?.title ?? id;
}

function merchantTitle(state: ZenState, id: string | null): string {
  if (!id) return "none";
  return state.merchants.find((m) => m.id === id)?.title ?? id;
}

export function currencyOf(state: ZenState, instrument: number): string {
  return state.getInstrument(instrument)?.shortTitle ?? "";
}

export function transactionType(t: Transaction): "expense" | "income" | "transfer" | "other" {
  if (t.incomeAccount !== t.outcomeAccount) return "transfer";
  if (t.outcome > 0 && t.income === 0) return "expense";
  if (t.income > 0 && t.outcome === 0) return "income";
  return "other";
}

function formatAmount(
  state: ZenState,
  amount: number,
  instrument: number,
  originalAmount: number | null,
  originalInstrument: number | null,
  sign = ""
): string {
  const accountAmount = `${sign}${amount} ${currencyOf(state, instrument)}`;
  if (
    originalAmount == null || originalInstrument == null ||
    (originalAmount === amount && originalInstrument === instrument)
  ) return accountAmount;
  return `${sign}${originalAmount} ${currencyOf(state, originalInstrument)} (${accountAmount})`;
}

export function formatTransactionLine(state: ZenState, t: Transaction): string {
  const type = transactionType(t);
  const outcome = (sign = "") => formatAmount(
    state, t.outcome, t.outcomeInstrument, t.opOutcome, t.opOutcomeInstrument, sign
  );
  const income = (sign = "") => formatAmount(
    state, t.income, t.incomeInstrument, t.opIncome, t.opIncomeInstrument, sign
  );
  let amountStr = "";

  if (type === "transfer") {
    const from = accountTitle(state, t.outcomeAccount);
    const to = accountTitle(state, t.incomeAccount);
    if (
      t.outcomeInstrument !== t.incomeInstrument || t.outcome !== t.income ||
      outcome() !== income()
    ) {
      amountStr = `${outcome()} → ${income()} (${from} → ${to})`;
    } else {
      amountStr = `${outcome()} (${from} → ${to})`;
    }
  } else if (type === "expense") {
    amountStr = outcome("-");
  } else if (type === "income") {
    amountStr = income("+");
  } else if (t.outcome !== 0 || t.income !== 0) {
    amountStr = `${outcome("-")} / ${income("+")}`;
  }

  const cats = t.tag
    ? t.tag.map((id) => state.tags.find((tg) => tg.id === id)?.title ?? id).join(", ")
    : "";
  const payeeStr = t.payee?.trim()
    ? t.payee
    : state.merchants.find((m) => m.id === t.merchant)?.title ?? "";
  const commentStr = t.comment ? ` — "${t.comment}"` : "";
  // A hold is a card authorization the bank has not settled yet
  const holdStr = t.hold ? " [HOLD]" : "";
  const deletedStr = t.deleted ? " [DELETED]" : "";

  return `${t.date} | ${type.padEnd(8)} | ${amountStr.padEnd(20)} | ${cats.padEnd(15)} | ${payeeStr}${commentStr}${holdStr}${deletedStr} | id: ${t.id}`;
}

export function formatProvenance(t: Transaction): string {
  const created = new Date(t.created * 1000).toISOString().replace(".000Z", "Z");
  const parts = [`created: ${created}`];
  if (t.outcomeBankID) parts.push(`outcome bankID: ${t.outcomeBankID}`);
  if (t.incomeBankID) parts.push(`income bankID: ${t.incomeBankID}`);
  return parts.join(", ");
}

/**
 * ZenMoney keeps the newer version when an object changed on both sides,
 * and the write response then carries the server's copy instead of ours.
 * Returns a warning for the confirmation when the transaction now in state
 * is not what we sent, so the tool does not report a change that was not
 * kept.
 */
export function serverVersionWarning(
  state: ZenState,
  sent: Transaction,
  prefix = "\n\n"
): string {
  const held = state.findTransaction(sent.id);
  if (!held) return `${prefix}Warning: the server's response deleted this transaction.`;
  const diff = describeChanges(state, sent, held);
  if (diff.length === 0) return "";
  return `${prefix}Warning: the server kept a different version (${diff.join("; ")}).`;
}

export function describeChanges(
  state: ZenState,
  before: Transaction,
  after: Transaction
): string[] {
  const lines: string[] = [];

  const catsBefore = tagTitles(state, before.tag);
  const catsAfter = tagTitles(state, after.tag);
  if (catsBefore !== catsAfter) {
    lines.push(`category: ${catsBefore} → ${catsAfter}`);
  } else if ((before.tag ?? []).join() !== (after.tag ?? []).join()) {
    // Two categories can share a title; tell them apart by id
    lines.push(
      `category: ${catsBefore} (${(before.tag ?? []).join(", ")}) → ${catsAfter} (${(after.tag ?? []).join(", ")})`
    );
  }

  if (before.date !== after.date) {
    lines.push(`date: ${before.date} → ${after.date}`);
  }

  const wasSingleAccount = before.incomeAccount === before.outcomeAccount;
  const isSingleAccount = after.incomeAccount === after.outcomeAccount;
  if (wasSingleAccount && isSingleAccount) {
    if (before.outcomeAccount !== after.outcomeAccount) {
      lines.push(
        `account: ${accountTitle(state, before.outcomeAccount)} → ${accountTitle(state, after.outcomeAccount)}`
      );
    }
  } else {
    if (before.outcomeAccount !== after.outcomeAccount) {
      lines.push(
        `from account: ${accountTitle(state, before.outcomeAccount)} → ${accountTitle(state, after.outcomeAccount)}`
      );
    }
    if (before.incomeAccount !== after.incomeAccount) {
      lines.push(
        `to account: ${accountTitle(state, before.incomeAccount)} → ${accountTitle(state, after.incomeAccount)}`
      );
    }
  }

  if (
    before.outcome !== after.outcome ||
    before.outcomeInstrument !== after.outcomeInstrument
  ) {
    lines.push(
      `outcome: ${before.outcome} ${currencyOf(state, before.outcomeInstrument)} → ${after.outcome} ${currencyOf(state, after.outcomeInstrument)}`
    );
  }
  if (
    before.income !== after.income ||
    before.incomeInstrument !== after.incomeInstrument
  ) {
    lines.push(
      `income: ${before.income} ${currencyOf(state, before.incomeInstrument)} → ${after.income} ${currencyOf(state, after.incomeInstrument)}`
    );
  }

  if (before.payee !== after.payee) {
    lines.push(`payee: ${before.payee ?? "none"} → ${after.payee ?? "none"}`);
  }
  if ((before.merchant ?? null) !== (after.merchant ?? null)) {
    lines.push(`merchant: ${merchantTitle(state, before.merchant)} → ${merchantTitle(state, after.merchant)}`);
  }
  if (before.comment !== after.comment) {
    lines.push(`comment: ${before.comment ?? "none"} → ${after.comment ?? "none"}`);
  }

  return lines;
}
