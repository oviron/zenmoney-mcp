import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenMoneyAPI } from "./api.js";
import type { ZenState } from "./state.js";
import { registerSyncTools } from "./tools/sync.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerSuggestTools } from "./tools/suggest.js";
import { syncBeforeEachTool } from "./lib/fresh.js";
import { registerSummaryTools } from "./tools/summaries.js";

export function createServer(api: ZenMoneyAPI, state: ZenState) {
  const server = new McpServer({
    name: "zenmoney-mcp",
    version: "0.4.1-oviron.1",
  });

  syncBeforeEachTool(server, state, ["sync_data"]);
  registerSyncTools(server, state);
  registerAccountTools(server, state);
  registerCategoryTools(server, state);
  registerTransactionTools(server, state);
  registerSuggestTools(server, api, state);
  registerSummaryTools(server, state);

  return server;
}
