# zenmoney-mcp

MCP server for [ZenMoney](https://zenmoney.ru) — access your personal finance data from any MCP-compatible AI client (Claude Desktop, Cursor, etc.).

Fork of [artarasov/zenmoney-mcp](https://github.com/artarasov/zenmoney-mcp). Branch `oviron` is upstream `main` plus the `patch/*` branches below, each sent upstream as its own pull request. See [What this fork changes](#what-this-fork-changes). Quick start below installs upstream from npm; to run this fork, see [Running this fork](#running-this-fork).

## Features

| Tool | Description |
|------|-------------|
| `sync_data` | Refresh data now; other tools sync on their own when it is older than `ZENMONEY_SYNC_TTL` |
| `list_accounts` | List wallets, cards, and cash accounts |
| `list_categories` | List expense/income categories with hierarchy |
| `list_merchants` | List known merchants/payees |
| `list_transactions` | List and filter recent transactions |
| `add_expense` | Add an expense; `category` accepts a name/UUID or an array; `original_amount` + `original_currency` record a foreign-currency purchase; `payee` links an exact merchant name; optional UUID `id` prevents duplicate retries |
| `add_income` | Add income with the same category, original-currency, merchant and UUID `id` options as `add_expense` |
| `add_transfer` | Transfer between accounts, including cross-currency; `amount` aliases `outcome_amount` (must match if both are given); optional UUID `id` prevents duplicate retries |
| `update_transaction` | Change category, amounts, date, payee, comment or accounts; a change of account currency requires a new amount for that side and clears its original amount/currency; a single-account operation cannot have both income and outcome |
| `delete_transaction` | Delete one or more transactions by id (cannot be undone, requires `confirm: true`) |
| `summarize_transactions` | Totals by category, payee, account or month in the main currency |
| `suggest_category` | Get auto-suggested category for a payee |

## What this fork changes

Each item is one `patch/*` branch off upstream `main`.

- `delete-transaction`: new `delete_transaction` tool. Takes one id or a list, needs `confirm: true`, and sends nothing if any id is unknown. ZenMoney ignores attempts to un-delete, so a deleted operation comes back only as a new transaction.
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

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `ZENMONEY_TOKEN` | — | API token, required |
| `ZENMONEY_SYNC_TTL` | `30` | Seconds the cached data stays fresh; a tool call after that syncs first. `0` syncs before every call |
| `ZENMONEY_TIMEOUT_MS` | `30000` | How long one API request may take |

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

`list_transactions` prints each transaction's id, and `update_transaction` and `delete_transaction` take one id or a list of them — so a whole batch can be recategorized or removed in a single call. ZenMoney does not restore deleted transactions, so a deleted one can only be added back as a new transaction.

For `add_expense` and `add_income`, `amount` is in the account currency. Pass
`original_amount` and `original_currency` together to also record the original
foreign amount. The currency must match an instrument's `shortTitle` exactly,
ignoring case (for example, `USD`); unknown or ambiguous codes and the account's
own currency are errors. `payee` links a known merchant only when the full name
matches, ignoring case.

All three creation tools accept an optional UUID `id`. After an error saying
"may or may not have been saved", retry with the same `id` from the error and the
same parameters. A cached transaction with that id is shown without writing it
again, including if it was deleted. Omitting `id` generates a new UUID and is
appropriate only for a new operation.

When moving an operation to an account in another currency, pass the new amount
in that currency: `amount` for an expense/income, or `outcome_amount` and/or
`income_amount` for the changed transfer sides. To convert an expense to income
on the same account, pass `outcome_amount: 0` and `income_amount`; to convert income
to an expense, pass `income_amount: 0` and `outcome_amount`.

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
