import { describe, it, expect, vi } from "vitest";
import { ZenState } from "../src/state.js";
import type { DiffResponse, ZenMoneyAPI } from "../src/api.js";
import { makeDiffResponse, makeTransaction } from "./fixtures.js";
import { createMcpPair, connectPair, getTextContent } from "./helpers.js";

const LIVE = makeTransaction({ id: "tx-live", outcome: 50, date: "2026-03-20", created: 500 });
const GONE = makeTransaction({
  id: "tx-gone",
  outcome: 70,
  date: "2026-03-18",
  created: 600,
  payee: "Taxi",
  deleted: true,
});

function empty(serverTimestamp: number, overrides: Partial<DiffResponse> = {}) {
  return makeDiffResponse({
    serverTimestamp,
    instrument: [],
    company: [],
    user: [],
    account: [],
    tag: [],
    merchant: [],
    ...overrides,
  });
}

async function setup(transactions = [LIVE, GONE]) {
  const api = {
    diff: vi.fn().mockResolvedValueOnce(makeDiffResponse({ transaction: transactions })),
    suggest: vi.fn().mockResolvedValue([]),
  } as unknown as ZenMoneyAPI;
  const state = new ZenState(api);
  await state.sync();
  vi.mocked(api.diff).mockResolvedValue(empty(1700000001));
  const pair = await createMcpPair(api, state);
  await connectPair(pair);
  const call = (name: string, args: Record<string, unknown>) =>
    pair.client.callTool({ name, arguments: args });
  return { api, state, call };
}

describe("restore_transaction", () => {
  it("brings a deleted transaction back as a copy with a new id", async () => {
    const { api, state, call } = await setup();
    const result = await call("restore_transaction", { id: "tx-gone" });
    expect(result.isError).toBeFalsy();
    const sent = vi.mocked(api.diff).mock.calls[1][0].transaction!;
    expect(sent).toHaveLength(1);
    const { changed: _changed, ...rest } = GONE;
    expect(sent[0]).toMatchObject({ ...rest, id: expect.any(String), deleted: false, reminderMarker: null });
    expect(sent[0].id).not.toBe("tx-gone");
    expect(sent[0].changed).toBeGreaterThan(GONE.changed);
    expect(state.findTransaction(sent[0].id)).toBeDefined();
    expect(state.findDeletedTransaction("tx-gone")).toBeDefined();
    expect(getTextContent(result)).toContain("Transaction restored");
    expect(getTextContent(result)).toContain("(restored from tx-gone)");
  });

  it("does not copy a transaction twice", async () => {
    const { api, call } = await setup();
    await call("restore_transaction", { id: "tx-gone" });
    const result = await call("restore_transaction", { id: "tx-gone" });
    expect(api.diff).toHaveBeenCalledTimes(2);
    expect(getTextContent(result)).toMatch(/Nothing to restore:\n\n- tx-gone is already back as [0-9a-f-]{36}/);
  });

  it("round-trips with delete_transaction", async () => {
    const { state, call } = await setup([LIVE]);
    await call("delete_transaction", { id: "tx-live", confirm: true });
    expect(state.findTransaction("tx-live")).toBeUndefined();
    const result = await call("restore_transaction", { id: "tx-live" });
    expect(result.isError).toBeFalsy();
    expect(state.transactions).toHaveLength(1);
    expect(state.transactions[0]).toMatchObject({ outcome: 50, date: "2026-03-20", deleted: false });
  });

  it.each([
    ["tx-live", "is not deleted"],
    ["tx-unknown", "No deleted transaction tx-unknown"],
  ])("refuses %s", async (id, message) => {
    const { api, call } = await setup();
    const result = await call("restore_transaction", { id: ["tx-gone", id] });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain(message);
    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it("refuses a transaction whose account is gone", async () => {
    const { api, call } = await setup([
      { ...GONE, outcomeAccount: "acc-closed", incomeAccount: "acc-closed" },
    ]);
    const result = await call("restore_transaction", { id: "tx-gone" });
    expect(getTextContent(result)).toContain("account acc-closed, which no longer exists");
    expect(api.diff).toHaveBeenCalledTimes(1);
  });
});

describe("delete_transaction", () => {
  it("says when a transaction is already deleted", async () => {
    const { call } = await setup();
    const result = await call("delete_transaction", { id: "tx-gone", confirm: true });
    expect(getTextContent(result)).toBe("Already deleted: tx-gone. Nothing was deleted.");
  });
});
