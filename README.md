# zenmoney-mcp

MCP server for [ZenMoney](https://zenmoney.ru) — access your personal finance data from any MCP-compatible AI client (Claude Desktop, Cursor, etc.).

Fork of [artarasov/zenmoney-mcp](https://github.com/artarasov/zenmoney-mcp). Branch `oviron` is upstream `main` plus the `patch/*` branches below, each sent upstream as its own pull request. See [What this fork changes](#what-this-fork-changes). Quick start below installs upstream from npm; to run this fork, see [Running this fork](#running-this-fork).

## Features

| Tool | Description |
|------|-------------|
| `sync_data` | Refresh data now; other tools sync on their own when it is older than `ZENMONEY_SYNC_TTL` |
| `list_accounts` | List wallets, cards, and cash accounts |
| `list_categories` | List expense/income categories with hierarchy |
| `add_category` | Create a category, optionally under a top-level parent; visibility defaults to true, budget flags to false |
| `update_category` | Change title, parent, visibility, budget flags or color; `parent: null` makes a category top-level |
| `add_account` | Create a `cash`, `ccard` or `checking` account with an initial balance; currency defaults to the user's currency |
| `update_account` | Change title, archive status, inclusion in the total balance, savings or card credit limit; adjust balances with a correction transaction |
| `list_merchants` | List known merchants/payees |
| `list_transactions` | List and filter recent transactions |
| `add_expense` | Add an expense; `category` accepts a name/UUID or an array; `original_amount` + `original_currency` record a foreign-currency purchase; `payee` links an exact merchant name; optional UUID `id` prevents duplicate retries |
| `add_income` | Add income with the same category, original-currency, merchant and UUID `id` options as `add_expense` |
| `add_transfer` | Transfer between ordinary accounts, including cross-currency; use `add_debt` for debt accounts; `amount` aliases `outcome_amount` (must match if both are given); optional UUID `id` prevents duplicate retries |
| `add_debt` | Record `lend`, `borrow`, `repay_received` or `repay_sent`; requires `counterparty` and an ordinary, non-archived `account`; both sides use that account's currency; optional UUID `id` prevents duplicate retries |
| `list_debts` | Balances by counterparty and currency, without conversion; filter by `counterparty`; `include_settled` defaults to false |
| `update_transaction` | Change category, amounts, date, payee, comment or accounts; a change of account currency requires a new amount for that side and clears its original amount/currency; existing debts accept metadata edits and equal amounts, but their accounts cannot be changed here |
| `delete_transaction` | Delete one or more transactions by id, as the ZenMoney apps do (requires `confirm: true`) |
| `restore_transaction` | Bring deleted transactions back as copies with new ids |
| `list_reminders` | List recurring and one-off plans with schedules and next planned dates; filter by account/category; `include_finished` shows ended series |
| `list_upcoming` | List planned operations for the next `days` calendar days, including today, sorted by date |
| `add_reminder` | Plan an expense, income or transfer and create its dated markers through `end_date`, or for one year from `start_date` |
| `delete_reminder` | Delete a series and its planned markers dated today or later (requires `confirm: true`) |
| `summarize_transactions` | Totals by category, payee, account or month in the main currency |
| `get_budget` | A month's budget against actual expenses and income, by category |
| `set_budget` | Set or remove a month's planned expenses or income for a category or in total |
| `suggest_category` | Get auto-suggested category for a payee |

## What this fork changes

Each item is one `patch/*` branch off upstream `main`.

- `delete-transaction`: new `delete_transaction` tool. Takes one id or a list, needs `confirm: true`, and sends nothing if any id is unknown. Deletion marks the transaction deleted, the way the ZenMoney apps do. ZenMoney ignores attempts to un-delete, so `restore_transaction` brings a deleted one back as a copy with a new id and skips one that is already back.
- `strict-names`: account and category names resolve by id, then exact title, then a unique substring. A name that still matches several entities is an error listing the candidates, and an active account wins over an archived one with the same title. Unknown categories and unknown `list_transactions` filters are errors instead of being dropped.
- `apply-write-response`: writes apply the server's response (recomputed balances, changes from other devices) instead of only taking its `serverTimestamp`, which hid those changes until a full sync. Confirmations describe what the server kept and warn when it kept a different version.
- `serialize-diff` (on top of `apply-write-response`): `/v8/diff/` requests run one at a time, so a slower response can't move `serverTimestamp` back when a client calls tools in parallel, and two parallel edits of one transaction don't undo each other.
- `full-sync-replace`: `sync_data` with `force_full` replaces local state instead of merging into it, so entities removed on the server disappear.
- `list-date-bounds`: `days` counts local calendar days and stops at today, so future-dated transactions no longer show up as recent.
- `list-order`: listing is sorted by date, then creation time, and says "N of M" when `limit` cut it.
- `list-provenance`: `[HOLD]` marks unsettled card authorizations; `show_provenance` adds creation time and bank import ids, which tell a re-imported duplicate from a real second operation.
- `show-deleted`: `show_deleted` includes transactions deleted on the server, marked `[DELETED]`.
- `validate-dates`: every date parameter must be a real `YYYY-MM-DD` date; `2026-02-30` used to pass.
- `transfer-same-account`: a transfer to the account it comes from is rejected.
- `transfer-amounts`: a transfer whose two sides differ (currency exchange) shows both amounts.

## Planned operations

`add_reminder` takes `type` (`expense`, `income` or `transfer`), `start_date`, and
the operation's accounts and amounts. Expenses and income use `account` and
`amount`. Transfers use `from_account`, `to_account`, `outcome_amount` (or `amount`)
and `income_amount`; both amounts are required across currencies. All three types
accept `category`, `payee`, `comment` and `notify` (default `false`).

Omit `interval`, or pass `null`, for a one-off plan. For a series, use `day`,
`week`, `month` or `year`, with `step` (default `1`) and `points` (default `[0]`).
As in the [ZenMoney API](https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API#reminder),
points are zero-based offsets in interval units inside a step window, each less
than `step`. For example, `interval: "day", step: 7, points: [0, 2, 4]` fires on
the starting day and two/four days later, every seven days. Points are not weekday
numbers or days of the month. For monthly payments on the 31st, set `start_date`
to a 31st and use `interval: "month", points: [0]`. A short month uses its last
day; January 31 becomes February 28 (29 in leap years), then March 31.

The client creates the dated markers. With `end_date`, it writes all dates through
that day inclusive, in batches of 500. Without it, it writes through one calendar
year from `start_date`, inclusive. This horizon is not extended automatically.
`list_reminders` shows the next five planned dates and the last materialized date;
`list_upcoming` shows stored planned markers over `days` calendar days including
today (default `7`). Neither listing generates more markers.

`delete_reminder` takes a series `id`. Without `confirm: true`, it previews the
deletion. With confirmation, it sends `deletion` records for future planned
markers (including today) and the series, in batches. It sends no changes for
processed markers or transactions. The local cache retains past planned and
processed markers unless ZenMoney returns their deletion; a series deletion can
also remove markers on the server. That cascade has not been checked against the
live API in this fork.

Multiple batches are not atomic. If creation or deletion stops partway through,
the tool reports the series id and confirmed progress. Do not repeat
`add_reminder` after a partial or uncertain result: run `sync_data`, then inspect
`list_reminders` with `include_finished: true` and `list_upcoming` before making
further changes. Upcoming listings cover future dates only.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `ZENMONEY_TOKEN` | — | API token, required |
| `ZENMONEY_SYNC_TTL` | `30` | Seconds the cached data stays fresh; a tool call after that syncs first. `0` syncs before every call |
| `ZENMONEY_TIMEOUT_MS` | `30000` | How long one API request may take |
| `ZENMONEY_READ_ONLY` | off | `true`, `1` or `yes` registers only the tools that read, for clients that must not change anything |

## Prerequisites

- Node.js >= 20
- A [ZenMoney](https://zenmoney.ru) account
- API token from [zerro.app/token](https://zerro.app/token)

## Quick start

No cloning or building needed — just add to your MCP client config:

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "zenmoney": {
      "command": "npx",
      "args": ["-y", "zenmoney-mcp"],
      "env": {
        "ZENMONEY_TOKEN": "your_token_here"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "zenmoney": {
      "command": "npx",
      "args": ["-y", "zenmoney-mcp"],
      "env": {
        "ZENMONEY_TOKEN": "your_token_here"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add zenmoney -- npx -y zenmoney-mcp
```

Replace `your_token_here` with your token from [zerro.app/token](https://zerro.app/token).

### Claude Desktop (MCPB bundle)

If you prefer a one-click install without editing JSON, build a `.mcpb` bundle and drag it into Claude Desktop → Settings → Extensions:

```bash
npm install
npm run pack:mcpb
# → dist/zenmoney-mcp-<version>.mcpb
```

On install, Claude Desktop will prompt for your ZenMoney token (stored in the OS keychain).

### From source

```bash
git clone https://github.com/artarasov/zenmoney-mcp.git
cd zenmoney-mcp
npm install
npm run build
cp .env.example .env  # add your token
```

## Usage

Once configured, start a conversation and ask your AI client to:

1. **Browse** — "Show me my accounts", "List my categories"
2. **Query** — "Show expenses for the last 7 days", "List transactions from January 1–31", "How much did I spend on groceries?"
3. **Add transactions** — "Add a 500 RUB expense for coffee today"
4. **Transfer** — "Transfer 1000 USD from Checking to Euro Card, received 920 EUR"
5. **Fix mistakes** — "Recategorize yesterday's Amazon expense to Household", "Change the comment on that 500 RUB coffee", "Delete the duplicate taxi ride from Monday"

`list_transactions` prints each transaction's id, and `update_transaction` and `delete_transaction` take one id or a list of them — so a whole batch can be recategorized or removed in a single call. ZenMoney does not un-delete transactions, so `restore_transaction` adds a deleted one back as a copy with a new id.

For `add_expense` and `add_income`, `amount` is in the account currency. Pass
`original_amount` and `original_currency` together to also record the original
foreign amount. The currency must match an instrument's `shortTitle` exactly,
ignoring case (for example, `USD`); unknown or ambiguous codes and the account's
own currency are errors. `payee` links a known merchant only when the full name
matches, ignoring case.

All four creation tools accept an optional UUID `id`. After an error saying
"may or may not have been saved", retry with the same `id` from the error and the
same parameters. A cached transaction with that id is shown without writing it
again, including if it was deleted. Omitting `id` generates a new UUID and is
appropriate only for a new operation.

When moving an operation to an account in another currency, pass the new amount
in that currency: `amount` for an expense/income, or `outcome_amount` and/or
`income_amount` for the changed transfer sides. To convert an expense to income
on the same account, pass `outcome_amount: 0` and `income_amount`; to convert income
to an expense, pass `income_amount: 0` and `outcome_amount`.

For debts, `add_debt` selects the system debt account automatically. Use the same
`counterparty` for a loan and its repayments. It is saved as `payee` and links a
known merchant on an exact name match, ignoring case. Both sides carry equal
amounts in the ordinary account currency, as required by the
[ZenMoney transaction protocol](https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API#transaction).
`list_debts` shows `owes you` or `you owe` for each counterparty and currency,
without conversion. Names come from the merchant title, then `payee`, then
`(unknown)`; names differing only in case share a balance. Its `counterparty`
filter matches a substring, ignoring case. `include_settled: true` shows zero
balances. Deleted operations are excluded.

`update_transaction` can edit a debt's category, date, comment or payee without
changing its amounts or currencies. For an amount change, pass `amount`,
`outcome_amount` or `income_amount`; both sides are normalized to that value in
the ordinary account currency. Two supplied side amounts must be equal and
positive. Account changes involving debt accounts are rejected; use `add_debt`
to record a new debt.

Category titles must be unique within the same parent, ignoring case. ZenMoney
supports two levels: a category with children cannot become a child. New
categories have no icon or picture, and `show_income` / `show_outcome` default to
true. `budget_income` / `budget_outcome` default to false so creation does not
automatically include a category in budget totals. The
[API v8 documentation](https://github.com/zenmoney/ZenPlugins/wiki/ZenMoney-API#tag)
defines these flags but does not specify defaults; its examples and our fixtures
enable them for the corresponding income or expense direction. Set them
explicitly when the category should participate in the budget.

`add_account` creates an independent account without bank sync, SMS import or
automatic balance corrections. `balance` defaults to 0 and also sets
`startBalance`; `in_balance` defaults to true and `savings` to false. `currency`
matches an instrument's `shortTitle` exactly, ignoring case. `credit_limit` must
be nonnegative and is accepted only for `ccard`. Account titles must be unique
among visible accounts, including archived ones. `update_account` preserves
type, currency and balances, and refuses to archive a debt account. Catalog write
confirmations show the saved values and warn when the server kept a different
version. After an uncertain write, run `sync_data` and find the reported id in
`list_categories` or `list_accounts` (`include_archived: true`) before retrying.

There are no category or account deletion tools: deletion can cascade into
transactions and budgets. Merchant editing is omitted because transaction
creation handles merchant links and title changes are rarely needed. Split
transactions are not supported by the local `Transaction` model, which has no
amount allocation fields.

## Running this fork

The fork is not published to npm; `npx -y zenmoney-mcp` installs upstream. Each
[release](https://github.com/oviron/zenmoney-mcp/releases) of this fork attaches a
package with bundled dependencies, which `npx` runs straight from its URL:

```json
{
  "mcpServers": {
    "zenmoney": {
      "command": "npx",
      "args": [
        "-y",
        "--allow-remote=all",
        "--package=https://github.com/oviron/zenmoney-mcp/releases/download/v0.4.1-oviron.1/zenmoney-mcp-0.4.1-oviron.1.tgz",
        "zenmoney-mcp"
      ],
      "env": { "ZENMONEY_TOKEN": "your_token_here" }
    }
  }
}
```

npm 12 refuses packages from a URL unless `--allow-remote=all` is set. The release notes
give the package's sha256. To run from source instead:

```bash
git clone --branch oviron https://github.com/oviron/zenmoney-mcp.git
cd zenmoney-mcp
npm install
npm run build
```

and point the client at it: `"command": "node", "args": ["/absolute/path/to/zenmoney-mcp/build/index.js"]`.

## Contributing

PRs welcome! Feel free to open issues for bugs or feature requests.

## License

[MIT](LICENSE)
