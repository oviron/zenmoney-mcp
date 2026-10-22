import {
  ZenMoneyAPI,
  ZenMoneyError,
  type Account,
  type Tag,
  type Merchant,
  type Company,
  type Instrument,
  type Transaction,
  type Reminder,
  type ReminderMarker,
  type User,
  type DiffRequest,
  type DiffResponse,
} from "./api.js";

type WriteChanges = Pick<DiffRequest, "transaction" | "reminder" | "reminderMarker" | "deletion">;

export class ZenState {
  private api: ZenMoneyAPI;
  serverTimestamp = 0;
  accounts: Account[] = [];
  tags: Tag[] = [];
  merchants: Merchant[] = [];
  companies: Company[] = [];
  instruments: Instrument[] = [];
  transactions: Transaction[] = [];
  reminders: Reminder[] = [];
  reminderMarkers: ReminderMarker[] = [];
  users: User[] = [];
  /**
   * Transactions the server reports as deleted. Kept apart from
   * `transactions`, which only ever holds live ones, so that a listing can
   * show them on request when reconciling a balance or an import.
   */
  private deletedTransactions = new Map<string, Transaction>();
  private synced = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** When the state last caught up with the server (Date.now()). */
  private lastSync = 0;
  private refreshing: Promise<void> | undefined;
  /** How old the state may get before a tool call syncs it first. */
  readonly syncTtlMs: number;

  constructor(api: ZenMoneyAPI, options: { syncTtlMs?: number } = {}) {
    this.api = api;
    this.syncTtlMs = options.syncTtlMs ?? defaultSyncTtlMs();
  }

  get isSynced(): boolean {
    return this.synced;
  }

  /** Milliseconds since the state last caught up with the server. */
  get age(): number {
    return Date.now() - this.lastSync;
  }

  /**
   * Sync incrementally unless the last sync is younger than syncTtlMs, so
   * that a long-running server does not answer from a stale cache. Calls
   * that arrive while a sync is running wait for it instead of starting
   * another.
   */
  async ensureFresh(signal?: AbortSignal): Promise<void> {
    if (this.synced && this.age < this.syncTtlMs) return;
    this.refreshing ??= this.sync(false, signal)
      .then(() => undefined)
      .finally(() => {
        this.refreshing = undefined;
      });
    await this.refreshing;
  }

  async sync(forceFull = false, signal?: AbortSignal): Promise<DiffResponse> {
    const resp = await this.serialize(async () => {
      const timestamp = forceFull ? 0 : this.serverTimestamp;

      const req: any = {
        currentClientTimestamp: Math.floor(Date.now() / 1000),
        serverTimestamp: timestamp,
      };

      if (timestamp === 0) {
        req.forceFetch = [
          "instrument",
          "company",
          "account",
          "tag",
          "merchant",
          "transaction",
          "reminder",
          "reminderMarker",
          "user",
        ];
      }

      const resp = signal
        ? await this.api.diff(req, { signal })
        : await this.api.diff(req);
      if (forceFull) this.clear();
      this.applyDiff(resp);
      this.lastSync = Date.now();
      return resp;
    });
    this.synced = true;
    return resp;
  }

  /**
   * Send local changes and apply the server's response. Once the server has
   * accepted the request, the sent deletions are applied locally and
   * `beforeApply` runs; only then is the response merged, so a version of
   * the same object in the response wins.
   *
   * Pass `changes` as a function when they are derived from local state: it
   * runs when this write's turn comes, after the exchanges queued before it
   * have been applied. A throw from it rejects the write without sending.
   *
   * A dropped connection or a 5xx is retried with the same body, which is
   * safe because every object carries its own id. If the outcome stays
   * unknown, the error names the ids so the caller can check them instead
   * of writing again under new ids.
   */
  write(
    changes: WriteChanges | (() => WriteChanges),
    beforeApply?: () => void
  ): Promise<DiffResponse> {
    return this.serialize(async () => {
      const sent = typeof changes === "function" ? changes() : changes;
      let resp: DiffResponse;
      try {
        resp = await this.api.diff({
          currentClientTimestamp: Math.floor(Date.now() / 1000),
          serverTimestamp: this.serverTimestamp,
          ...sent,
        });
      } catch (error) {
        if (error instanceof ZenMoneyError && error.uncertain) {
          throw new ZenMoneyError(uncertainWriteMessage(sent, error), true);
        }
        throw error;
      }
      for (const d of sent.deletion ?? []) this.applyDeletion(d.object, d.id);
      beforeApply?.();
      this.applyDiff(resp);
      // The response carries everything that changed since the cursor
      this.lastSync = Date.now();
      return resp;
    });
  }

  /**
   * Run /v8/diff/ exchanges one at a time, in call order. Each request
   * carries serverTimestamp and each response moves it; with two in flight
   * (MCP clients do call tools in parallel) the older response could land
   * last, move serverTimestamp back and overwrite newer data with older.
   */
  private serialize<T>(exchange: () => Promise<T>): Promise<T> {
    const result = this.queue.then(exchange);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /**
   * A full sync returns the complete current state, so it replaces what we
   * hold instead of being merged into it: merging would keep accounts,
   * categories and transactions the server no longer has. Called only once
   * the response is in, so a failed request leaves the old state intact.
   */
  private clear(): void {
    this.accounts = [];
    this.tags = [];
    this.merchants = [];
    this.companies = [];
    this.instruments = [];
    this.transactions = [];
    this.reminders = [];
    this.reminderMarkers = [];
    this.deletedTransactions.clear();
    this.users = [];
  }

  /**
   * Fold a /v8/diff/ response into local state. Writes go through this too:
   * the response to a write carries everything that changed on the server
   * since serverTimestamp (recomputed balances, edits from other devices),
   * and moving serverTimestamp forward without applying it would hide those
   * changes from every later incremental sync.
   */
  private applyDiff(resp: DiffResponse): void {
    this.mergeEntities("instruments", resp.instrument, (e) => e.id);
    this.mergeEntities("accounts", resp.account, (e) => e.id);
    this.mergeEntities("tags", resp.tag, (e) => e.id);
    this.mergeEntities("merchants", resp.merchant, (e) => e.id);
    this.mergeEntities("companies", resp.company, (e) => e.id);
    this.mergeEntities("users", resp.user, (e) => e.id);
    this.mergeTransactions(resp.transaction);
    this.mergeEntities("reminders", resp.reminder, (e) => e.id);
    this.mergeEntities("reminderMarkers", resp.reminderMarker, (e) => e.id);

    if (resp.deletion) {
      for (const del of resp.deletion) {
        this.applyDeletion(del.object, del.id);
      }
    }
    // Last, so that a failure above cannot move the cursor past changes
    // that were never applied
    this.serverTimestamp = resp.serverTimestamp;
  }

  private mergeEntities<T>(
    field: keyof this,
    incoming: T[],
    getId: (e: T) => string | number
  ): void {
    if (!incoming || incoming.length === 0) return;

    const arr = this[field] as T[];
    const map = new Map<string | number, T>();
    for (const item of arr) {
      map.set(getId(item), item);
    }
    for (const item of incoming) {
      map.set(getId(item), item);
    }
    (this[field] as T[]) = Array.from(map.values());
  }

  private mergeTransactions(incoming: Transaction[]): void {
    if (!incoming || incoming.length === 0) return;

    const map = new Map<string, Transaction>();
    for (const t of this.transactions) {
      map.set(t.id, t);
    }
    for (const t of incoming) {
      if (t.deleted) {
        map.delete(t.id);
        this.deletedTransactions.set(t.id, t);
      } else {
        map.set(t.id, t);
        this.deletedTransactions.delete(t.id);
      }
    }
    this.transactions = Array.from(map.values());
  }

  private applyDeletion(objectType: string, id: string): void {
    switch (objectType) {
      case "transaction": {
        const gone = this.transactions.find((t) => t.id === id);
        if (gone) this.deletedTransactions.set(id, { ...gone, deleted: true });
        this.transactions = this.transactions.filter((t) => t.id !== id);
        break;
      }
      case "reminder":
        this.reminders = this.reminders.filter((r) => r.id !== id);
        break;
      case "reminderMarker":
        this.reminderMarkers = this.reminderMarkers.filter((m) => m.id !== id);
        break;
      case "account":
        this.accounts = this.accounts.filter((a) => a.id !== id);
        break;
      case "tag":
        this.tags = this.tags.filter((t) => t.id !== id);
        break;
      case "merchant":
        this.merchants = this.merchants.filter((m) => m.id !== id);
        break;
    }
  }

  getDeletedTransactions(): Transaction[] {
    return Array.from(this.deletedTransactions.values());
  }

  /** Accounts a person keeps money on, without zerro's service account. */
  getVisibleAccounts(): Account[] {
    return this.accounts.filter((a) => a.title !== ZERRO_DATA_ACCOUNT);
  }

  getActiveAccounts(): Account[] {
    return this.getVisibleAccounts().filter((a) => !a.archive);
  }

  getInstrument(id: number): Instrument | undefined {
    return this.instruments.find((i) => i.id === id);
  }

  getCompany(id: number): Company | undefined {
    return this.companies.find((c) => c.id === id);
  }

  getUser(): User | undefined {
    return this.users.find((u) => u.parent === null) ?? this.users[0];
  }

  findTransaction(id: string): Transaction | undefined {
    return this.transactions.find((t) => t.id === id);
  }

  findDeletedTransaction(id: string): Transaction | undefined {
    return this.deletedTransactions.get(id);
  }

  /** Store a transaction we sent; a deleted one moves out of the live list. */
  upsertTransaction(tx: Transaction): void {
    if (tx.deleted) {
      this.transactions = this.transactions.filter((t) => t.id !== tx.id);
      this.deletedTransactions.set(tx.id, tx);
      return;
    }
    this.deletedTransactions.delete(tx.id);
    const idx = this.transactions.findIndex((t) => t.id === tx.id);
    if (idx >= 0) {
      this.transactions[idx] = tx;
    } else {
      this.transactions.push(tx);
    }
  }

  upsertReminder(reminder: Reminder): void {
    this.mergeEntities("reminders", [reminder], (r) => r.id);
  }

  upsertReminderMarkers(markers: ReminderMarker[]): void {
    this.mergeEntities("reminderMarkers", markers, (m) => m.id);
  }

  getTagHierarchy(): { parent: Tag; children: Tag[] }[] {
    const parentTags = this.tags.filter((t) => !t.parent);
    return parentTags.map((parent) => ({
      parent,
      children: this.tags.filter((t) => t.parent === parent.id),
    }));
  }
}

/**
 * zerro (zerro.app) keeps its settings in reminders on an account of this
 * name; it holds no money and is no place to record an operation.
 */
export const ZERRO_DATA_ACCOUNT = "🤖 [Zerro Data]";

function defaultSyncTtlMs(): number {
  const raw = process.env.ZENMONEY_SYNC_TTL?.trim();
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 30_000;
}

function uncertainWriteMessage(sent: WriteChanges, cause: Error): string {
  const ids = [
    ...(sent.transaction ?? []).map((t) => t.id),
    ...(sent.reminder ?? []).map((r) => r.id),
    ...(sent.reminderMarker ?? []).map((m) => m.id),
    ...(sent.deletion ?? []).map((d) => d.id),
  ];
  return (
    `ZenMoney did not confirm the change (${cause.message}), so it may or may not have been saved. ` +
    `Affected id${ids.length > 1 ? "s" : ""}: ${ids.join(", ")}. ` +
    "Do not repeat the call, which would write it again under a new id: run sync_data, then look the id up with " +
    (sent.reminder || sent.reminderMarker || sent.deletion?.some((d) => d.object === "reminder" || d.object === "reminderMarker")
      ? "list_reminders (include_finished=true) and list_upcoming."
      : "list_transactions.")
  );
}
