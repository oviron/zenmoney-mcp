import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { notSyncedError, toolText } from "../lib/result.js";

export function registerAccountTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description: "List all user accounts (wallets, cards, cash). Sync must be done first.",
      inputSchema: {
        include_archived: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include archived accounts"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ include_archived }) => {
      if (!state.isSynced) {
        return notSyncedError();
      }

      const accounts = include_archived
        ? state.accounts
        : state.getActiveAccounts();

      const lines = accounts.map((a) => {
        const instr = a.instrument
          ? state.getInstrument(a.instrument)
          : null;
        const currency = instr
          ? `${instr.shortTitle} (${instr.title}, ${instr.symbol})`
          : "???";
        const balance = a.balance ?? 0;
        const company = a.company
          ? state.getCompany(a.company)
          : null;
        const bankName = company?.title ?? null;
        return `- **${a.title}** [${a.type}] — ${balance} ${currency}${bankName ? ` | Bank: ${bankName}` : ""}${a.archive ? " (archived)" : ""}  \n  id: \`${a.id}\``;
      });

      return toolText(
        lines.length > 0
          ? `Accounts (${lines.length}):\n\n${lines.join("\n")}`
          : "No accounts found."
      );
    }
  );
}
