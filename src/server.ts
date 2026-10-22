import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenMoneyAPI } from "./api.js";
import type { ZenState } from "./state.js";
import { registerSyncTools } from "./tools/sync.js";
import { registerAccountTools } from "./tools/accounts.js";
import { registerCategoryTools } from "./tools/categories.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerSuggestTools } from "./tools/suggest.js";

export function createServer(api: ZenMoneyAPI, state: ZenState) {
  const server = new McpServer({
    name: "zenmoney-mcp",
    version: "0.4.1-oviron.1",
  });

  registerSyncTools(server, state);
  registerAccountTools(server, state);
  registerCategoryTools(server, state);
  registerTransactionTools(server, state);
  registerSuggestTools(server, api, state);

  return server;
}
