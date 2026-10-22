import { describe, it, expect, vi } from "vitest";
import { ZenState } from "../src/state.js";
import { ZenMoneyError, type ZenMoneyAPI } from "../src/api.js";
import { makeDiffResponse, makeTransaction } from "./fixtures.js";

function setup() {
  const api = {
    diff: vi.fn().mockResolvedValue(makeDiffResponse()),
    suggest: vi.fn(),
  } as unknown as ZenMoneyAPI;
  return { api, state: new ZenState(api) };
}

describe("write outcome", () => {
  it("names the ids when the server may have saved the change", async () => {
    const { api, state } = setup();
    await state.sync();
    const before = state.serverTimestamp;
    const tx = makeTransaction({ id: "tx-new" });
    vi.mocked(api.diff).mockRejectedValueOnce(
      new ZenMoneyError("ZenMoney API did not answer within 30s.", true)
    );

    const err = await state.write({ transaction: [tx] }).catch((e) => e);
    expect(err).toBeInstanceOf(ZenMoneyError);
    expect(err.uncertain).toBe(true);
    expect(err.message).toContain("may or may not have been saved");
    expect(err.message).toContain("tx-new");
    expect(err.message).toContain("Do not repeat the call");
    expect(state.serverTimestamp).toBe(before);
    expect(state.findTransaction("tx-new")).toBeUndefined();
  });

  it("passes a definite rejection through unchanged", async () => {
    const { api, state } = setup();
    await state.sync();
    vi.mocked(api.diff).mockRejectedValueOnce(new ZenMoneyError("ZenMoney API error 400: bad", false));
    await expect(
      state.write({ transaction: [makeTransaction({ id: "tx-new" })] })
    ).rejects.toThrow("ZenMoney API error 400: bad");
  });

  it("finds a write that did land on the next sync", async () => {
    const { api, state } = setup();
    await state.sync();
    const tx = makeTransaction({ id: "tx-landed" });
    vi.mocked(api.diff).mockRejectedValueOnce(new ZenMoneyError("timeout", true));
    await state.write({ transaction: [tx] }).catch(() => undefined);

    vi.mocked(api.diff).mockResolvedValueOnce(
      makeDiffResponse({ serverTimestamp: 1700000100, transaction: [tx] })
    );
    await state.sync();
    expect(state.findTransaction("tx-landed")).toBeDefined();
  });
});
