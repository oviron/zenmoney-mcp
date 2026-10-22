import { z } from "zod";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transaction } from "../api.js";
import type { ZenState } from "../state.js";
import { formatTransactionLine, serverVersionWarning } from "../lib/format.js";
import { toolError, toolText } from "../lib/result.js";

const RESTORE_NAMESPACE = "6c81820a-88a2-4191-89a0-7fce026d48cb";

/**
 * Id of the copy restore_transaction makes of a deleted transaction: a
 * name-based UUID (version 5) of the original id. Anyone restoring the same
 * transaction, in parallel or later, arrives at the same copy, and the link
 * survives edits to the copy.
 */
export function restoredCopyId(id: string): string {
  const hash = createHash("sha1")
    .update(Buffer.from(RESTORE_NAMESPACE.replace(/-/g, ""), "hex"))
    .update(id)
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Thrown from a write's changes when there turns out to be nothing to send. */
class NothingToSend extends Error {}

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

      // Reads the transactions from state, so it runs once to validate and
      // again at this write's turn: a write queued ahead may have changed
      // or deleted them, and the deleted version must carry the latest fields
      const findDoomed = (): Transaction[] | string => {
        const found: Transaction[] = [];
        const missing: string[] = [];
        for (const txId of ids) {
          const tx = state.findTransaction(txId);
          if (tx) found.push(tx);
          else missing.push(txId);
        }
        const alreadyDeleted = missing.filter((txId) => state.findDeletedTransaction(txId));
        if (alreadyDeleted.length > 0) {
          return `Already deleted: ${alreadyDeleted.join(", ")}. Nothing was deleted.`;
        }
        if (missing.length > 0) {
          return `Transaction${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}. Nothing was deleted. Use list_transactions to find ids, or run sync_data if the transaction was added elsewhere.`;
        }
        return found;
      };

      const checked = findDoomed();
      if (typeof checked === "string") return toolError(checked);
      let doomed = checked;

      try {
        // Marked deleted, not erased with a `deletion` object: that is how
        // the ZenMoney apps delete a transaction, and it keeps the record
        // for show_deleted and restore_transaction
        let marked: Transaction[] = [];
        await state.write(
          () => {
            const fresh = findDoomed();
            if (typeof fresh === "string") throw new Error(fresh);
            doomed = fresh;
            const now = Math.floor(Date.now() / 1000);
            marked = doomed.map((tx) => ({ ...tx, deleted: true, changed: now }));
            return { transaction: marked };
          },
          () => {
            for (const tx of marked) state.upsertTransaction(tx);
          }
        );

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
      description: "Bring back deleted transactions (list_transactions with show_deleted shows them and their ids). ZenMoney does not undelete in place, so each comes back as a copy with a new id derived from the original one; restoring it again, here or in parallel, finds that copy instead of making another.",
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

      type Plan = { copies: { from: string; copy: Transaction }[]; already: string[] };
      // Each deleted transaction leads to its copy's id; a copy that was
      // deleted in turn leads further. The end of that chain is either
      // live (already back) or the one to copy now. Runs again at the
      // write's turn, so a parallel restore of the same id finds the copy.
      const plan = (): Plan | string => {
        const result: Plan = { copies: [], already: [] };
        const now = Math.floor(Date.now() / 1000);
        for (const txId of ids) {
          let tx = state.findDeletedTransaction(txId);
          if (!tx) {
            return state.findTransaction(txId)
              ? `Transaction ${txId} is not deleted. Nothing was restored.`
              : `No deleted transaction ${txId}. Nothing was restored. list_transactions with show_deleted lists deleted ones.`;
          }
          let live: Transaction | undefined;
          for (let hops = 0; hops < 100; hops++) {
            const next = restoredCopyId(tx.id);
            live = state.findTransaction(next);
            if (live) break;
            const deletedCopy = state.findDeletedTransaction(next);
            if (!deletedCopy) break;
            tx = deletedCopy;
          }
          if (live) {
            result.already.push(`- ${txId} is already back as ${live.id}`);
            continue;
          }
          for (const accountId of new Set([tx.outcomeAccount, tx.incomeAccount])) {
            if (!state.accounts.some((a) => a.id === accountId)) {
              return `Transaction ${tx.id} is on account ${accountId}, which no longer exists. Nothing was restored.`;
            }
          }
          if (result.copies.some((c) => c.copy.id === restoredCopyId(tx!.id))) continue;
          result.copies.push({
            from: txId,
            copy: { ...tx, id: restoredCopyId(tx.id), deleted: false, changed: now, reminderMarker: null },
          });
        }
        return result;
      };

      const checked = plan();
      if (typeof checked === "string") return toolError(checked);
      let { copies, already } = checked;

      try {
        try {
          await state.write(
            () => {
              const fresh = plan();
              if (typeof fresh === "string") throw new Error(fresh);
              ({ copies, already } = fresh);
              if (copies.length === 0) throw new NothingToSend();
              return { transaction: copies.map((c) => c.copy) };
            },
            () => {
              for (const { copy } of copies) state.upsertTransaction(copy);
            }
          );
        } catch (error) {
          if (!(error instanceof NothingToSend)) throw error;
        }
        const lines = [
          ...copies.map(
            ({ from, copy }) =>
              `- ${formatTransactionLine(state, state.findTransaction(copy.id) ?? copy)} (restored from ${from})${serverVersionWarning(state, copy, " ")}`
          ),
          ...already,
        ];
        return toolText(
          `${copies.length === 0 ? "Nothing to restore" : copies.length === 1 ? "Transaction restored" : `${copies.length} transactions restored`}:\n\n${lines.join("\n")}`
        );
      } catch (error) {
        return toolError(
          `Failed to restore transaction${ids.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}
