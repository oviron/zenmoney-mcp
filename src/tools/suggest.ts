import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenMoneyAPI } from "../api.js";
import type { ZenState } from "../state.js";
import { toolError, toolText } from "../lib/result.js";

export function registerSuggestTools(
  server: McpServer,
  api: ZenMoneyAPI,
  state: ZenState
) {
  server.registerTool(
    "suggest_category",
    {
      title: "Suggest Category",
      description: "Get ZenMoney's auto-suggestion for category and merchant based on a payee name. Useful for categorizing receipts.",
      inputSchema: {
        payee: z.string().describe("The payee/merchant name from the receipt"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async ({ payee }) => {
      try {
        const results = await api.suggest([{ payee }]);
        const suggestion = results[0];

        if (!suggestion) {
          return toolText(`No suggestions found for "${payee}".`);
        }

        const parts: string[] = [`Suggestions for "${payee}":`];

        if (suggestion.tag && suggestion.tag.length > 0) {
          const tagNames = suggestion.tag
            .map((tagId) => {
              const tag = state.tags.find((t) => t.id === tagId);
              return tag ? `${tag.title} (\`${tag.id}\`)` : `\`${tagId}\``;
            })
            .join(", ");
          parts.push(`- Category: ${tagNames}`);
        }

        if (suggestion.merchant) {
          const merchant = state.merchants.find(
            (m) => m.id === suggestion.merchant
          );
          const name = merchant ? merchant.title : suggestion.merchant;
          parts.push(`- Merchant: ${name}`);
        }

        if (suggestion.payee) {
          parts.push(`- Normalized payee: ${suggestion.payee}`);
        }

        return toolText(parts.join("\n"));
      } catch (error) {
        return toolError(`Suggest failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );
}
