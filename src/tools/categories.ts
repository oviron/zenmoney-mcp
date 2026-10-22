import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { toolText } from "../lib/result.js";

export function registerCategoryTools(server: McpServer, state: ZenState) {
  server.registerTool(
    "list_categories",
    {
      title: "List Categories",
      description: "List all expense/income categories (tags) with their hierarchy.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {

      const hierarchy = state.getTagHierarchy();
      const lines: string[] = [];

      for (const { parent, children } of hierarchy) {
        const flags: string[] = [];
        if (parent.showOutcome) flags.push("expense");
        if (parent.showIncome) flags.push("income");
        lines.push(
          `- **${parent.title}** (${flags.join(", ")}) — id: \`${parent.id}\``
        );
        for (const child of children) {
          lines.push(`  - ${child.title} — id: \`${child.id}\``);
        }
      }

      return toolText(
        lines.length > 0
          ? `Categories (${state.tags.length}):\n\n${lines.join("\n")}`
          : "No categories found."
      );
    }
  );

  server.registerTool(
    "list_merchants",
    {
      title: "List Merchants",
      description: "List known merchants/payees.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async () => {

      const lines = state.merchants.map(
        (m) => `- **${m.title}** — id: \`${m.id}\``
      );

      return toolText(
        lines.length > 0
          ? `Merchants (${lines.length}):\n\n${lines.join("\n")}`
          : "No merchants found."
      );
    }
  );
}
