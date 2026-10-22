import { describe, it, expect, afterEach, vi } from "vitest";
import { CHECKING, makeDiffResponse } from "./fixtures.js";
import { createSyncedState, createMcpPair, connectPair, getTextContent } from "./helpers.js";

const ZERRO = { ...CHECKING, id: "acc-zerro", title: "🤖 [Zerro Data]", balance: 0 };

async function toolNames(options?: { readOnly?: boolean }) {
  const { api, state } = await createSyncedState();
  const pair = await createMcpPair(api, state, options);
  await connectPair(pair);
  return (await pair.client.listTools()).tools.map((t) => t.name).sort();
}

describe("read-only mode", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("registers only tools that read", async () => {
    const all = await toolNames({ readOnly: false });
    const readOnly = await toolNames({ readOnly: true });
    expect(all).toContain("add_expense");
    expect(readOnly).toContain("sync_data");
    expect(readOnly).toContain("list_transactions");
    for (const name of ["add_expense", "add_income", "add_transfer", "add_debt", "update_transaction", "delete_transaction", "restore_transaction"]) {
      expect(readOnly).not.toContain(name);
    }
    expect(readOnly.length).toBeGreaterThan(0);
  });

  it.each([["true", true], ["1", true], ["YES", true], ["", false], ["no", false]])(
    "reads ZENMONEY_READ_ONLY=%s",
    async (value, readOnly) => {
      vi.stubEnv("ZENMONEY_READ_ONLY", value);
      expect((await toolNames()).includes("add_expense")).toBe(!readOnly);
    }
  );
});

describe("zerro's service account", () => {
  async function setup() {
    const { api, state } = await createSyncedState(
      makeDiffResponse({ account: [CHECKING, ZERRO] })
    );
    const pair = await createMcpPair(api, state);
    await connectPair(pair);
    return (name: string, args: Record<string, unknown>) =>
      pair.client.callTool({ name, arguments: args });
  }

  it("is left out of list_accounts, archived ones included", async () => {
    const call = await setup();
    for (const include_archived of [false, true]) {
      const text = getTextContent(await call("list_accounts", { include_archived }));
      expect(text).toContain("Checking");
      expect(text).not.toContain("Zerro");
    }
  });

  it("cannot be used for an operation", async () => {
    const call = await setup();
    const result = await call("add_expense", { account: "🤖 [Zerro Data]", amount: 5, date: "2026-03-20" });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("not found");
  });
});
