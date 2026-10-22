import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ZenState } from "../src/state.js";
import type { ZenMoneyAPI } from "../src/api.js";
import { createMcpPair, connectPair } from "./helpers.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const { version } = read("package.json");

describe("version", () => {
  it("is the same in package.json, the MCPB manifest and server.json", () => {
    const server = read("server.json");
    expect(read("manifest.json").version).toBe(version);
    expect(server.version).toBe(version);
    for (const p of server.packages) expect(p.version).toBe(version);
  });

  it("is what the server reports", async () => {
    const api = {} as ZenMoneyAPI;
    const pair = await createMcpPair(api, new ZenState(api));
    await connectPair(pair);
    expect(pair.client.getServerVersion()?.version).toBe(version);
  });
});
