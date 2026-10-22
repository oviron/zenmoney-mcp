#!/usr/bin/env node
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ZenMoneyAPI } from "./api.js";
import { ZenState } from "./state.js";
import { createServer } from "./server.js";

const token = process.env.ZENMONEY_TOKEN;
if (!token) {
  console.error(
    "ZENMONEY_TOKEN environment variable is required.\n" +
      "Get your token from https://zerro.app/token and set it in .env"
  );
  process.exit(1);
}

const api = new ZenMoneyAPI(token);
const state = new ZenState(api);

const server = createServer(api, state);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ZenMoney MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
