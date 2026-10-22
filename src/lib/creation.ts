import { z } from "zod";
import type { Transaction } from "../api.js";
import type { ZenState } from "../state.js";
import { formatTransactionLine } from "./format.js";
import { toolText } from "./result.js";

export const creationId = z.uuid().transform((id) => id.toLowerCase()).optional()
  .describe("Optional transaction UUID. Reuse the same id and parameters when retrying after an uncertain write; omit only for a new operation.");
export const retryDescription = ' If a write "may or may not have been saved", retry with the same id from the error and the same parameters to avoid a duplicate. If that id is already cached, returns the existing transaction without writing.';

export function findExisting(state: ZenState, id: string | undefined): Transaction | undefined {
  if (id === undefined) return undefined;
  return state.transactions.find((t) => t.id.toLowerCase() === id)
    ?? state.getDeletedTransactions().find((t) => t.id.toLowerCase() === id);
}

export function alreadyExists(state: ZenState, transaction: Transaction) {
  return toolText(`Transaction already exists${transaction.deleted ? " (deleted)" : ""}:\n${formatTransactionLine(state, transaction)}`);
}

export class TransactionExists extends Error {
  constructor(readonly transaction: Transaction) {
    super(`Transaction ${transaction.id} already exists.`);
  }
}

export function checkNewId(state: ZenState, id: string): void {
  const existing = findExisting(state, id);
  if (existing) throw new TransactionExists(existing);
}
