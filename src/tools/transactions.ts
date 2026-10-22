import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZenState } from "../state.js";
import { registerCreateTools } from "./create.js";
import { registerListTools } from "./list.js";
import { registerUpdateTools } from "./update.js";
import { registerDeleteTools } from "./delete.js";

export function registerTransactionTools(server: McpServer, state: ZenState) {
  registerCreateTools(server, state);
  registerListTools(server, state);
  registerUpdateTools(server, state);
  registerDeleteTools(server, state);
}
