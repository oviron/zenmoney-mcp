const API_BASE = "https://api.zenmoney.ru";

export interface DiffRequest {
  currentClientTimestamp: number;
  serverTimestamp: number;
  forceFetch?: string[];
  instrument?: any[];
  company?: any[];
  user?: any[];
  account?: any[];
  tag?: any[];
  merchant?: any[];
  budget?: any[];
  reminder?: any[];
  reminderMarker?: any[];
  transaction?: any[];
  deletion?: any[];
}

export interface DiffResponse {
  serverTimestamp: number;
  instrument: Instrument[];
  company: any[];
  user: User[];
  account: Account[];
  tag: Tag[];
  merchant: Merchant[];
  budget: any[];
  reminder: any[];
  reminderMarker: any[];
  transaction: Transaction[];
  deletion: any[];
}

export interface Instrument {
  id: number;
  changed: number;
  title: string;
  shortTitle: string;
  symbol: string;
  rate: number;
}

export interface User {
  id: number;
  changed: number;
  login: string;
  currency: number;
  parent: number | null;
  country: number;
  countryCode: string;
  email: string;
}

export interface Account {
  id: string;
  changed: number;
  user: number;
  instrument: number | null;
  company: number | null;
  type: string;
  title: string;
  syncID: string[] | null;
  balance: number | null;
  startBalance: number | null;
  creditLimit: number | null;
  inBalance: boolean;
  savings: boolean | null;
  enableCorrection: boolean;
  enableSMS: boolean;
  archive: boolean;
  private: boolean;
}

export interface Tag {
  id: string;
  changed: number;
  user: number;
  title: string;
  parent: string | null;
  icon: string | null;
  picture: string | null;
  color: number | null;
  showIncome: boolean;
  showOutcome: boolean;
  budgetIncome: boolean;
  budgetOutcome: boolean;
  required: boolean | null;
}

export interface Merchant {
  id: string;
  changed: number;
  user: number;
  title: string;
}

export interface Company {
  id: number;
  changed: number;
  title: string;
  country: number | null;
  fullTitle: string | null;
  www: string | null;
}

export interface Transaction {
  id: string;
  changed: number;
  created: number;
  user: number;
  deleted: boolean;
  hold: boolean | null;
  viewed: boolean;
  incomeInstrument: number;
  incomeAccount: string;
  income: number;
  incomeBankID: string | null;
  outcomeInstrument: number;
  outcomeAccount: string;
  outcome: number;
  outcomeBankID: string | null;
  opIncome: number | null;
  opIncomeInstrument: number | null;
  opOutcome: number | null;
  opOutcomeInstrument: number | null;
  tag: string[] | null;
  merchant: string | null;
  payee: string | null;
  originalPayee: string | null;
  comment: string | null;
  date: string;
  mcc: number | null;
  latitude: number | null;
  longitude: number | null;
  reminderMarker: string | null;
  qrCode: string | null;
}

export interface SuggestRequest {
  payee?: string;
  merchant?: string;
}

export interface SuggestResponse {
  tag?: string[] | null;
  merchant?: string | null;
  payee?: string | null;
}

/** Any failure talking to the ZenMoney API. */
export class ZenMoneyError extends Error {
  override name = "ZenMoneyError";
  /**
   * True when the server may have processed the request even though no
   * usable answer came back: a timeout, a dropped connection or a 5xx.
   * A rejected request (4xx) or a malformed answer is not uncertain.
   */
  readonly uncertain: boolean;

  constructor(message: string, uncertain = false) {
    super(message);
    this.uncertain = uncertain;
  }
}

/** The API rejected the token (HTTP 401 or 403). */
export class ZenMoneyAuthError extends ZenMoneyError {
  override name = "ZenMoneyAuthError";
}

export interface RequestOptions {
  /**
   * Retry a dropped connection, 429 and 502-504 a couple of times, sending
   * the same body again. Safe for reads, and for writes whose objects carry
   * client-made ids and `changed`: the server takes the same object twice
   * as one, so a retry cannot create a duplicate.
   */
  retry?: boolean;
  /** Cancels the request, e.g. when the MCP client cancels the tool call. */
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [500, 2000];
const MAX_RETRY_AFTER_MS = 10_000;
const ERROR_BODY_LIMIT = 300;

export const TOKEN_HELP = "Get a fresh token at https://zerro.app/token and set ZENMONEY_TOKEN.";

export class ZenMoneyAPI {
  private token: string;
  private timeoutMs: number;

  constructor(token: string, timeoutMs = defaultTimeoutMs()) {
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  private async request<T>(
    path: string,
    body: unknown,
    { retry = false, signal }: RequestOptions = {}
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      let response: Response;
      try {
        response = await fetch(`${API_BASE}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (signal?.aborted) {
          throw new ZenMoneyError("Request to ZenMoney was cancelled.", true);
        }
        if (timeout.aborted) {
          throw new ZenMoneyError(
            `ZenMoney API did not answer within ${Math.round(this.timeoutMs / 1000)}s.`,
            true
          );
        }
        if (retry && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt], signal);
          continue;
        }
        throw new ZenMoneyError(
          `Cannot reach ZenMoney API: ${error instanceof Error ? error.message : String(error)}`,
          true
        );
      }

      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch {
          throw new ZenMoneyError("ZenMoney API returned a response that is not JSON.");
        }
      }

      if (retry && RETRYABLE_STATUS.has(response.status) && attempt < RETRY_DELAYS_MS.length) {
        await response.body?.cancel();
        await sleep(retryAfterMs(response) ?? RETRY_DELAYS_MS[attempt], signal);
        continue;
      }

      const detail = shorten(await response.text().catch(() => ""));
      const suffix = detail ? `: ${detail}` : "";
      if (response.status === 401 || response.status === 403) {
        throw new ZenMoneyAuthError(
          `ZenMoney rejected the token (HTTP ${response.status})${suffix}. ${TOKEN_HELP}`
        );
      }
      throw new ZenMoneyError(
        `ZenMoney API error ${response.status}${suffix}`,
        response.status >= 500
      );
    }
  }

  /**
   * Retries by default: every object in a diff carries its own id and
   * `changed`, so sending the same diff twice cannot duplicate anything.
   */
  async diff(req: DiffRequest, options?: RequestOptions): Promise<DiffResponse> {
    const resp = await this.request<unknown>("/v8/diff/", req, {
      retry: true,
      ...options,
    });
    return validateDiffResponse(resp);
  }

  async suggest(
    items: SuggestRequest[],
    options?: RequestOptions
  ): Promise<SuggestResponse[]> {
    const resp = await this.request<unknown>("/v8/suggest/", items, {
      retry: true,
      ...options,
    });
    if (!Array.isArray(resp)) {
      throw new ZenMoneyError("ZenMoney API returned an unexpected suggest response.");
    }
    return resp as SuggestResponse[];
  }
}

const DIFF_ARRAYS = [
  "instrument",
  "company",
  "user",
  "account",
  "tag",
  "merchant",
  "budget",
  "reminder",
  "reminderMarker",
  "transaction",
] as const;

/**
 * Check the shape of a /v8/diff/ answer before any of it touches local
 * state, so a malformed answer cannot wipe the cache or move
 * serverTimestamp past changes that were never applied. Missing arrays are
 * normal (the server omits what did not change) and become empty ones.
 */
export function validateDiffResponse(resp: unknown): DiffResponse {
  const bad = (what: string) =>
    new ZenMoneyError(`ZenMoney API returned an unexpected diff response: ${what}.`);
  if (!resp || typeof resp !== "object" || Array.isArray(resp)) throw bad("not an object");
  const r = resp as Record<string, unknown>;
  if (typeof r.serverTimestamp !== "number" || !Number.isFinite(r.serverTimestamp)) {
    throw bad("no serverTimestamp");
  }
  for (const key of [...DIFF_ARRAYS, "deletion"]) {
    const value = r[key];
    if (value === undefined || value === null) {
      r[key] = [];
      continue;
    }
    if (!Array.isArray(value)) throw bad(`${key} is not a list`);
    for (const item of value) {
      if (!item || typeof item !== "object") throw bad(`${key} holds a non-object`);
      // Budgets are keyed by month and category, not by id
      if (key !== "budget" && (item as { id?: unknown }).id == null) {
        throw bad(`${key} item without id`);
      }
      if (key === "deletion" && typeof (item as { object?: unknown }).object !== "string") {
        throw bad("deletion item without object");
      }
    }
  }
  return r as unknown as DiffResponse;
}

function defaultTimeoutMs(): number {
  const fromEnv = Number(process.env.ZENMONEY_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - Date.now(), 0), MAX_RETRY_AFTER_MS);
}

/** One line of the error body, short enough for a tool result. */
function shorten(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > ERROR_BODY_LIMIT ? `${line.slice(0, ERROR_BODY_LIMIT)}…` : line;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ZenMoneyError("Request to ZenMoney was cancelled.", true));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ZenMoneyError("Request to ZenMoney was cancelled.", true));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
