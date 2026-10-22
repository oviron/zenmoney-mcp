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
import { registerBudgetTools } from "./tools/budgets.js";
import { registerDebtTools } from "./tools/debts.js";
import { registerReminderTools } from "./tools/reminders.js";

export function createServer(
  api: ZenMoneyAPI,
  state: ZenState,
  options: { readOnly?: boolean } = {}
) {
  const server = new McpServer({
    name: "zenmoney-mcp",
    version: "0.4.1-oviron.1",
  });

  if (options.readOnly ?? readOnlyFromEnv()) onlyReadOnlyTools(server);
  syncBeforeEachTool(server, state, ["sync_data"]);
  registerSyncTools(server, state);
  registerAccountTools(server, state);
  registerCategoryTools(server, state);
  registerTransactionTools(server, state);
  registerDebtTools(server, state);
  registerSuggestTools(server, api, state);
  registerSummaryTools(server, state);
  registerReminderTools(server, state);
  registerBudgetTools(server, state);

  return server;
}

/**
 * Leave out every tool that can change data in ZenMoney, for clients such
 * as chat bots that should only read. sync_data stays: it changes only the
 * local cache.
 */
function onlyReadOnlyTools(server: McpServer) {
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: { annotations?: { readOnlyHint?: boolean } }, handler: unknown) =>
    config.annotations?.readOnlyHint === true
      ? (register as (...args: unknown[]) => unknown)(name, config, handler)
      : undefined) as typeof server.registerTool;
}

function readOnlyFromEnv(): boolean {
  return ["1", "true", "yes"].includes(process.env.ZENMONEY_READ_ONLY?.trim().toLowerCase() ?? "");
}
