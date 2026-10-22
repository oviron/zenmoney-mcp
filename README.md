# zenmoney-mcp

MCP server for [ZenMoney](https://zenmoney.ru) — access your personal finance data from any MCP-compatible AI client (Claude Desktop, Cursor, etc.).

Fork of [artarasov/zenmoney-mcp](https://github.com/artarasov/zenmoney-mcp). Branch `oviron` is upstream `main` plus the `patch/*` branches below, each sent upstream as its own pull request. See [What this fork changes](#what-this-fork-changes).

## Features

| Tool | Description |
|------|-------------|
| `sync_data` | Sync data with ZenMoney (run first) |
| `list_accounts` | List wallets, cards, and cash accounts |
| `list_categories` | List expense/income categories with hierarchy |
| `list_merchants` | List known merchants/payees |
| `list_transactions` | List and filter recent transactions |
| `add_expense` | Add an expense transaction |
| `add_income` | Add an income transaction |
| `add_transfer` | Transfer money between accounts (including cross-currency) |
| `update_transaction` | Change an existing transaction — category, amount, date, payee, comment, account |
| `delete_transaction` | Delete one or more transactions by id (cannot be undone, requires `confirm: true`) |
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

## Prerequisites

- Node.js >= 18
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

1. **Sync first** — "Sync my ZenMoney data"
2. **Browse** — "Show me my accounts", "List my categories"
3. **Query** — "Show expenses for the last 7 days", "List transactions from January 1–31", "How much did I spend on groceries?"
4. **Add transactions** — "Add a 500 RUB expense for coffee today"
5. **Transfer** — "Transfer 1000 USD from Checking to Euro Card, received 920 EUR"
6. **Fix mistakes** — "Recategorize yesterday's Amazon expense to Household", "Change the comment on that 500 RUB coffee", "Delete the duplicate taxi ride from Monday"

`list_transactions` prints each transaction's id, and `update_transaction` and `delete_transaction` take one id or a list of them — so a whole batch can be recategorized or removed in a single call. ZenMoney does not restore deleted transactions, so a deleted one can only be added back as a new transaction.

## Running this fork

The fork is not published to npm; `npx -y zenmoney-mcp` installs upstream. Build branch `oviron` (see [From source](#from-source)) and point the client at `build/index.js`:

```json
{
  "mcpServers": {
    "zenmoney": {
      "command": "node",
      "args": ["/absolute/path/to/zenmoney-mcp/build/index.js"],
      "env": { "ZENMONEY_TOKEN": "your_token_here" }
    }
  }
}
```

## Contributing

PRs welcome! Feel free to open issues for bugs or feature requests.

## License

[MIT](LICENSE)
