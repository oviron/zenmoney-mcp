import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ZenMoneyAPI,
  apiBaseFromEnv,
  ZenMoneyAuthError,
  ZenMoneyError,
  validateDiffResponse,
} from "../src/api.js";

const OK_DIFF = { serverTimestamp: 1700000000, account: [] };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function mockFetch(...answers: (Response | Error)[]) {
  const fn = vi.fn();
  for (const a of answers) {
    if (a instanceof Error) fn.mockRejectedValueOnce(a);
    else fn.mockResolvedValueOnce(a);
  }
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("ZenMoneyAPI", () => {
  it("sends the token and returns the diff", async () => {
    const fetch = mockFetch(jsonResponse(OK_DIFF));
    const resp = await new ZenMoneyAPI("secret").diff({
      currentClientTimestamp: 1,
      serverTimestamp: 0,
    });
    expect(resp.serverTimestamp).toBe(1700000000);
    expect(resp.transaction).toEqual([]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.zenmoney.ru/v8/diff/");
    expect(init.headers.Authorization).toBe("Bearer secret");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends requests to the configured domain", async () => {
    const fetch = mockFetch(jsonResponse(OK_DIFF));
    await new ZenMoneyAPI("secret", undefined, "https://api.zenmoney.app").diff({
      currentClientTimestamp: 1,
      serverTimestamp: 0,
    });
    expect(fetch.mock.calls[0][0]).toBe("https://api.zenmoney.app/v8/diff/");
  });

  it("takes only ZenMoney's own domains from ZENMONEY_API_URL", () => {
    vi.stubEnv("ZENMONEY_API_URL", undefined);
    expect(apiBaseFromEnv()).toBe("https://api.zenmoney.ru");
    vi.stubEnv("ZENMONEY_API_URL", "https://api.zenmoney.app");
    expect(apiBaseFromEnv()).toBe("https://api.zenmoney.app");
    expect(apiBaseFromEnv(" ")).toBe("https://api.zenmoney.ru");
    expect(apiBaseFromEnv("https://api.zenmoney.app/")).toBe("https://api.zenmoney.app");
    expect(() => apiBaseFromEnv("https://evil.example")).toThrow("ZENMONEY_API_URL must be one of");
    expect(() => apiBaseFromEnv("http://api.zenmoney.app")).toThrow();
  });

  it("explains a rejected token without echoing it", async () => {
    mockFetch(jsonResponse({ error: "invalid_token" }, 401));
    const err = await new ZenMoneyAPI("secret")
      .diff({ currentClientTimestamp: 1, serverTimestamp: 0 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ZenMoneyAuthError);
    expect(err.message).toContain("HTTP 401");
    expect(err.message).toContain("zerro.app/token");
    expect(err.message).not.toContain("secret");
    expect(err.uncertain).toBe(false);
  });

  it("retries 503 and a dropped connection, then succeeds", async () => {
    vi.useFakeTimers();
    const fetch = mockFetch(
      new TypeError("fetch failed"),
      jsonResponse({}, 503, { "Retry-After": "0" }),
      jsonResponse(OK_DIFF)
    );
    const pending = new ZenMoneyAPI("t").diff({ currentClientTimestamp: 1, serverTimestamp: 0 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ serverTimestamp: 1700000000 });
    expect(fetch).toHaveBeenCalledTimes(3);
    // The same body every time
    expect(fetch.mock.calls[2][1].body).toBe(fetch.mock.calls[0][1].body);
  });

  it("gives up after the retries with an uncertain error", async () => {
    vi.useFakeTimers();
    mockFetch(
      jsonResponse({}, 502),
      jsonResponse({}, 502),
      new Response("<html>Bad   gateway</html>", { status: 502 })
    );
    const pending = new ZenMoneyAPI("t")
      .diff({ currentClientTimestamp: 1, serverTimestamp: 0 })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await pending;
    expect(err).toBeInstanceOf(ZenMoneyError);
    expect(err.uncertain).toBe(true);
    expect(err.message).toBe("ZenMoney API error 502: <html>Bad gateway</html>");
  });

  it("does not retry a client error and shortens a long body", async () => {
    const fetch = mockFetch(new Response("x".repeat(1000), { status: 400 }));
    const err = await new ZenMoneyAPI("t")
      .diff({ currentClientTimestamp: 1, serverTimestamp: 0 })
      .catch((e) => e);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(err.uncertain).toBe(false);
    expect(err.message.length).toBeLessThan(340);
    expect(err.message).toMatch(/x…$/);
  });

  it("times out a request that never answers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason))
          )
      )
    );
    const err = await new ZenMoneyAPI("t", 20)
      .diff({ currentClientTimestamp: 1, serverTimestamp: 0 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ZenMoneyError);
    expect(err.uncertain).toBe(true);
    expect(err.message).toContain("did not answer");
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) =>
            init.signal!.addEventListener("abort", () => reject(init.signal!.reason))
          )
      )
    );
    const pending = new ZenMoneyAPI("t")
      .diff({ currentClientTimestamp: 1, serverTimestamp: 0 }, { signal: controller.signal })
      .catch((e) => e);
    controller.abort();
    expect((await pending).message).toContain("cancelled");
  });

  it("keeps an earlier unknown outcome when a later attempt is rejected", async () => {
    vi.useFakeTimers();
    mockFetch(jsonResponse({}, 502), jsonResponse({ error: "invalid_token" }, 401));
    const pending = new ZenMoneyAPI("t")
      .diff({ currentClientTimestamp: 1, serverTimestamp: 0 })
      .catch((e) => e);
    await vi.runAllTimersAsync();
    const err = await pending;
    expect(err).toBeInstanceOf(ZenMoneyAuthError);
    expect(err.uncertain).toBe(true);
  });

  it("keeps retrying when the dropped body cannot be released", async () => {
    vi.useFakeTimers();
    const broken = new Response("busy", { status: 503 });
    Object.defineProperty(broken, "body", {
      value: { cancel: () => Promise.reject(new TypeError("terminated")) },
    });
    const fetch = mockFetch(broken, jsonResponse(OK_DIFF));
    const pending = new ZenMoneyAPI("t").diff({ currentClientTimestamp: 1, serverTimestamp: 0 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({ serverTimestamp: 1700000000 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("treats an answer cut off after 200 as an unknown outcome", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("terminated"));
      },
    });
    mockFetch(new Response(stream, { status: 200 }));
    const err = await new ZenMoneyAPI("t")
      .diff({ currentClientTimestamp: 1, serverTimestamp: 0 })
      .catch((e) => e);
    expect(err.message).toContain("cut off");
    expect(err.uncertain).toBe(true);
  });

  it("treats a malformed diff after 200 as an unknown outcome", async () => {
    mockFetch(jsonResponse({ account: [] }));
    const err = await new ZenMoneyAPI("t")
      .diff({ currentClientTimestamp: 1, serverTimestamp: 0 })
      .catch((e) => e);
    expect(err.message).toContain("no serverTimestamp");
    expect(err.uncertain).toBe(true);
  });

  it("rejects a body that is not JSON", async () => {
    mockFetch(new Response("<html>", { status: 200 }));
    await expect(
      new ZenMoneyAPI("t").diff({ currentClientTimestamp: 1, serverTimestamp: 0 })
    ).rejects.toMatchObject({ message: expect.stringContaining("not JSON"), uncertain: true });
  });
});

describe("validateDiffResponse", () => {
  it("fills in the arrays the server left out", () => {
    const resp = validateDiffResponse({ serverTimestamp: 5 });
    expect(resp.account).toEqual([]);
    expect(resp.deletion).toEqual([]);
  });

  it.each([
    [null, "not an object"],
    [{}, "no serverTimestamp"],
    [{ serverTimestamp: 5, account: {} }, "account is not a list"],
    [{ serverTimestamp: 5, account: [null] }, "account holds a non-object"],
    [{ serverTimestamp: 5, transaction: [{ income: 1 }] }, "transaction item without id"],
    [{ serverTimestamp: 5, deletion: [{ id: "x" }] }, "deletion item without object"],
  ])("rejects %j", (resp, why) => {
    expect(() => validateDiffResponse(resp)).toThrow(why);
  });

  it("accepts budgets, which have no id", () => {
    expect(() =>
      validateDiffResponse({ serverTimestamp: 5, budget: [{ tag: null, date: "2026-10-01" }] })
    ).not.toThrow();
  });
});
