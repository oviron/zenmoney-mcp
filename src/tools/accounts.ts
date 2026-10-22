import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { toolText } from "../lib/result.js";

const accountSchema = z.object({
  id: z.string(), title: z.string(), type: z.string(),
  balance: z.number().nullable().describe("Null when the balance is unknown"),
  currency: z.string().nullable().describe("Currency shortTitle, or null when unknown"),
  bank: z.string().nullable(), archived: z.boolean(),
});

export function registerAccountTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "list_accounts",
    {
      title: "List Accounts",
      description: "List all user accounts (wallets, cards, cash), with balance and currency. Unavailable balances are marked unknown.",
      inputSchema: {
        include_archived: z
          .boolean()
          .optional()
          .default(false)
          .describe("Include archived accounts"),
      },
      outputSchema: { accounts: z.array(accountSchema) },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ include_archived }) => {

      const accounts = include_archived
        ? state.getVisibleAccounts()
        : state.getActiveAccounts();

      const rows: z.infer<typeof accountSchema>[] = [];
      const lines = accounts.map((a) => {
        const instr = a.instrument
          ? state.getInstrument(a.instrument)
          : null;
        const currency = instr
          ? `${instr.shortTitle} (${instr.title}, ${instr.symbol})`
          : "???";
        const balance = a.balance ?? "unknown";
        const company = a.company
          ? state.getCompany(a.company)
          : null;
        const bankName = company?.title ?? null;
        rows.push({ id: a.id, title: a.title, type: a.type, balance: a.balance ?? null, currency: instr?.shortTitle ?? null, bank: bankName, archived: a.archive });
        return `- **${a.title}** [${a.type}] — ${balance} ${currency}${bankName ? ` | Bank: ${bankName}` : ""}${a.archive ? " (archived)" : ""}  \n  id: \`${a.id}\``;
      });

      return { ...toolText(
        lines.length > 0
          ? `Accounts (${lines.length}):\n\n${lines.join("\n")}`
          : "No accounts found."
      ), structuredContent: { accounts: rows } };
    }
  );
}
