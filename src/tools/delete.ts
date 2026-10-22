import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transaction } from "../api.js";
import type { ZenState } from "../state.js";
import { formatTransactionLine } from "../lib/format.js";
import { notSyncedError, toolError, toolText } from "../lib/result.js";

export function registerDeleteTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "delete_transaction",
    {
      title: "Delete Transaction",
      description: "Delete one or more transactions by id. This cannot be undone: ZenMoney does not let a deleted transaction be restored, so putting an operation back means adding it again as a new transaction. Ids come from list_transactions. Sync must be done first.",
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
      if (!state.isSynced) {
        return notSyncedError();
      }

      if (confirm !== true) {
        return toolError(
          "Refusing to delete without confirm: true. Deleting cannot be undone."
        );
      }

      const ids = Array.from(
        new Set((Array.isArray(id) ? id : [id]).map((v) => v.trim()))
      ).filter((v) => v !== "");
      if (ids.length === 0) {
        return toolError("No transaction id given.");
      }

      const user = state.getUser();
      if (!user) {
        return toolError("User not found. Run sync_data first.");
      }

      const doomed: Transaction[] = [];
      const missing: string[] = [];
      for (const txId of ids) {
        const tx = state.findTransaction(txId);
        if (tx) doomed.push(tx);
        else missing.push(txId);
      }
      if (missing.length > 0) {
        return toolError(
          `Transaction${missing.length > 1 ? "s" : ""} not found: ${missing.join(", ")}. Nothing was deleted. Use list_transactions to find ids, or run sync_data if the transaction was added elsewhere.`
        );
      }

      const now = Math.floor(Date.now() / 1000);

      try {
        await state.write({
          deletion: doomed.map((tx) => ({
            id: tx.id,
            object: "transaction",
            stamp: now,
            user: user.id,
          })),
        });

        const lines = doomed.map((tx) => `- ${formatTransactionLine(state, tx)}`);
        return toolText(
          `${doomed.length === 1 ? "Transaction deleted" : `${doomed.length} transactions deleted`}:\n\n${lines.join("\n")}\n\nThis cannot be undone. To put an operation back, add it again as a new transaction.`
        );
      } catch (error) {
        return toolError(
          `Failed to delete transaction${doomed.length > 1 ? "s" : ""}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
}
