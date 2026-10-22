import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transaction } from "../api.js";
import type { ZenState } from "../state.js";
import { formatTransactionLine, serverVersionWarning } from "../lib/format.js";
import { toolError, toolText } from "../lib/result.js";

export function registerDeleteTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "delete_transaction",
    {
      title: "Delete Transaction",
      description: "Delete one or more transactions by id, as the ZenMoney apps do: the transaction is marked deleted, list_transactions with show_deleted still shows it, and restore_transaction brings it back as a copy with a new id. Ids come from list_transactions.",
      inputSchema: {
        id: z
          .union([z.string(), z.array(z.string())])
          .describe("Transaction UUID, or a list of UUIDs to delete together"),
        confirm: z
          .boolean()
          .describe(
            "Must be true. A guard against deleting on a guessed or mistyped id."
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id, confirm }) => {

      if (confirm !== true) {
        return toolError(
          "Refusing to delete without confirm: true."
        );
      }

      const ids = Array.from(
        new Set((Array.isArray(id) ? id : [id]).map((v) => v.trim()))
      ).filter((v) => v !== "");
      if (ids.length === 0) {
        return toolError("No transaction id given.");
      }

      const doomed: Transaction[] = [];
      const missing: string[] = [];
      for (const txId of ids) {
        const tx = state.findTransaction(txId);
        if (tx) doomed.push(tx);
        else missing.push(txId);
      }
      const alreadyDeleted = missing.filter((txId) => state.findDeletedTransaction(txId));
      if (alreadyDeleted.length > 0) {
        return toolError(
          `Already deleted: ${alreadyDeleted.join(", ")}. Nothing was deleted.`
        );
      }
      if (missing.length > 0) {
        return toolError(
          `Transaction${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}. Nothing was deleted. Use list_transactions to find ids, or run sync_data if the transaction was added elsewhere.`
        );
      }

      const now = Math.floor(Date.now() / 1000);

      try {
        // Marked deleted, not erased with a `deletion` object: that is how
        // the ZenMoney apps delete a transaction, and it keeps the record
        // for show_deleted and restore_transaction
        const marked = doomed.map((tx) => ({ ...tx, deleted: true, changed: now }));
        await state.write({ transaction: marked }, () => {
          for (const tx of marked) state.upsertTransaction(tx);
        });

        // The server answers with what it holds; a newer version of a
        // transaction in that answer means it was not deleted
        const kept = doomed.filter((tx) => state.findTransaction(tx.id));
        if (kept.length > 0) {
          const gone = doomed.filter((tx) => !kept.includes(tx));
          return toolError(
            `ZenMoney kept ${kept.length === 1 ? "this transaction" : "these transactions"} (changed elsewhere meanwhile):\n\n${kept.map((tx) => `- ${formatTransactionLine(state, state.findTransaction(tx.id)!)}`).join("\n")}` +
              (gone.length > 0
                ? `\n\nDeleted:\n\n${gone.map((tx) => `- ${formatTransactionLine(state, tx)}`).join("\n")}`
                : "")
          );
        }

        const lines = doomed.map((tx) => `- ${formatTransactionLine(state, tx)}`);
        return toolText(
          `${doomed.length === 1 ? "Transaction deleted" : `${doomed.length} transactions deleted`}:\n\n${lines.join("\n")}\n\nrestore_transaction brings ${doomed.length === 1 ? "it" : "them"} back as a copy with a new id.`
        );
      } catch (error) {
        return toolError(
          `Failed to delete transaction${doomed.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  server.registerTool(
    "restore_transaction",
    {
      title: "Restore Transaction",
      description: "Bring back deleted transactions (list_transactions with show_deleted shows them and their ids). ZenMoney does not undelete in place, so each comes back as a copy with a new id; one already back is not copied twice.",
      inputSchema: {
        id: z
          .union([z.string(), z.array(z.string())])
          .describe("UUID of a deleted transaction, or a list of them"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ id }) => {
      const ids = Array.from(
        new Set((Array.isArray(id) ? id : [id]).map((v) => v.trim()))
      ).filter((v) => v !== "");
      if (ids.length === 0) {
        return toolError("No transaction id given.");
      }

      const deleted: Transaction[] = [];
      for (const txId of ids) {
        const tx = state.findDeletedTransaction(txId);
        if (tx) {
          deleted.push(tx);
          continue;
        }
        return toolError(
          state.findTransaction(txId)
            ? `Transaction ${txId} is not deleted. Nothing was restored.`
            : `No deleted transaction ${txId}. Nothing was restored. list_transactions with show_deleted lists deleted ones.`
        );
      }
      for (const tx of deleted) {
        for (const accountId of new Set([tx.outcomeAccount, tx.incomeAccount])) {
          if (!state.accounts.some((a) => a.id === accountId)) {
            return toolError(
              `Transaction ${tx.id} is on account ${accountId}, which no longer exists. Nothing was restored.`
            );
          }
        }
      }

      // A live transaction identical in what matters is an earlier restore
      const twinOf = (tx: Transaction) =>
        state.transactions.find(
          (t) =>
            t.created === tx.created &&
            t.date === tx.date &&
            t.incomeAccount === tx.incomeAccount &&
            t.outcomeAccount === tx.outcomeAccount &&
            t.income === tx.income &&
            t.outcome === tx.outcome
        );
      const now = Math.floor(Date.now() / 1000);
      const copies = deleted
        .filter((tx) => !twinOf(tx))
        .map((tx) => ({
          from: tx.id,
          copy: { ...tx, id: randomUUID(), deleted: false, changed: now, reminderMarker: null },
        }));
      const already = deleted.filter((tx) => twinOf(tx));

      try {
        if (copies.length > 0) {
          await state.write({ transaction: copies.map((c) => c.copy) }, () => {
            for (const { copy } of copies) state.upsertTransaction(copy);
          });
        }
        const lines = [
          ...copies.map(
            ({ from, copy }) =>
              `- ${formatTransactionLine(state, state.findTransaction(copy.id) ?? copy)} (restored from ${from})${serverVersionWarning(state, copy, " ")}`
          ),
          ...already.map((tx) => `- ${tx.id} is already back as ${twinOf(tx)!.id}`),
        ];
        return toolText(
          `${copies.length === 0 ? "Nothing to restore" : copies.length === 1 ? "Transaction restored" : `${copies.length} transactions restored`}:\n\n${lines.join("\n")}`
        );
      } catch (error) {
        return toolError(
          `Failed to restore transaction${deleted.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}
