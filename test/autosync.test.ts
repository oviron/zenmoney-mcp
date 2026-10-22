import { describe, it, expect, vi, afterEach } from "vitest";
import { ZenState } from "../src/state.js";
import { ZenMoneyError, type ZenMoneyAPI } from "../src/api.js";
import { makeDiffResponse } from "./fixtures.js";
import { createMcpPair, connectPair, getTextContent } from "./helpers.js";

async function setup(syncTtlMs: number) {
  const api = {
    diff: vi.fn().mockResolvedValue(makeDiffResponse()),
    suggest: vi.fn().mockResolvedValue([]),
  } as unknown as ZenMoneyAPI;
  const state = new ZenState(api, { syncTtlMs });
  const pair = await createMcpPair(api, state);
  await connectPair(pair);
  const call = (name: string, args: Record<string, unknown> = {}) =>
    pair.client.callTool({ name, arguments: args });
  return { api, state, call, client: pair.client };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sync before each tool", () => {
  it("loads everything on the first call", async () => {
    const { api, call } = await setup(30_000);
    const result = await call("list_accounts");
    expect(result.isError).toBeFalsy();
    expect(api.diff).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.diff).mock.calls[0][0]).toMatchObject({
      serverTimestamp: 0,
      forceFetch: expect.any(Array),
    });
  });

  it("does not sync again while the data is fresh", async () => {
    const { api, call } = await setup(30_000);
    await call("list_accounts");
    await call("list_categories");
    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it("syncs incrementally once the data is older than the TTL", async () => {
    const { api, call } = await setup(0);
    await call("list_accounts");
    await call("list_accounts");
    expect(api.diff).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.diff).mock.calls[1][0]).toMatchObject({
      serverTimestamp: makeDiffResponse().serverTimestamp,
    });
    expect(vi.mocked(api.diff).mock.calls[1][0]).not.toHaveProperty("forceFetch");
  });

  it("shares one sync between calls that arrive together", async () => {
    const { api, call } = await setup(30_000);
    await Promise.all([call("list_accounts"), call("list_categories"), call("list_merchants")]);
    expect(api.diff).toHaveBeenCalledTimes(1);
  });

  it("passes the call's cancellation signal to the sync", async () => {
    const { api, call } = await setup(30_000);
    await call("list_accounts");
    // The client's request handler signal, not undefined
    await call("sync_data");
    expect(vi.mocked(api.diff).mock.calls[0][1]).toMatchObject({ signal: expect.any(AbortSignal) });
    expect(vi.mocked(api.diff).mock.calls[1][1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });

  it("answers from the cache with a note when ZenMoney cannot be reached", async () => {
    const { api, call } = await setup(0);
    await call("list_accounts");
    vi.mocked(api.diff).mockRejectedValueOnce(
      new ZenMoneyError("Cannot reach ZenMoney API: fetch failed", true)
    );
    const result = await call("list_accounts");
    expect(result.isError).toBeFalsy();
    const text = getTextContent(result);
    expect(text).toContain("Checking");
    expect(text).toMatch(/refreshing from ZenMoney failed \(Cannot reach ZenMoney API: fetch failed\), so this is based on data from \d+ s ago/);
  });

  it("does not write from an old cache when the refresh fails", async () => {
    const { api, call } = await setup(0);
    await call("list_accounts");
    vi.mocked(api.diff).mockRejectedValueOnce(new Error("fetch failed"));
    const result = await call("add_expense", { account: "Checking", amount: 5, date: "2026-03-20" });
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toContain("Nothing was saved");
    expect(api.diff).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.diff).mock.calls[1][0]).not.toHaveProperty("transaction");
  });

  it.each([
    ["the refresh fails", false],
    ["the refresh succeeds", true],
  ])("does not write after the call is cancelled while %s", async (_, succeeds) => {
    const { api, call, client } = await setup(0);
    await call("list_accounts");
    let finish!: () => void;
    vi.mocked(api.diff).mockImplementationOnce(
      (_req, options) =>
        new Promise((resolve, reject) => {
          finish = () => resolve(makeDiffResponse({ serverTimestamp: 1700000001 }));
          options?.signal?.addEventListener("abort", () => {
            if (!succeeds) reject(new ZenMoneyError("Request to ZenMoney was cancelled.", true));
          });
        })
    );
    const controller = new AbortController();
    const pending = client
      .callTool(
        { name: "add_expense", arguments: { account: "Checking", amount: 5, date: "2026-03-20" } },
        undefined,
        { signal: controller.signal }
      )
      .catch(() => undefined);
    await vi.waitFor(() => expect(api.diff).toHaveBeenCalledTimes(2));
    controller.abort();
    await pending;
    await new Promise((r) => setTimeout(r, 10));
    if (succeeds) finish();
    await new Promise((r) => setTimeout(r, 10));
    expect(api.diff).toHaveBeenCalledTimes(2);
  });

  it("fails when there is nothing cached and ZenMoney cannot be reached", async () => {
    const { api, call } = await setup(30_000);
    vi.mocked(api.diff).mockRejectedValueOnce(new Error("fetch failed"));
    const result = await call("list_accounts");
    expect(result.isError).toBe(true);
    expect(getTextContent(result)).toBe("Could not load data from ZenMoney: fetch failed");
  });
});

describe("ZENMONEY_SYNC_TTL", () => {
  it.each([
    [undefined, 30_000],
    ["", 30_000],
    ["junk", 30_000],
    ["-1", 30_000],
    ["0", 0],
    ["120", 120_000],
  ])("%j gives %i ms", (value, ms) => {
    if (value === undefined) vi.stubEnv("ZENMONEY_SYNC_TTL", undefined as unknown as string);
    else vi.stubEnv("ZENMONEY_SYNC_TTL", value);
    expect(new ZenState({} as ZenMoneyAPI).syncTtlMs).toBe(ms);
  });
});
