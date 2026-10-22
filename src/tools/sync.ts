import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { toolError, toolText } from "../lib/result.js";

export function registerSyncTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "sync_data",
    {
      title: "Sync Data",
      description: "Refresh data from ZenMoney now. Other tools sync on their own when the data is older than ZENMONEY_SYNC_TTL (30 s by default), so this is only needed to pick up a change made elsewhere a moment ago, or with force_full=true to re-download everything.",
      inputSchema: {
        force_full: z
          .boolean()
          .optional()
          .default(false)
          .describe("Force a full sync instead of incremental"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ force_full }, extra) => {
      try {
        const resp = await state.sync(force_full, extra.signal);
        const summary = {
          accounts: state.accounts.length,
          active_accounts: state.getActiveAccounts().length,
          categories: state.tags.length,
          merchants: state.merchants.length,
          transactions: state.transactions.length,
          currencies: state.instruments.length,
          serverTimestamp: state.serverTimestamp,
        };

        return toolText(`Sync complete. Summary:\n${JSON.stringify(summary, null, 2)}`);
      } catch (error) {
        return toolError(`Sync failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
